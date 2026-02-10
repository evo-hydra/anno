/**
 * eBay Site-Specific Adapter
 *
 * Extracts structured data from eBay sold listings.
 * Perfect for price research and market analysis.
 *
 * Implements DataSourceAdapter for multi-channel architecture.
 *
 * @module extractors/ebay-adapter
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */

import { JSDOM } from 'jsdom';
import { logger } from '../../utils/logger';
import {
  DataSourceAdapter,
  DataSourceChannel,
  DataSourceTier,
  DataSourceHealth,
  DataProvenance,
  MarketplaceListing,
  MarketplaceListingWithProvenance,
  MarketplaceConfig,
  ExtractionOptions,
  ValidationResult,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';

export interface EbaySoldListing {
  title: string;
  soldPrice: number | null;
  currency: string;
  soldDate: string | null;
  condition: string | null;
  itemNumber: string | null;
  shippingCost: number | null;
  seller: {
    name: string | null;
    rating: number | null;
  };
  imageUrl: string | null;
  url: string;
  extractionMethod: 'ebay-adapter';
  confidence: number;
}

export class EbayAdapter implements DataSourceAdapter {
  // =========================================================================
  // DataSourceAdapter Required Properties
  // =========================================================================

  readonly marketplaceId = 'ebay' as const;
  readonly name = 'eBay Scraping Adapter';
  readonly version = '2.0.0';

  readonly channel: DataSourceChannel = 'scraping';
  readonly tier: DataSourceTier = 3;
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.scraping;
  readonly requiresUserAction = false;

  // Track health metrics
  private lastSuccessfulExtraction?: string;
  private recentExtractions: { success: boolean; timestamp: number }[] = [];

  // =========================================================================
  // MarketplaceAdapter Interface Methods
  // =========================================================================

  /**
   * Check if URL belongs to eBay (implements MarketplaceAdapter.canHandle)
   */
  canHandle(url: string): boolean {
    return this.isEbayListing(url);
  }

  /**
   * Check if URL is an eBay listing (legacy method, kept for backward compatibility)
   */
  isEbayListing(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('ebay.com') || parsed.hostname.includes('ebay.co.uk');
    } catch {
      return false;
    }
  }

  /**
   * Extract sold listing data from eBay page (legacy format)
   * @deprecated Use extractWithProvenance() for new code
   */
  extractLegacy(html: string, url: string): EbaySoldListing {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    logger.debug('eBay adapter extracting', { url });

    // Extract title
    const title = this.extractTitle(document);

    // Extract sold price (the most important!)
    const { price, currency } = this.extractSoldPrice(document);

    // Extract sold date
    const soldDate = this.extractSoldDate(document);

    // Extract condition
    const condition = this.extractCondition(document);

    // Extract item number
    const itemNumber = this.extractItemNumber(document);

    // Extract shipping
    const shippingCost = this.extractShipping(document);

    // Extract seller info
    const seller = this.extractSeller(document);

    // Extract image
    const imageUrl = this.extractImage(document);

    // Calculate confidence
    const confidence = this.calculateConfidence({
      hasTitle: !!title,
      hasPrice: price !== null,
      hasSoldDate: !!soldDate,
      hasCondition: !!condition,
      hasItemNumber: !!itemNumber
    });

    return {
      title,
      soldPrice: price,
      currency,
      soldDate,
      condition,
      itemNumber,
      shippingCost,
      seller,
      imageUrl,
      url,
      extractionMethod: 'ebay-adapter',
      confidence
    };
  }

  /**
   * Extract item title
   */
  private extractTitle(document: Document): string {
    // Try multiple selectors
    const selectors = [
      'h1.x-item-title__mainTitle',
      '.x-item-title',
      'h1[itemprop="name"]',
      '.it-ttl',
      'h1'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element?.textContent?.trim()) {
        return element.textContent.trim();
      }
    }

    return 'Unknown Item';
  }

  /**
   * Extract sold price (CRITICAL for your use case!)
   */
  private extractSoldPrice(document: Document): { price: number | null; currency: string } {
    // eBay sold prices are usually in specific elements
    const selectors = [
      '.x-price-primary span.ux-textspans',
      '.notranslate.x-price-primary',
      '[itemprop="price"]',
      '.vi-VR-cvipPrice',
      '.mm-saleDscPrc'
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

    // Also check meta tags
    const priceMetaContent = document.querySelector('meta[itemprop="price"]')?.getAttribute('content');
    if (priceMetaContent) {
      const parsed = this.parsePrice(priceMetaContent);
      if (parsed.price !== null) {
        return parsed;
      }
    }

    return { price: null, currency: 'USD' };
  }

  /**
   * Parse price string into number and currency
   */
  private parsePrice(priceText: string): { price: number | null; currency: string } {
    // Remove whitespace
    const cleaned = priceText.trim();

    // Extract currency symbol
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

  /**
   * Extract sold date
   */
  private extractSoldDate(document: Document): string | null {
    // Look for sold date indicators
    const soldDateSelectors = [
      '.vi-bboxrev-postiontop',
      '.sold-date',
      '[data-testid="x-sold-date"]'
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

  /**
   * Extract condition
   */
  private extractCondition(document: Document): string | null {
    const conditionSelectors = [
      '[data-testid="x-item-condition-value"]',
      '.ux-labels-values__values-content',
      '.vi-acc-del-range'
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

  /**
   * Extract item number
   */
  private extractItemNumber(document: Document): string | null {
    // Look in URL or page
    const itemIdMatch = document.URL.match(/\/itm\/(\d+)/);
    if (itemIdMatch) {
      return itemIdMatch[1];
    }

    // Also check meta tags
    const itemIdElement = document.querySelector('[data-testid="ux-item-number"]');
    if (itemIdElement?.textContent) {
      const match = itemIdElement.textContent.match(/\d+/);
      if (match) return match[0];
    }

    return null;
  }

  /**
   * Extract shipping cost
   */
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

  /**
   * Extract seller information
   */
  private extractSeller(document: Document): { name: string | null; rating: number | null } {
    const sellerName =
      document.querySelector('.x-sellercard-atf__info__about-seller a')?.textContent?.trim() || null;

    const ratingElement = document.querySelector('.x-sellercard-atf__data--rating');
    let rating: number | null = null;
    if (ratingElement?.textContent) {
      const match = ratingElement.textContent.match(/[\d.]+/);
      if (match) {
        rating = parseFloat(match[0]);
      }
    }

    return { name: sellerName, rating };
  }

  /**
   * Extract main image
   */
  private extractImage(document: Document): string | null {
    const imgElement = document.querySelector('.ux-image-carousel-item img') as HTMLImageElement;
    return imgElement?.src || null;
  }

  /**
   * Calculate extraction confidence
   */
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

  // =========================================================================
  // DataSourceAdapter Interface Methods
  // =========================================================================

  /**
   * Extract (implements MarketplaceAdapter.extract)
   * Returns normalized MarketplaceListing format
   */
  async extract(
    content: string,
    url: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    try {
      const legacy = this.extractLegacy(content, url);

      return {
        id: legacy.itemNumber || `ebay-${Date.now()}`,
        marketplace: 'ebay',
        url: legacy.url,
        title: legacy.title,
        price: legacy.soldPrice !== null
          ? { amount: legacy.soldPrice, currency: legacy.currency }
          : null,
        shippingCost: legacy.shippingCost !== null
          ? { amount: legacy.shippingCost, currency: legacy.currency }
          : undefined,
        condition: this.mapCondition(legacy.condition),
        availability: 'sold',
        soldDate: legacy.soldDate || undefined,
        seller: {
          name: legacy.seller.name,
          rating: legacy.seller.rating !== null ? legacy.seller.rating * 10 : undefined,
        },
        images: legacy.imageUrl ? [legacy.imageUrl] : [],
        itemNumber: legacy.itemNumber || undefined,
        extractedAt: new Date().toISOString(),
        extractionMethod: `${this.name} v${this.version}`,
        confidence: legacy.confidence,
        extractorVersion: this.version,
      };
    } catch (error) {
      logger.error('eBay extraction failed', { url, error });
      return null;
    }
  }

  /**
   * Extract with full provenance tracking (implements DataSourceAdapter)
   */
  async extractWithProvenance(
    content: string,
    url: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null> {
    try {
      // Use existing extractLegacy method
      const legacy = this.extractLegacy(content, url);

      // Track successful extraction
      this.lastSuccessfulExtraction = new Date().toISOString();
      this.trackExtraction(true);

      // Convert to MarketplaceListing format
      const listing: MarketplaceListing = {
        id: legacy.itemNumber || `ebay-${Date.now()}`,
        marketplace: 'ebay',
        url: legacy.url,
        title: legacy.title,
        price: legacy.soldPrice !== null
          ? { amount: legacy.soldPrice, currency: legacy.currency }
          : null,
        shippingCost: legacy.shippingCost !== null
          ? { amount: legacy.shippingCost, currency: legacy.currency }
          : undefined,
        condition: this.mapCondition(legacy.condition),
        availability: 'sold',
        soldDate: legacy.soldDate || undefined,
        seller: {
          name: legacy.seller.name,
          rating: legacy.seller.rating !== null ? legacy.seller.rating * 10 : undefined, // Normalize to 0-100
        },
        images: legacy.imageUrl ? [legacy.imageUrl] : [],
        itemNumber: legacy.itemNumber || undefined,
        extractedAt: new Date().toISOString(),
        extractionMethod: `${this.name} v${this.version}`,
        confidence: legacy.confidence,
        extractorVersion: this.version,
      };

      // Build provenance
      const provenance: DataProvenance = {
        channel: this.channel,
        tier: this.tier,
        confidence: legacy.confidence,
        freshness: 'realtime',
        sourceId: `${this.name}/${this.version}`,
        extractedAt: listing.extractedAt,
        userConsented: true, // Scraping public data
        termsCompliant: true, // eBay allows limited scraping for personal use
      };

      return {
        ...listing,
        provenance,
      };
    } catch (error) {
      this.trackExtraction(false);
      logger.error('eBay extraction failed', { url, error });
      return null;
    }
  }

  /**
   * Map legacy condition string to ProductCondition type
   */
  private mapCondition(condition: string | null): MarketplaceListing['condition'] {
    if (!condition) return 'unknown';
    const lower = condition.toLowerCase();
    if (lower.includes('new')) return 'new';
    if (lower.includes('like new')) return 'used_like_new';
    if (lower.includes('very good')) return 'used_very_good';
    if (lower.includes('good')) return 'used_good';
    if (lower.includes('acceptable')) return 'used_acceptable';
    if (lower.includes('refurbished')) return 'refurbished';
    if (lower.includes('used')) return 'used_good';
    return 'unknown';
  }

  /**
   * Track extraction for health monitoring
   */
  private trackExtraction(success: boolean): void {
    const now = Date.now();
    this.recentExtractions.push({ success, timestamp: now });
    // Keep only last 100 extractions or last hour
    const oneHourAgo = now - 60 * 60 * 1000;
    this.recentExtractions = this.recentExtractions
      .filter(e => e.timestamp > oneHourAgo)
      .slice(-100);
  }

  /**
   * Check if this source is available (implements DataSourceAdapter)
   */
  async isAvailable(): Promise<boolean> {
    // Scraping adapter is always "available" in the sense that it can be attempted
    // Actual availability depends on eBay being up and not blocking us
    return true;
  }

  /**
   * Get health status (implements DataSourceAdapter)
   */
  async getHealth(): Promise<DataSourceHealth> {
    const total = this.recentExtractions.length;
    const failures = this.recentExtractions.filter(e => !e.success).length;
    const failureRate = total > 0 ? failures / total : 0;

    return {
      available: true,
      lastSuccessfulExtraction: this.lastSuccessfulExtraction,
      recentFailureRate: failureRate,
      estimatedReliability: Math.max(0, this.confidenceRange.max - failureRate * 0.5),
      statusMessage: total === 0
        ? 'No recent extractions'
        : `${total - failures}/${total} successful in last hour`,
    };
  }

  /**
   * Validate extracted listing (implements MarketplaceAdapter)
   */
  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!listing.title || listing.title === 'Unknown Item') {
      errors.push('Missing or invalid title');
    }

    if (listing.price === null) {
      errors.push('Missing sold price');
    }

    if (!listing.itemNumber) {
      warnings.push('Missing eBay item number');
    }

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
   * Get adapter configuration (implements MarketplaceAdapter)
   */
  getConfig(): MarketplaceConfig {
    return {
      marketplaceId: 'ebay',
      enabled: true,
      rendering: {
        requiresJavaScript: true,
        waitForSelectors: ['.x-price-primary', 'h1'],
        waitTime: 1500,
        blockResources: ['font'],
      },
      rateLimit: {
        requestsPerSecond: 1,
        requestsPerMinute: 30,
        requestsPerHour: 500,
        backoffStrategy: 'exponential',
        retryAttempts: 3,
      },
      session: {
        requireProxy: false,
        proxyRotation: 'none',
        cookiePersistence: true,
        userAgentRotation: true,
        sessionDuration: 120,
      },
      compliance: {
        respectRobotsTxt: true,
        crawlDelay: 1000,
        userAgent: 'Mozilla/5.0 (compatible; AnnoBot/1.0)',
        maxConcurrentRequests: 2,
      },
      quality: {
        minConfidenceScore: 0.5,
        requiredFields: ['title', 'price'],
      },
      features: {
        extractDescriptions: false,
        extractReviews: false,
        extractVariants: false,
        enableBackfill: true,
      },
    };
  }
}

// Global singleton
export const ebayAdapter = new EbayAdapter();
