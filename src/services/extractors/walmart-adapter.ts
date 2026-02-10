/**
 * Walmart Marketplace Adapter
 *
 * Extracts structured data from Walmart product listings.
 * Requires JavaScript rendering for dynamic pricing and availability.
 *
 * @module extractors/walmart-adapter
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

export class WalmartAdapter implements MarketplaceAdapter {
  readonly marketplaceId = 'walmart' as const;
  readonly name = 'Walmart Marketplace Adapter';
  readonly version = '1.0.0';

  /**
   * Check if URL is a Walmart listing
   */
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('walmart.com');
    } catch {
      return false;
    }
  }

  /**
   * Extract product data from Walmart page
   */
  async extract(
    html: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    logger.debug('Walmart adapter extracting', { url });

    try {
      // Extract core fields
      const title = this.extractTitle(document);
      const { price, currency } = this.extractPrice(document);
      const availability = this.extractAvailability(document);
      const condition = this.extractCondition(document);
      const itemId = this.extractItemId(document, url);
      const seller = this.extractSeller(document);
      const images = this.extractImages(document, options);
      const category = this.extractCategory(document);

      // Calculate confidence
      const confidence = this.calculateConfidence({
        hasTitle: !!title,
        hasPrice: price !== null,
        hasAvailability: availability !== 'unknown',
        hasItemId: !!itemId,
      });

      // Build normalized listing
      const listing: MarketplaceListing = {
        id: itemId || this.generateIdFromUrl(url),
        marketplace: 'walmart',
        url,
        title,
        price: price !== null ? { amount: price, currency } : null,
        condition,
        availability,
        seller,
        images,
        itemNumber: itemId !== null ? itemId : undefined,
        category,
        extractedAt: new Date().toISOString(),
        extractionMethod: `${this.name} v${this.version}`,
        confidence,
        extractorVersion: this.version,
      };

      return listing;
    } catch (error) {
      logger.error('Walmart extraction failed', {
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
    if (!listing.title || listing.title === 'Unknown Product') {
      errors.push('Missing or invalid title');
    }

    if (listing.price === null) {
      warnings.push('Missing price information');
    }

    if (!listing.itemNumber) {
      errors.push('Missing item ID');
    }

    if (listing.availability === 'unknown') {
      warnings.push('Could not determine availability status');
    }

    // Confidence threshold
    if (listing.confidence < 0.65) {
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
      marketplaceId: 'walmart',
      enabled: false, // Not yet launched
      rendering: {
        requiresJavaScript: true,
        waitForSelectors: ['h1[itemprop="name"]', '[data-testid="price-wrap"]'],
        waitTime: 1500,
        blockResources: ['image', 'font'],
      },
      rateLimit: {
        requestsPerSecond: 1.5,
        requestsPerMinute: 60,
        requestsPerHour: 2000,
        backoffStrategy: 'exponential',
        retryAttempts: 4,
      },
      session: {
        requireProxy: false,
        proxyRotation: 'per_session',
        cookiePersistence: true,
        userAgentRotation: false,
        sessionDuration: 60,
      },
      compliance: {
        respectRobotsTxt: true,
        crawlDelay: 1000,
        userAgent: 'Mozilla/5.0 (compatible; AnnoBot/1.0)',
        maxConcurrentRequests: 2,
      },
      quality: {
        minConfidenceScore: 0.7,
        requiredFields: ['title', 'price', 'itemNumber'],
      },
      features: {
        extractDescriptions: false,
        extractReviews: false,
        extractVariants: false,
        enableBackfill: false,
      },
    };
  }

  // =========================================================================
  // Private extraction methods
  // =========================================================================

  private extractTitle(document: Document): string {
    const selectors = [
      'h1[itemprop="name"]',
      'h1.prod-ProductTitle',
      'h1[data-automation-id="product-title"]',
      'h1',
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element?.textContent?.trim()) {
        return element.textContent.trim();
      }
    }

    return 'Unknown Product';
  }

  private extractPrice(document: Document): { price: number | null; currency: string } {
    // Walmart price selectors (updated for 2024 site)
    const selectors = [
      '[itemprop="price"]',
      '[data-testid="price-wrap"] span',
      '.price-characteristic',
      'span[data-automation-id="product-price"]',
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

    // Check structured data
    const structuredData = document.querySelector('script[type="application/ld+json"]');
    if (structuredData?.textContent) {
      try {
        const data = JSON.parse(structuredData.textContent);
        if (data.offers?.price) {
          return {
            price: parseFloat(data.offers.price),
            currency: data.offers.priceCurrency || 'USD',
          };
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return { price: null, currency: 'USD' };
  }

  private parsePrice(priceText: string): { price: number | null; currency: string } {
    const cleaned = priceText.trim().replace(/\s+/g, ' ');

    // Currency detection
    let currency = 'USD';
    if (cleaned.includes('$')) currency = 'USD';
    else if (cleaned.includes('USD')) currency = 'USD';

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

  private extractAvailability(document: Document): AvailabilityStatus {
    // Check structured data first
    const structuredData = document.querySelector('script[type="application/ld+json"]');
    if (structuredData?.textContent) {
      try {
        const data = JSON.parse(structuredData.textContent);
        const availability = data.offers?.availability?.toLowerCase() || '';
        if (availability.includes('instock')) return 'in_stock';
        if (availability.includes('outofstock')) return 'out_of_stock';
      } catch {
        // Ignore
      }
    }

    // Check button text
    const addToCartButton = document.querySelector('[data-automation-id="add-to-cart-button"]');
    if (addToCartButton) {
      const buttonText = addToCartButton.textContent?.toLowerCase() || '';
      if (buttonText.includes('add to cart')) return 'in_stock';
      if (buttonText.includes('out of stock')) return 'out_of_stock';
    }

    // Check availability text
    const availabilityText = document.querySelector(
      '[data-testid="fulfillment-badge"], .prod-ProductOffer-fulfillment'
    );
    const text = availabilityText?.textContent?.toLowerCase() || '';
    if (text.includes('out of stock')) return 'out_of_stock';
    if (text.includes('in stock')) return 'in_stock';

    return 'unknown';
  }

  private extractCondition(document: Document): ProductCondition {
    // Most Walmart marketplace listings are new
    const conditionElement = document.querySelector('[data-testid="condition"]');
    const text = conditionElement?.textContent?.toLowerCase() || '';

    if (text.includes('new')) return 'new';
    if (text.includes('refurbished')) return 'refurbished';
    if (text.includes('pre-owned') || text.includes('used')) return 'used_good';

    // Default to new
    return 'new';
  }

  private extractItemId(document: Document, url: string): string | null {
    // Try URL first - Walmart uses item IDs in URLs
    const itemIdMatch = url.match(/\/(\d{8,})/);
    if (itemIdMatch) {
      return itemIdMatch[1];
    }

    // Check meta tags
    const productIdMeta = document.querySelector('meta[name="product.itemId"]');
    if (productIdMeta) {
      return productIdMeta.getAttribute('content');
    }

    // Check data attributes
    const productElement = document.querySelector('[data-item-id]');
    if (productElement) {
      return productElement.getAttribute('data-item-id');
    }

    return null;
  }

  private extractSeller(document: Document): {
    name: string | null;
    verified?: boolean;
  } {
    const sellerElement = document.querySelector(
      '[data-testid="seller-name"], .seller-name, [itemprop="brand"]'
    );
    const sellerName = sellerElement?.textContent?.trim() || null;

    // Check if sold by Walmart
    const isWalmart = sellerName?.toLowerCase().includes('walmart');

    return {
      name: sellerName,
      verified: isWalmart,
    };
  }

  private extractImages(document: Document, options?: ExtractionOptions): string[] {
    if (options?.extractImages === false) {
      return [];
    }

    const images: string[] = [];

    // Main product image
    const mainImage = document.querySelector(
      'img[data-testid="hero-image-container"], img.hover-zoom-hero-image'
    ) as HTMLImageElement;
    if (mainImage?.src) {
      images.push(mainImage.src);
    }

    // Thumbnail images
    const thumbnails = document.querySelectorAll('.thumbnail-image img');
    thumbnails.forEach((img) => {
      const src = (img as HTMLImageElement).src;
      if (src && !images.includes(src)) {
        images.push(src);
      }
    });

    return images;
  }

  private extractCategory(document: Document): string[] | undefined {
    const breadcrumbs = document.querySelectorAll('[data-testid="breadcrumb"] a, .breadcrumb a');
    if (breadcrumbs.length === 0) return undefined;

    const category: string[] = [];
    breadcrumbs.forEach((crumb) => {
      const text = crumb.textContent?.trim();
      if (text && text.toLowerCase() !== 'home') {
        category.push(text);
      }
    });

    return category.length > 0 ? category : undefined;
  }

  private calculateConfidence(indicators: {
    hasTitle: boolean;
    hasPrice: boolean;
    hasAvailability: boolean;
    hasItemId: boolean;
  }): number {
    let confidence = 0;

    if (indicators.hasTitle) confidence += 0.3;
    if (indicators.hasPrice) confidence += 0.35;
    if (indicators.hasAvailability) confidence += 0.15;
    if (indicators.hasItemId) confidence += 0.2;

    return confidence;
  }

  private generateIdFromUrl(url: string): string {
    return url.split('/').pop()?.split('?')[0] || `walmart-${Date.now()}`;
  }
}

// Export singleton instance
export const walmartAdapter = new WalmartAdapter();
