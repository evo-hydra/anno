/**
 * Amazon Marketplace Adapter
 *
 * Extracts structured data from Amazon product listings.
 * Requires JavaScript rendering due to dynamic content.
 *
 * NOTE: This adapter handles PUBLIC product pages only.
 * Order history requires authenticated access via Tier 2 channels
 * (browser extension, data export, etc.)
 *
 * @module extractors/amazon-adapter
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
  ProductCondition,
  AvailabilityStatus,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';

export class AmazonAdapter implements DataSourceAdapter {
  readonly marketplaceId = 'amazon' as const;
  readonly name = 'Amazon Scraping Adapter';
  readonly version = '2.0.0';

  // DataSourceAdapter required properties
  readonly channel: DataSourceChannel = 'scraping';
  readonly tier: DataSourceTier = 3;
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.scraping;
  readonly requiresUserAction = false;

  // Health tracking
  private lastSuccessfulExtraction?: string;
  private recentExtractions: { success: boolean; timestamp: number }[] = [];

  /**
   * Check if URL is an Amazon listing
   */
  canHandle(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.hostname.includes('amazon.com') ||
        parsed.hostname.includes('amazon.co.uk') ||
        parsed.hostname.includes('amazon.ca') ||
        parsed.hostname.includes('amazon.de') ||
        parsed.hostname.includes('amazon.fr')
      );
    } catch {
      return false;
    }
  }

  /**
   * Extract product data from Amazon page
   */
  async extract(
    html: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    logger.debug('Amazon adapter extracting', { url });

    try {
      // Check if page is valid (not blocked/captcha)
      if (this.isBlockedPage(document)) {
        logger.warn('Amazon page appears to be blocked or requires captcha', { url });
        return null;
      }

      // Extract core fields
      const title = this.extractTitle(document);
      const { price, currency } = this.extractPrice(document);
      const availability = this.extractAvailability(document);
      const condition = this.extractCondition(document);
      const asin = this.extractAsin(document, url);
      const seller = this.extractSeller(document);
      const images = this.extractImages(document, options);
      const category = this.extractCategory(document);

      // Calculate confidence
      const confidence = this.calculateConfidence({
        hasTitle: !!title,
        hasPrice: price !== null,
        hasAvailability: availability !== 'unknown',
        hasAsin: !!asin,
        hasSeller: !!seller.name,
      });

      // Build normalized listing
      const listing: MarketplaceListing = {
        id: asin || this.generateIdFromUrl(url),
        marketplace: 'amazon',
        url,
        title,
        price: price !== null ? { amount: price, currency } : null,
        condition,
        availability,
        seller,
        images,
        itemNumber: asin !== null ? asin : undefined,
        category,
        extractedAt: new Date().toISOString(),
        extractionMethod: `${this.name} v${this.version}`,
        confidence,
        extractorVersion: this.version,
      };

      return listing;
    } catch (error) {
      logger.error('Amazon extraction failed', {
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
      warnings.push('Missing price information (may be out of stock)');
    }

    if (!listing.itemNumber) {
      errors.push('Missing ASIN');
    }

    if (listing.availability === 'unknown') {
      warnings.push('Could not determine availability status');
    }

    // Confidence threshold
    if (listing.confidence < 0.6) {
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
      marketplaceId: 'amazon',
      enabled: false, // Dark launch - disabled by default
      rendering: {
        requiresJavaScript: true,
        waitForSelectors: ['#productTitle', '#priceblock_ourprice, .a-price .a-offscreen'],
        waitTime: 2000,
        blockResources: ['image', 'font', 'stylesheet'], // Reduce bandwidth
      },
      rateLimit: {
        requestsPerSecond: 1,
        requestsPerMinute: 30,
        requestsPerHour: 1000,
        backoffStrategy: 'exponential',
        retryAttempts: 5,
      },
      session: {
        requireProxy: true, // Amazon detects bots aggressively
        proxyRotation: 'per_request',
        cookiePersistence: true,
        userAgentRotation: true,
        sessionDuration: 30,
      },
      compliance: {
        respectRobotsTxt: true,
        crawlDelay: 2000,
        userAgent: 'Mozilla/5.0 (compatible; AnnoBot/1.0)',
        maxConcurrentRequests: 1, // Very conservative
      },
      quality: {
        minConfidenceScore: 0.75,
        requiredFields: ['title', 'availability', 'itemNumber'],
      },
      features: {
        extractDescriptions: false, // Requires additional parsing
        extractReviews: false, // Requires separate API/page
        extractVariants: false, // Complex - future enhancement
        enableBackfill: false, // Not yet approved for bulk scraping
      },
    };
  }

  // =========================================================================
  // Private extraction methods
  // =========================================================================

  private isBlockedPage(document: Document): boolean {
    // Check for captcha or bot detection
    const captchaIndicators = [
      'captcha',
      'robot check',
      'automated access',
      'sorry! something went wrong',
    ];

    const bodyText = document.body?.textContent?.toLowerCase() || '';
    return captchaIndicators.some((indicator) => bodyText.includes(indicator));
  }

  private extractTitle(document: Document): string {
    const selectors = [
      '#productTitle',
      '#title',
      'h1 span#productTitle',
      'h1.a-size-large',
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
    // Amazon has many price formats (deals, subscriptions, etc.)
    const selectors = [
      '.a-price .a-offscreen', // Most reliable
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.a-price-whole',
      'span.a-price span.a-offscreen',
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

    return { price: null, currency: 'USD' };
  }

  private parsePrice(priceText: string): { price: number | null; currency: string } {
    const cleaned = priceText.trim().replace(/\s+/g, ' ');

    // Detect currency
    let currency = 'USD';
    if (cleaned.includes('$')) currency = 'USD';
    else if (cleaned.includes('£')) currency = 'GBP';
    else if (cleaned.includes('€')) currency = 'EUR';
    else if (cleaned.includes('CAD')) currency = 'CAD';

    // Extract numeric value (handle formats like "$123.45" or "123.45")
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
    const availabilityElement = document.querySelector('#availability span');
    const text = availabilityElement?.textContent?.toLowerCase() || '';

    if (text.includes('in stock')) return 'in_stock';
    if (text.includes('out of stock')) return 'out_of_stock';
    if (text.includes('unavailable')) return 'unavailable';
    if (text.includes('currently unavailable')) return 'unavailable';

    // Check add to cart button
    const addToCartButton = document.querySelector('#add-to-cart-button');
    if (addToCartButton && !addToCartButton.hasAttribute('disabled')) {
      return 'in_stock';
    }

    return 'unknown';
  }

  private extractCondition(document: Document): ProductCondition {
    // Amazon condition is often in subtitle or features
    const conditionElement = document.querySelector('#condition-text, .a-text-bold');
    const text = conditionElement?.textContent?.toLowerCase() || '';

    if (text.includes('new')) return 'new';
    if (text.includes('refurbished')) return 'refurbished';
    if (text.includes('used - like new')) return 'used_like_new';
    if (text.includes('used - very good')) return 'used_very_good';
    if (text.includes('used - good')) return 'used_good';
    if (text.includes('used - acceptable')) return 'used_acceptable';
    if (text.includes('used')) return 'used_good';

    // Default to new for most Amazon listings
    return 'new';
  }

  private extractAsin(document: Document, url: string): string | null {
    // Try URL first
    const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i) || url.match(/\/product\/([A-Z0-9]{10})/i);
    if (asinMatch) {
      return asinMatch[1];
    }

    // Check meta tags
    const asinMeta = document.querySelector('input[name="ASIN"]');
    if (asinMeta) {
      return asinMeta.getAttribute('value');
    }

    // Check data attributes
    const productElement = document.querySelector('[data-asin]');
    if (productElement) {
      return productElement.getAttribute('data-asin');
    }

    return null;
  }

  private extractSeller(document: Document): {
    id?: string;
    name: string | null;
    rating?: number;
    verified?: boolean;
  } {
    const sellerElement = document.querySelector('#sellerProfileTriggerId, #bylineInfo');
    const sellerName = sellerElement?.textContent?.trim() || null;

    // Check if sold by Amazon
    const isAmazon = sellerName?.toLowerCase().includes('amazon');

    return {
      name: sellerName,
      verified: isAmazon,
    };
  }

  private extractImages(document: Document, options?: ExtractionOptions): string[] {
    if (options?.extractImages === false) {
      return [];
    }

    const images: string[] = [];

    // Main image
    const mainImage = document.querySelector('#landingImage, #imgBlkFront') as HTMLImageElement;
    if (mainImage?.src) {
      images.push(mainImage.src);
    }

    // Thumbnail images
    const thumbnails = document.querySelectorAll('.imageThumbnail img');
    thumbnails.forEach((img) => {
      const src = (img as HTMLImageElement).src;
      if (src && !images.includes(src)) {
        images.push(src);
      }
    });

    return images;
  }

  private extractCategory(document: Document): string[] | undefined {
    const breadcrumbs = document.querySelectorAll('#wayfinding-breadcrumbs_feature_div a');
    if (breadcrumbs.length === 0) return undefined;

    const category: string[] = [];
    breadcrumbs.forEach((crumb) => {
      const text = crumb.textContent?.trim();
      if (text) {
        category.push(text);
      }
    });

    return category.length > 0 ? category : undefined;
  }

  private calculateConfidence(indicators: {
    hasTitle: boolean;
    hasPrice: boolean;
    hasAvailability: boolean;
    hasAsin: boolean;
    hasSeller: boolean;
  }): number {
    let confidence = 0;

    if (indicators.hasTitle) confidence += 0.25;
    if (indicators.hasPrice) confidence += 0.25;
    if (indicators.hasAvailability) confidence += 0.2;
    if (indicators.hasAsin) confidence += 0.2; // ASIN is critical
    if (indicators.hasSeller) confidence += 0.1;

    return confidence;
  }

  private generateIdFromUrl(url: string): string {
    return url.split('/').pop()?.split('?')[0] || `amazon-${Date.now()}`;
  }

  // =========================================================================
  // DataSourceAdapter Interface Methods
  // =========================================================================

  /**
   * Extract with full provenance tracking (implements DataSourceAdapter)
   */
  async extractWithProvenance(
    content: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null> {
    try {
      const listing = await this.extract(content, url, options);

      if (!listing) {
        this.trackExtraction(false);
        return null;
      }

      // Track successful extraction
      this.lastSuccessfulExtraction = new Date().toISOString();
      this.trackExtraction(true);

      // Build provenance
      const provenance: DataProvenance = {
        channel: this.channel,
        tier: this.tier,
        confidence: listing.confidence,
        freshness: 'realtime',
        sourceId: `${this.name}/${this.version}`,
        extractedAt: listing.extractedAt,
        userConsented: true,
        // Note: Amazon ToS prohibits scraping, but public product pages are often tolerated
        termsCompliant: false,
        metadata: {
          note: 'Amazon ToS prohibits automated access. Use Tier 1/2 channels for production.',
        },
      };

      return {
        ...listing,
        provenance,
      };
    } catch (error) {
      this.trackExtraction(false);
      logger.error('Amazon extraction failed', { url, error });
      return null;
    }
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
    // Amazon scraping is always "available" but has low reliability
    // Consider returning false if recent failure rate is very high
    const health = await this.getHealth();
    return health.recentFailureRate < 0.8;
  }

  /**
   * Get health status (implements DataSourceAdapter)
   */
  async getHealth(): Promise<DataSourceHealth> {
    const total = this.recentExtractions.length;
    const failures = this.recentExtractions.filter(e => !e.success).length;
    const failureRate = total > 0 ? failures / total : 0;

    // Amazon has lower baseline reliability due to aggressive anti-bot
    const baseReliability = this.confidenceRange.min;

    return {
      available: failureRate < 0.8,
      lastSuccessfulExtraction: this.lastSuccessfulExtraction,
      recentFailureRate: failureRate,
      estimatedReliability: Math.max(0, baseReliability - failureRate * 0.3),
      statusMessage: total === 0
        ? 'No recent extractions - Amazon requires careful rate limiting'
        : failureRate > 0.5
        ? `High failure rate (${Math.round(failureRate * 100)}%) - consider using Tier 2 channels`
        : `${total - failures}/${total} successful in last hour`,
    };
  }
}

// Export singleton instance
export const amazonAdapter = new AmazonAdapter();
