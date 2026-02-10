/**
 * eBay Marketplace Adapter
 *
 * Extracts structured data from eBay sold listings.
 * Implements the formal MarketplaceAdapter interface.
 *
 * @module extractors/ebay-adapter-v2
 */

import { JSDOM } from 'jsdom';
import { logger } from '../../utils/logger';
import {
  MarketplaceAdapter,
  MarketplaceListing,
  MarketplaceConfig,
  ExtractionOptions,
  ValidationResult,
  ProductCondition,
  AvailabilityStatus,
} from './marketplace-adapter';

export class EbayAdapterV2 implements MarketplaceAdapter {
  readonly marketplaceId = 'ebay' as const;
  readonly name = 'eBay Marketplace Adapter';
  readonly version = '2.1.0';

  /**
   * Check if URL is an eBay listing
   */
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('ebay.com') || parsed.hostname.includes('ebay.co.uk');
    } catch {
      return false;
    }
  }

  /**
   * Extract sold listing data from eBay page
   */
  async extract(
    html: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    logger.debug('eBay adapter extracting', { url });

    try {
      // Extract core fields
      const title = this.extractTitle(document);
      const { price, currency } = this.extractSoldPrice(document);
      const soldDate = this.extractSoldDate(document);
      const condition = this.extractCondition(document);
      const itemNumber = this.extractItemNumber(document, url);
      const shippingCost = this.extractShipping(document);
      const seller = this.extractSeller(document);
      const imageUrl = this.extractImage(document);

      // Determine availability status
      const availability: AvailabilityStatus = soldDate ? 'sold' : 'unknown';

      // Calculate confidence
      const confidence = this.calculateConfidence({
        hasTitle: !!title,
        hasPrice: price !== null,
        hasSoldDate: !!soldDate,
        hasCondition: !!condition,
        hasItemNumber: !!itemNumber,
      });

      // Build normalized listing
      const listing: MarketplaceListing = {
        id: itemNumber || this.generateIdFromUrl(url),
        marketplace: 'ebay',
        url,
        title,
        price: price !== null ? { amount: price, currency } : null,
        shippingCost: shippingCost !== null ? { amount: shippingCost, currency } : undefined,
        condition: this.mapCondition(condition),
        availability,
        soldDate: soldDate || undefined,
        seller: {
          name: seller.name,
          rating: seller.rating !== null ? seller.rating : undefined,
        },
        images: imageUrl ? [imageUrl] : [],
        itemNumber: itemNumber !== null ? itemNumber : undefined,
        extractedAt: new Date().toISOString(),
        extractionMethod: `${this.name} v${this.version}`,
        confidence,
        extractorVersion: this.version,
      };

      return listing;
    } catch (error) {
      logger.error('eBay extraction failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Validate extracted listing
   */
  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!listing.title || listing.title === 'Unknown Item') {
      errors.push('Missing or invalid title');
    }

    if (listing.price === null) {
      errors.push('Missing price information');
    }

    if (!listing.itemNumber) {
      warnings.push('Missing item number');
    }

    if (listing.availability === 'unknown') {
      warnings.push('Could not determine availability status');
    }

    // Confidence threshold
    if (listing.confidence < 0.5) {
      errors.push(`Low confidence score: ${listing.confidence}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Get adapter configuration
   */
  getConfig(): MarketplaceConfig {
    return {
      marketplaceId: 'ebay',
      enabled: true,
      rendering: {
        requiresJavaScript: false,
        waitForSelectors: [],
        waitTime: 0,
        blockResources: [],
      },
      rateLimit: {
        requestsPerSecond: 2,
        requestsPerMinute: 100,
        requestsPerHour: 5000,
        backoffStrategy: 'exponential',
        retryAttempts: 3,
      },
      session: {
        requireProxy: false,
        proxyRotation: 'none',
        cookiePersistence: true,
        userAgentRotation: false,
      },
      compliance: {
        respectRobotsTxt: true,
        crawlDelay: 500,
        userAgent: 'AnnoBot/1.0 (+https://anno.example.com/bot)',
        maxConcurrentRequests: 3,
      },
      quality: {
        minConfidenceScore: 0.7,
        requiredFields: ['title', 'price', 'url'],
      },
      features: {
        extractDescriptions: false,
        extractReviews: false,
        extractVariants: false,
        enableBackfill: true,
      },
    };
  }

  // =========================================================================
  // Private extraction methods (ported from original ebay-adapter)
  // =========================================================================

  private extractTitle(document: Document): string {
    const selectors = [
      'h1.x-item-title__mainTitle',
      '.x-item-title',
      'h1[itemprop="name"]',
      '.it-ttl',
      'h1',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element?.textContent?.trim()) {
        return element.textContent.trim();
      }
    }

    return 'Unknown Item';
  }

  private extractSoldPrice(document: Document): { price: number | null; currency: string } {
    const selectors = [
      '.x-price-primary span.ux-textspans',
      '.notranslate.x-price-primary',
      '[itemprop="price"]',
      '.vi-VR-cvipPrice',
      '.mm-saleDscPrc',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element?.textContent) {
        const parsed = this.parsePrice(element.textContent);
        if (parsed.price !== null) {
          return parsed;
        }
      }
    }

    // Check meta tags
    const priceMetaContent = document
      .querySelector('meta[itemprop="price"]')
      ?.getAttribute('content');
    if (priceMetaContent) {
      const parsed = this.parsePrice(priceMetaContent);
      if (parsed.price !== null) {
        return parsed;
      }
    }

    return { price: null, currency: 'USD' };
  }

  protected parsePrice(priceText: string): { price: number | null; currency: string } {
    const cleaned = priceText.trim();

    // Extract currency
    let currency = 'USD';
    if (cleaned.includes('$')) currency = 'USD';
    else if (cleaned.includes('£')) currency = 'GBP';
    else if (cleaned.includes('€')) currency = 'EUR';
    else if (cleaned.includes('US')) currency = 'USD';

    // Extract numeric value
    const numericMatch = cleaned.match(/[\d,]+\.?\d*/);
    if (numericMatch) {
      const numericString = numericMatch[0].replace(/,/g, '');
      const price = parseFloat(numericString);
      if (!isNaN(price)) {
        return { price, currency };
      }
    }

    return { price: null, currency };
  }

  private extractSoldDate(document: Document): string | null {
    const soldDateSelectors = [
      '.vi-bboxrev-postiontop',
      '.sold-date',
      '[data-testid="x-sold-date"]',
    ];

    for (const selector of soldDateSelectors) {
      const element = document.querySelector(selector);
      if (element?.textContent) {
        // Extract date from text like "Sold Oct 15, 2024"
        const dateMatch = element.textContent.match(/\w{3}\s+\d{1,2},\s+\d{4}/);
        if (dateMatch) {
          return dateMatch[0];
        }
      }
    }

    return null;
  }

  private extractCondition(document: Document): string | null {
    const conditionSelectors = [
      '[data-testid="x-item-condition-value"]',
      '.ux-labels-values__values-content',
      '.vi-acc-del-range',
    ];

    for (const selector of conditionSelectors) {
      const element = document.querySelector(selector);
      const text = element?.textContent?.trim();
      if (text && (text.includes('New') || text.includes('Used') || text.includes('Refurbished'))) {
        return text;
      }
    }

    return null;
  }

  private extractItemNumber(document: Document, url: string): string | null {
    // Try URL first
    const itemIdMatch = url.match(/\/itm\/(\d+)/);
    if (itemIdMatch) {
      return itemIdMatch[1];
    }

    // Check page elements
    const itemIdElement = document.querySelector('[data-testid="ux-item-number"]');
    if (itemIdElement?.textContent) {
      const match = itemIdElement.textContent.match(/\d+/);
      if (match) return match[0];
    }

    return null;
  }

  private extractShipping(document: Document): number | null {
    const shippingSelectors = ['.ux-labels-values--shipping', '.sh-del-cost'];

    for (const selector of shippingSelectors) {
      const element = document.querySelector(selector);
      if (element?.textContent) {
        const parsed = this.parsePrice(element.textContent);
        if (parsed.price !== null) {
          return parsed.price;
        }
      }
    }

    return null;
  }

  private extractSeller(document: Document): { name: string | null; rating: number | null } {
    const sellerName =
      document.querySelector('.x-sellercard-atf__info__about-seller a')?.textContent?.trim() ||
      null;

    const ratingElement = document.querySelector('.x-sellercard-atf__data--rating');
    let rating: number | null = null;
    if (ratingElement?.textContent) {
      const match = ratingElement.textContent.match(/[\d.]+/);
      if (match) {
        // Convert to 0-100 scale if needed
        const rawRating = parseFloat(match[0]);
        rating = rawRating <= 100 ? rawRating : (rawRating / 5) * 100; // Normalize 5-star to 100
      }
    }

    return { name: sellerName, rating };
  }

  private extractImage(document: Document): string | null {
    const imgElement = document.querySelector('.ux-image-carousel-item img') as HTMLImageElement;
    return imgElement?.src || null;
  }

  private calculateConfidence(indicators: {
    hasTitle: boolean;
    hasPrice: boolean;
    hasSoldDate: boolean;
    hasCondition: boolean;
    hasItemNumber: boolean;
  }): number {
    let confidence = 0;

    if (indicators.hasTitle) confidence += 0.2;
    if (indicators.hasPrice) confidence += 0.4; // Price is most important!
    if (indicators.hasSoldDate) confidence += 0.2;
    if (indicators.hasCondition) confidence += 0.1;
    if (indicators.hasItemNumber) confidence += 0.1;

    return confidence;
  }

  protected mapCondition(ebayCondition: string | null): ProductCondition {
    if (!ebayCondition) return 'unknown';

    const lower = ebayCondition.toLowerCase();
    if (lower.includes('new')) return 'new';
    if (lower.includes('refurbished')) return 'refurbished';
    if (lower.includes('like new')) return 'used_like_new';
    if (lower.includes('very good')) return 'used_very_good';
    if (lower.includes('good')) return 'used_good';
    if (lower.includes('acceptable')) return 'used_acceptable';
    if (lower.includes('used')) return 'used_good'; // Default used condition

    return 'unknown';
  }

  private generateIdFromUrl(url: string): string {
    // Fallback: generate ID from URL hash
    return url.split('/').pop()?.split('?')[0] || `ebay-${Date.now()}`;
  }
}

// Export singleton instance
export const ebayAdapterV2 = new EbayAdapterV2();
