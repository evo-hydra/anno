/**
 * Structured Data Enrichment
 *
 * Cross-validates marketplace adapter scraping results against JSON-LD
 * and Open Graph structured data. When both sources agree on key fields
 * (price, title, availability), confidence is boosted.
 *
 * This module provides the synergy layer between the structured metadata
 * extractor and the marketplace adapters.
 *
 * @module extractors/structured-data-enrichment
 */

import { structuredMetadataExtractor, type StructuredMetadata } from './structured-metadata-extractor';
import type { MarketplaceListing, MoneyAmount } from './marketplace-adapter';

export interface EnrichmentResult {
  /** Fields that were cross-validated by structured data */
  validatedFields: string[];
  /** Fields where structured data disagrees with scraped data */
  conflicts: Array<{ field: string; scraped: unknown; structured: unknown }>;
  /** Confidence adjustment: positive means boost, negative means penalty */
  confidenceAdjustment: number;
  /** Structured data source used (json-ld, open-graph, microdata) */
  source: string | null;
}

/**
 * Extract product data from JSON-LD if present.
 * Looks for Schema.org Product, Offer, or similar types.
 */
function extractProductFromJsonLd(jsonLd: Record<string, unknown>[]): {
  title?: string;
  price?: number;
  currency?: string;
  availability?: string;
  condition?: string;
  image?: string;
  seller?: string;
} | null {
  for (const item of jsonLd) {
    const type = (item['@type'] as string)?.toLowerCase?.() ?? '';

    if (type === 'product' || type === 'offer' || type === 'individualpurchase') {
      const result: ReturnType<typeof extractProductFromJsonLd> = {};

      // Title
      const name = item['name'] as string | undefined;
      if (name) result.title = name;

      // Price — could be on the item or nested in offers
      const offers = item['offers'] as Record<string, unknown> | Record<string, unknown>[] | undefined;
      if (offers) {
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (offer) {
          const price = offer['price'] ?? offer['lowPrice'];
          if (price !== undefined) {
            result.price = typeof price === 'number' ? price : parseFloat(String(price));
            result.currency = (offer['priceCurrency'] as string) ?? 'USD';
          }
          const avail = offer['availability'] as string | undefined;
          if (avail) result.availability = avail;
        }
      }

      // Direct price (some sites put it on the product)
      if (result.price === undefined && item['price'] !== undefined) {
        const p = item['price'];
        result.price = typeof p === 'number' ? p : parseFloat(String(p));
        result.currency = (item['priceCurrency'] as string) ?? 'USD';
      }

      // Condition
      const condition = item['itemCondition'] as string | undefined;
      if (condition) result.condition = condition;

      // Image
      const image = item['image'] as string | string[] | undefined;
      if (image) result.image = Array.isArray(image) ? image[0] : image;

      // Seller
      const seller = item['seller'] as Record<string, unknown> | undefined;
      if (seller?.name) result.seller = String(seller.name);

      return result;
    }

    // Recurse into @graph arrays
    if (item['@graph'] && Array.isArray(item['@graph'])) {
      const graphResult = extractProductFromJsonLd(item['@graph'] as Record<string, unknown>[]);
      if (graphResult) return graphResult;
    }
  }

  return null;
}

/**
 * Compare a scraped price against a structured data price.
 * Prices within 1% tolerance are considered matching (currency conversions, rounding).
 */
function pricesMatch(scraped: MoneyAmount | null, structured: number | undefined): boolean {
  if (!scraped || structured === undefined || isNaN(structured)) return false;
  const tolerance = Math.max(scraped.amount * 0.01, 0.01);
  return Math.abs(scraped.amount - structured) <= tolerance;
}

/**
 * Normalize a string for fuzzy comparison.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Cross-validate a marketplace listing against structured metadata from the same page.
 *
 * Usage in a marketplace adapter:
 * ```ts
 * const metadata = structuredMetadataExtractor.extract(document);
 * const enrichment = crossValidate(listing, metadata);
 * listing.confidence += enrichment.confidenceAdjustment;
 * ```
 */
export function crossValidate(
  listing: MarketplaceListing,
  metadata: StructuredMetadata
): EnrichmentResult {
  const validatedFields: string[] = [];
  const conflicts: EnrichmentResult['conflicts'] = [];
  let source: string | null = null;

  const product = extractProductFromJsonLd(metadata.jsonLd);

  if (product) {
    source = 'json-ld';

    // Cross-validate title
    if (product.title && listing.title) {
      const scrapedNorm = normalize(listing.title);
      const structuredNorm = normalize(product.title);
      // Substring match (structured data titles are often truncated or expanded)
      if (scrapedNorm.includes(structuredNorm) || structuredNorm.includes(scrapedNorm)) {
        validatedFields.push('title');
      } else {
        conflicts.push({ field: 'title', scraped: listing.title, structured: product.title });
      }
    }

    // Cross-validate price
    if (product.price !== undefined) {
      if (pricesMatch(listing.price, product.price)) {
        validatedFields.push('price');
      } else if (listing.price) {
        conflicts.push({ field: 'price', scraped: listing.price.amount, structured: product.price });
      }
    }

    // Cross-validate seller
    if (product.seller && listing.seller.name) {
      if (normalize(listing.seller.name) === normalize(product.seller)) {
        validatedFields.push('seller');
      }
    }
  }

  // Also check Open Graph for title cross-validation
  if (!source && metadata.openGraph['og:title'] && listing.title) {
    source = 'open-graph';
    const ogNorm = normalize(metadata.openGraph['og:title']);
    const titleNorm = normalize(listing.title);
    if (ogNorm.includes(titleNorm) || titleNorm.includes(ogNorm)) {
      validatedFields.push('title');
    }
  }

  // Calculate confidence adjustment
  // Each validated field boosts confidence, conflicts penalize
  const boost = validatedFields.length * 0.05; // +0.05 per validated field
  const penalty = conflicts.length * 0.03;     // -0.03 per conflict
  const confidenceAdjustment = Math.min(boost - penalty, 0.15); // Cap at +0.15

  return { validatedFields, conflicts, confidenceAdjustment, source };
}

/**
 * Extract structured metadata from a JSDOM Document and return
 * both the metadata and any product-level cross-validation data.
 * Convenience function for marketplace adapters that already have a Document.
 */
export function extractAndCrossValidate(
  document: Document,
  listing: MarketplaceListing
): { metadata: StructuredMetadata; enrichment: EnrichmentResult } {
  const metadata = structuredMetadataExtractor.extract(document);
  const enrichment = crossValidate(listing, metadata);
  return { metadata, enrichment };
}
