/**
 * Email Parsing Adapter
 *
 * Tier 2/4 hybrid data source that extracts order information from
 * marketplace order confirmation emails.
 *
 * Uses pattern matching for known email formats (Tier 2 confidence)
 * and falls back to LLM extraction for unknown formats (Tier 4).
 *
 * @module extractors/email-parsing-adapter
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */

import { createHash } from 'crypto';
// Removed: logger import (not currently used)
import {
  DataSourceAdapter,
  DataSourceChannel,
  DataSourceTier,
  DataSourceHealth,
  DataProvenance,
  MarketplaceListing,
  MarketplaceListingWithProvenance,
  MarketplaceConfig,
  MarketplaceType,
  ExtractionOptions,
  ValidationResult,
  MoneyAmount,
  ProductCondition,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';
import { LLMExtractionAdapter } from './llm-extraction-adapter';

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed email structure
 */
export interface ParsedEmail {
  from: string;
  to?: string;
  subject: string;
  date?: string;
  body: string;
  html?: string;
}

/**
 * Extracted order from email
 */
export interface EmailOrderExtraction {
  orderId: string | null;
  orderDate: string | null;
  items: Array<{
    title: string;
    price: MoneyAmount | null;
    quantity: number;
    itemNumber?: string;
  }>;
  total: MoneyAmount | null;
  shipping: MoneyAmount | null;
  tax: MoneyAmount | null;
  seller?: string;
  marketplace: MarketplaceType | null;
  shippingAddress?: string;
  trackingNumber?: string;
  confidence: number;
  extractionMethod: 'pattern' | 'llm';
}

/**
 * Email pattern for a specific marketplace
 */
interface EmailPattern {
  marketplace: MarketplaceType;
  fromPattern: RegExp;
  subjectPatterns: RegExp[];
  extractors: {
    orderId?: RegExp;
    orderDate?: RegExp;
    itemTitle?: RegExp;
    itemPrice?: RegExp;
    total?: RegExp;
    shipping?: RegExp;
    trackingNumber?: RegExp;
  };
}

// ============================================================================
// Email Patterns for Known Marketplaces
// ============================================================================

const EMAIL_PATTERNS: EmailPattern[] = [
  {
    marketplace: 'amazon',
    fromPattern: /@amazon\.(com|co\.uk|de|fr|ca|com\.au)/i,
    subjectPatterns: [
      /your.*order.*shipped/i,
      /order.*confirmed/i,
      /delivery.*update/i,
      /your.*order.*has.*shipped/i,
    ],
    extractors: {
      orderId: /order\s*#?\s*(\d{3}-\d{7}-\d{7})/i,
      orderDate: /ordered\s+on\s+(\w+\s+\d{1,2},?\s+\d{4})/i,
      itemTitle: /^\s*(.+?)\s*$/m,
      itemPrice: /\$\s*([\d,]+\.?\d*)/,
      total: /order\s+total[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      shipping: /shipping[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      trackingNumber: /tracking\s*(?:number|#)?[:\s]*([A-Z0-9]{10,30})/i,
    },
  },
  {
    marketplace: 'ebay',
    fromPattern: /@ebay\.(com|co\.uk|de|fr|ca|com\.au)/i,
    subjectPatterns: [
      /you.*(?:won|bought)/i,
      /order.*confirmed/i,
      /payment.*received/i,
      /your.*order.*is.*on.*its.*way/i,
    ],
    extractors: {
      orderId: /(?:order|transaction)\s*(?:number|#|id)?[:\s]*(\d{12,15})/i,
      orderDate: /(?:purchased|ordered|sold)\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
      itemTitle: /item[:\s]*([^\n]+)/i,
      itemPrice: /(?:sold\s+for|price|total)[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      total: /(?:order\s+)?total[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      shipping: /shipping[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      trackingNumber: /tracking\s*(?:number|#)?[:\s]*([A-Z0-9]{10,30})/i,
    },
  },
  {
    marketplace: 'walmart',
    fromPattern: /@walmart\.com/i,
    subjectPatterns: [
      /your.*order.*is.*on.*the.*way/i,
      /order.*confirmed/i,
      /thanks.*for.*your.*order/i,
    ],
    extractors: {
      orderId: /order\s*#?\s*(\d{10,15})/i,
      orderDate: /ordered\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
      total: /total[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      shipping: /shipping[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      trackingNumber: /tracking\s*(?:number|#)?[:\s]*([A-Z0-9]{10,30})/i,
    },
  },
  {
    marketplace: 'etsy',
    fromPattern: /@etsy\.com/i,
    subjectPatterns: [
      /your.*order.*from/i,
      /receipt.*from/i,
      /order.*shipped/i,
    ],
    extractors: {
      orderId: /order\s*#?\s*(\d{8,12})/i,
      orderDate: /(?:ordered|purchased)\s+(?:on\s+)?(\w+\s+\d{1,2},?\s+\d{4})/i,
      total: /(?:order\s+)?total[:\s]*\$?\s*([\d,]+\.?\d*)/i,
      shipping: /shipping[:\s]*\$?\s*([\d,]+\.?\d*)/i,
    },
  },
];

// ============================================================================
// Email Parsing Adapter
// ============================================================================

export class EmailParsingAdapter implements DataSourceAdapter {
  // MarketplaceAdapter properties
  readonly marketplaceId: MarketplaceType = 'custom';
  readonly name = 'Email Parsing Adapter';
  readonly version = '1.0.0';

  // DataSourceAdapter properties
  readonly channel: DataSourceChannel = 'email_parsing';
  readonly tier: DataSourceTier = 2; // Pattern matching is Tier 2
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.email_parsing;
  readonly requiresUserAction = true; // User must forward/upload email

  // LLM fallback for unknown formats
  private llmAdapter: LLMExtractionAdapter | null = null;

  // Health tracking
  private lastSuccessfulExtraction?: string;
  private recentExtractions: { success: boolean; timestamp: number; method: 'pattern' | 'llm' }[] = [];

  constructor(options?: { enableLLMFallback?: boolean }) {
    if (options?.enableLLMFallback !== false) {
      this.llmAdapter = new LLMExtractionAdapter();
    }
  }

  // =========================================================================
  // MarketplaceAdapter Interface
  // =========================================================================

  canHandle(input: string): boolean {
    // Check if it looks like an email
    return (
      (input.includes('From:') || input.includes('from:')) &&
      (input.includes('Subject:') || input.includes('subject:')) &&
      (input.includes('order') || input.includes('Order') ||
       input.includes('shipped') || input.includes('receipt'))
    );
  }

  async extract(
    content: string,
    source: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const email = this.parseEmailContent(content);
    if (!email) {
      return null;
    }

    const extraction = await this.extractFromEmail(email);
    if (!extraction || extraction.items.length === 0) {
      return null;
    }

    // Return first item as listing
    return this.extractionToListing(extraction, email, source);
  }

  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!listing.title) {
      errors.push('Missing item title from email');
    }

    if (!listing.price) {
      warnings.push('Missing price - may need manual verification');
    }

    if (!listing.itemNumber) {
      warnings.push('Missing order/item number');
    }

    if (listing.confidence < this.confidenceRange.min) {
      warnings.push(`Low confidence ${listing.confidence.toFixed(2)} - verify extracted data`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getConfig(): MarketplaceConfig {
    return {
      marketplaceId: 'custom',
      enabled: true,
      rendering: {
        requiresJavaScript: false,
      },
      rateLimit: {
        requestsPerSecond: 100, // Local parsing
        requestsPerMinute: 6000,
        requestsPerHour: 360000,
        backoffStrategy: 'constant',
        retryAttempts: 1,
      },
      session: {
        requireProxy: false,
        proxyRotation: 'none',
        cookiePersistence: false,
        userAgentRotation: false,
      },
      compliance: {
        respectRobotsTxt: false,
        userAgent: 'Anno Email Parser',
        maxConcurrentRequests: 10,
      },
      quality: {
        minConfidenceScore: 0.75,
        requiredFields: ['title'],
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
  // DataSourceAdapter Interface
  // =========================================================================

  async extractWithProvenance(
    content: string,
    source: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null> {
    const listing = await this.extract(content, source, options);

    if (!listing) {
      this.trackExtraction(false, 'pattern');
      return null;
    }

    const wasLLM = listing.attributes?.extractionMethod === 'llm';
    this.lastSuccessfulExtraction = new Date().toISOString();
    this.trackExtraction(true, wasLLM ? 'llm' : 'pattern');

    const provenance: DataProvenance = {
      channel: this.channel,
      tier: wasLLM ? 4 : 2, // LLM fallback is Tier 4
      confidence: listing.confidence,
      freshness: 'historical',
      sourceId: `${this.name}/${this.version}`,
      extractedAt: new Date().toISOString(),
      rawDataHash: this.hashContent(content),
      userConsented: true,
      termsCompliant: true,
      metadata: {
        extractionMethod: wasLLM ? 'llm' : 'pattern',
        marketplace: listing.marketplace,
      },
    };

    return {
      ...listing,
      provenance,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true; // Pattern matching is always available
  }

  async getHealth(): Promise<DataSourceHealth> {
    const total = this.recentExtractions.length;
    const failures = this.recentExtractions.filter(e => !e.success).length;
    const failureRate = total > 0 ? failures / total : 0;

    const patternExtractions = this.recentExtractions.filter(e => e.method === 'pattern').length;
    const llmFallbacks = this.recentExtractions.filter(e => e.method === 'llm').length;

    return {
      available: true,
      lastSuccessfulExtraction: this.lastSuccessfulExtraction,
      recentFailureRate: failureRate,
      estimatedReliability: this.confidenceRange.max,
      statusMessage: `Email parsing available (${patternExtractions} pattern, ${llmFallbacks} LLM fallback)`,
    };
  }

  // =========================================================================
  // Bulk Extraction
  // =========================================================================

  /**
   * Extract all items from an email as separate listings
   */
  async extractAllItems(
    content: string,
    source: string
  ): Promise<MarketplaceListingWithProvenance[]> {
    const email = this.parseEmailContent(content);
    if (!email) {
      return [];
    }

    const extraction = await this.extractFromEmail(email);
    if (!extraction || extraction.items.length === 0) {
      return [];
    }

    const listings: MarketplaceListingWithProvenance[] = [];

    for (const item of extraction.items) {
      const listing = this.itemToListing(item, extraction, email, source);

      const provenance: DataProvenance = {
        channel: this.channel,
        tier: extraction.extractionMethod === 'llm' ? 4 : 2,
        confidence: listing.confidence,
        freshness: 'historical',
        sourceId: `${this.name}/${this.version}`,
        extractedAt: new Date().toISOString(),
        rawDataHash: this.hashContent(content),
        userConsented: true,
        termsCompliant: true,
        metadata: {
          extractionMethod: extraction.extractionMethod,
          orderId: extraction.orderId,
          itemIndex: extraction.items.indexOf(item),
        },
      };

      listings.push({
        ...listing,
        provenance,
      });
    }

    return listings;
  }

  // =========================================================================
  // Core Extraction Logic
  // =========================================================================

  private parseEmailContent(content: string): ParsedEmail | null {
    // Try to extract email headers
    const fromMatch = content.match(/^From:\s*(.+?)$/mi);
    const toMatch = content.match(/^To:\s*(.+?)$/mi);
    const subjectMatch = content.match(/^Subject:\s*(.+?)$/mi);
    const dateMatch = content.match(/^Date:\s*(.+?)$/mi);

    if (!fromMatch || !subjectMatch) {
      // Not a valid email format
      return null;
    }

    // Extract body (everything after headers)
    const headerEndIndex = content.search(/\n\n|\r\n\r\n/);
    const body = headerEndIndex > 0 ? content.slice(headerEndIndex + 2) : content;

    return {
      from: fromMatch[1].trim(),
      to: toMatch?.[1].trim(),
      subject: subjectMatch[1].trim(),
      date: dateMatch?.[1].trim(),
      body: body.trim(),
    };
  }

  private async extractFromEmail(email: ParsedEmail): Promise<EmailOrderExtraction | null> {
    // Try pattern matching first
    const patternMatch = this.extractWithPatterns(email);
    if (patternMatch && patternMatch.items.length > 0) {
      return patternMatch;
    }

    // Fall back to LLM if available
    if (this.llmAdapter) {
      return this.extractWithLLM(email);
    }

    return null;
  }

  private extractWithPatterns(email: ParsedEmail): EmailOrderExtraction | null {
    // Find matching marketplace pattern
    const pattern = EMAIL_PATTERNS.find(p =>
      p.fromPattern.test(email.from) &&
      p.subjectPatterns.some(sp => sp.test(email.subject))
    );

    if (!pattern) {
      return null;
    }

    const combined = email.subject + '\n' + email.body;

    // Extract order ID
    const orderId = pattern.extractors.orderId
      ? combined.match(pattern.extractors.orderId)?.[1] || null
      : null;

    // Extract order date
    const orderDateMatch = pattern.extractors.orderDate
      ? combined.match(pattern.extractors.orderDate)?.[1]
      : null;
    const orderDate = orderDateMatch ? this.parseDate(orderDateMatch) : null;

    // Extract total
    const totalMatch = pattern.extractors.total
      ? combined.match(pattern.extractors.total)?.[1]
      : null;
    const total = totalMatch
      ? { amount: parseFloat(totalMatch.replace(/,/g, '')), currency: 'USD' }
      : null;

    // Extract shipping
    const shippingMatch = pattern.extractors.shipping
      ? combined.match(pattern.extractors.shipping)?.[1]
      : null;
    const shipping = shippingMatch
      ? { amount: parseFloat(shippingMatch.replace(/,/g, '')), currency: 'USD' }
      : null;

    // Extract tracking number
    const trackingNumber = pattern.extractors.trackingNumber
      ? combined.match(pattern.extractors.trackingNumber)?.[1] || undefined
      : undefined;

    // For now, use subject as item title (simplistic)
    // A full implementation would parse the email body more thoroughly
    const items = [{
      title: email.subject.replace(/^(re:|fwd:|your|order|confirmed|shipped)/gi, '').trim(),
      price: total,
      quantity: 1,
    }];

    return {
      orderId,
      orderDate,
      items,
      total,
      shipping,
      tax: null,
      marketplace: pattern.marketplace,
      trackingNumber,
      confidence: 0.85,
      extractionMethod: 'pattern',
    };
  }

  private async extractWithLLM(email: ParsedEmail): Promise<EmailOrderExtraction | null> {
    if (!this.llmAdapter) {
      return null;
    }

    const content = `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date || 'Unknown'}\n\n${email.body}`;

    const listing = await this.llmAdapter.extract(content, 'email', {
      contentType: 'email',
    });

    if (!listing) {
      return null;
    }

    return {
      orderId: listing.itemNumber || null,
      orderDate: listing.soldDate || null,
      items: [{
        title: listing.title,
        price: listing.price,
        quantity: 1,
        itemNumber: listing.itemNumber,
      }],
      total: listing.price,
      shipping: null,
      tax: null,
      seller: listing.seller?.name || undefined,
      marketplace: listing.marketplace as MarketplaceType || null,
      confidence: listing.confidence * 0.9, // Slight penalty for LLM extraction
      extractionMethod: 'llm',
    };
  }

  // =========================================================================
  // Helper Methods
  // =========================================================================

  private extractionToListing(
    extraction: EmailOrderExtraction,
    email: ParsedEmail,
    source: string
  ): MarketplaceListing {
    const firstItem = extraction.items[0];
    return this.itemToListing(firstItem, extraction, email, source);
  }

  private itemToListing(
    item: EmailOrderExtraction['items'][0],
    extraction: EmailOrderExtraction,
    email: ParsedEmail,
    source: string
  ): MarketplaceListing {
    return {
      id: extraction.orderId || `email-${this.hashContent(email.body).slice(0, 12)}`,
      marketplace: extraction.marketplace || 'custom',
      url: source,
      title: item.title,
      price: item.price,
      condition: 'unknown' as ProductCondition,
      availability: 'sold',
      soldDate: extraction.orderDate || undefined,
      seller: {
        name: extraction.seller || null,
      },
      images: [],
      itemNumber: item.itemNumber || extraction.orderId || undefined,
      extractedAt: new Date().toISOString(),
      extractionMethod: `${this.name} v${this.version} (${extraction.extractionMethod})`,
      confidence: extraction.confidence,
      extractorVersion: this.version,
      attributes: {
        extractionMethod: extraction.extractionMethod,
        quantity: item.quantity,
        orderTotal: extraction.total,
        shipping: extraction.shipping,
        tax: extraction.tax,
        trackingNumber: extraction.trackingNumber,
        emailSubject: email.subject,
        emailFrom: email.from,
      },
    };
  }

  private parseDate(dateStr: string): string | null {
    try {
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    } catch {
      // Fall through to null
    }
    return null;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private trackExtraction(success: boolean, method: 'pattern' | 'llm'): void {
    const now = Date.now();
    this.recentExtractions.push({ success, timestamp: now, method });

    const oneHourAgo = now - 60 * 60 * 1000;
    this.recentExtractions = this.recentExtractions
      .filter(e => e.timestamp > oneHourAgo)
      .slice(-100);
  }
}

// ============================================================================
// Factory & Singleton
// ============================================================================

/**
 * Create email parsing adapter with LLM fallback
 */
export function createEmailAdapter(options?: { enableLLMFallback?: boolean }): EmailParsingAdapter {
  return new EmailParsingAdapter(options);
}

// Export default instance
export const emailParsingAdapter = new EmailParsingAdapter();
