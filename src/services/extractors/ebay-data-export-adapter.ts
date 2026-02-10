/**
 * eBay Data Export Adapter
 *
 * Parses eBay CSV exports from Seller Hub or purchase history.
 * This is a Tier 2 (authenticated user context) data source.
 *
 * Supports:
 * - Seller Hub order exports (Reports > Downloads > Orders)
 * - Seller Hub listing exports (Reports > Downloads > Listings)
 * - Purchase history exports (via third-party tools like OrderPro)
 *
 * @module extractors/ebay-data-export-adapter
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */

import { readFile } from 'fs/promises';
import { parse as csvParse } from 'csv-parse/sync';
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
  MoneyAmount,
  ProductCondition,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';

// ============================================================================
// Types
// ============================================================================

/**
 * eBay order row from CSV export (seller perspective)
 */
export interface EbayOrderRow {
  // Order identifiers
  'Sales Record Number'?: string;
  'Order Number'?: string;
  'Transaction ID'?: string;
  'Item Number'?: string;
  'Item ID'?: string;
  'eBay Item Number'?: string;

  // Item details
  'Item Title'?: string;
  'Title'?: string;
  'Custom Label'?: string;
  'SKU'?: string;

  // Pricing
  'Sale Price'?: string;
  'Total Price'?: string;
  'Item Price'?: string;
  'Quantity'?: string;
  'Shipping and Handling'?: string;
  'Shipping Cost'?: string;

  // Dates
  'Sale Date'?: string;
  'Sold Date'?: string;
  'Paid on Date'?: string;
  'Ship Date'?: string;

  // Buyer info
  'Buyer Username'?: string;
  'Buyer Name'?: string;

  // Shipping
  'Ship to Address 1'?: string;
  'Ship to City'?: string;
  'Ship to State'?: string;
  'Ship to Zip'?: string;
  'Ship to Country'?: string;
  'Tracking Number'?: string;

  // Status
  'Payment Status'?: string;
  'Shipped'?: string;
  'Feedback Left'?: string;
  'Feedback Received'?: string;

  // Allow any other fields
  [key: string]: string | undefined;
}

/**
 * eBay listing row from CSV export
 */
export interface EbayListingRow {
  'Item Number'?: string;
  'Item ID'?: string;
  'Title'?: string;
  'Item Title'?: string;
  'Custom Label'?: string;
  'SKU'?: string;
  'Start Price'?: string;
  'Current Price'?: string;
  'Buy It Now Price'?: string;
  'Quantity'?: string;
  'Quantity Available'?: string;
  'Quantity Sold'?: string;
  'Format'?: string;
  'Duration'?: string;
  'Condition'?: string;
  'Condition ID'?: string;
  'Category'?: string;
  'Category ID'?: string;
  'Store Category'?: string;
  'Start Date'?: string;
  'End Date'?: string;
  'View Item URL'?: string;
  'Picture URL'?: string;
  [key: string]: string | undefined;
}

/**
 * Normalized eBay order/listing item
 */
export interface EbayExportItem {
  itemId: string;
  orderId?: string;
  title: string;
  sku?: string;
  price: MoneyAmount;
  shippingCost?: MoneyAmount;
  quantity: number;
  saleDate?: Date;
  condition?: string;
  category?: string;
  buyer?: string;
  trackingNumber?: string;
  imageUrl?: string;
  url?: string;
  rawRow: EbayOrderRow | EbayListingRow;
}

/**
 * Result of parsing an eBay data export
 */
export interface EbayDataExportResult {
  items: EbayExportItem[];
  totalItems: number;
  exportType: 'orders' | 'listings' | 'unknown';
  dateRange: {
    earliest?: Date;
    latest?: Date;
  };
  parseErrors: string[];
  sourceFile: string;
}

// ============================================================================
// eBay Data Export Adapter
// ============================================================================

export class EbayDataExportAdapter implements DataSourceAdapter {
  // MarketplaceAdapter properties
  readonly marketplaceId = 'ebay' as const;
  readonly name = 'eBay Data Export Adapter';
  readonly version = '1.0.0';

  // DataSourceAdapter properties
  readonly channel: DataSourceChannel = 'data_export';
  readonly tier: DataSourceTier = 2;
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.data_export;
  readonly requiresUserAction = true;

  // Health tracking
  private lastSuccessfulParse?: string;
  private recentParses: { success: boolean; timestamp: number }[] = [];

  // =========================================================================
  // MarketplaceAdapter Interface
  // =========================================================================

  canHandle(input: string): boolean {
    if (input.endsWith('.csv')) {
      return true;
    }

    const ebayHeaders = [
      'Sales Record Number',
      'Item Number',
      'Item Title',
      'eBay Item Number',
      'Item ID',
      'Buyer Username',
      'Ship to',
    ];

    return ebayHeaders.some(header =>
      input.toLowerCase().includes(header.toLowerCase())
    );
  }

  async extract(
    content: string,
    source: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const result = await this.parseCSV(content, source);

    if (result.items.length === 0) {
      return null;
    }

    return this.exportItemToListing(result.items[0], source);
  }

  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!listing.title) {
      errors.push('Missing item title');
    }

    if (!listing.itemNumber) {
      warnings.push('Missing eBay item number');
    }

    if (!listing.price) {
      warnings.push('Missing price information');
    }

    if (listing.confidence < this.confidenceRange.min) {
      warnings.push(`Confidence ${listing.confidence} below expected minimum ${this.confidenceRange.min}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getConfig(): MarketplaceConfig {
    return {
      marketplaceId: 'ebay',
      enabled: true,
      rendering: {
        requiresJavaScript: false,
      },
      rateLimit: {
        requestsPerSecond: 100,
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
        userAgent: 'Anno Data Export Parser',
        maxConcurrentRequests: 10,
      },
      quality: {
        minConfidenceScore: 0.7,
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
      this.trackParse(false);
      return null;
    }

    this.lastSuccessfulParse = new Date().toISOString();
    this.trackParse(true);

    const provenance: DataProvenance = {
      channel: this.channel,
      tier: this.tier,
      confidence: listing.confidence,
      freshness: 'historical',
      sourceId: `${this.name}/${this.version}`,
      extractedAt: new Date().toISOString(),
      userConsented: true,
      termsCompliant: true,
      metadata: {
        sourceFile: source,
        exportType: 'eBay Seller Hub',
      },
    };

    return {
      ...listing,
      provenance,
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getHealth(): Promise<DataSourceHealth> {
    const total = this.recentParses.length;
    const failures = this.recentParses.filter(p => !p.success).length;
    const failureRate = total > 0 ? failures / total : 0;

    return {
      available: true,
      lastSuccessfulExtraction: this.lastSuccessfulParse,
      recentFailureRate: failureRate,
      estimatedReliability: this.confidenceRange.max,
      statusMessage: 'Data export parsing is always available',
    };
  }

  // =========================================================================
  // Bulk Extraction Methods
  // =========================================================================

  async parseCSV(content: string, source: string): Promise<EbayDataExportResult> {
    const parseErrors: string[] = [];
    const items: EbayExportItem[] = [];

    try {
      const records = csvParse(content, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      }) as (EbayOrderRow | EbayListingRow)[];

      // Detect export type
      const exportType = this.detectExportType(records[0] || {});

      logger.debug('eBay data export: parsed CSV', {
        source,
        rowCount: records.length,
        exportType,
      });

      for (let i = 0; i < records.length; i++) {
        try {
          const item = this.parseRow(records[i], i, exportType);
          if (item) {
            items.push(item);
          }
        } catch (error) {
          parseErrors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Calculate date range
      const dates = items
        .map(item => item.saleDate)
        .filter((d): d is Date => d !== undefined && !isNaN(d.getTime()));

      const dateRange = {
        earliest: dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : undefined,
        latest: dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : undefined,
      };

      logger.info('eBay data export: extraction complete', {
        source,
        totalRows: records.length,
        extractedItems: items.length,
        exportType,
        parseErrors: parseErrors.length,
      });

      return {
        items,
        totalItems: items.length,
        exportType,
        dateRange,
        parseErrors,
        sourceFile: source,
      };
    } catch (error) {
      logger.error('eBay data export: CSV parse failed', { source, error });
      return {
        items: [],
        totalItems: 0,
        exportType: 'unknown',
        dateRange: {},
        parseErrors: [`Failed to parse CSV: ${error instanceof Error ? error.message : 'Unknown error'}`],
        sourceFile: source,
      };
    }
  }

  async parseFile(filePath: string): Promise<EbayDataExportResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parseCSV(content, filePath);
    } catch (error) {
      logger.error('eBay data export: file read failed', { filePath, error });
      return {
        items: [],
        totalItems: 0,
        exportType: 'unknown',
        dateRange: {},
        parseErrors: [`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`],
        sourceFile: filePath,
      };
    }
  }

  async extractAllWithProvenance(
    content: string,
    source: string
  ): Promise<MarketplaceListingWithProvenance[]> {
    const result = await this.parseCSV(content, source);
    const listings: MarketplaceListingWithProvenance[] = [];

    for (const item of result.items) {
      const listing = this.exportItemToListing(item, source);

      const provenance: DataProvenance = {
        channel: this.channel,
        tier: this.tier,
        confidence: listing.confidence,
        freshness: 'historical',
        sourceId: `${this.name}/${this.version}`,
        extractedAt: new Date().toISOString(),
        userConsented: true,
        termsCompliant: true,
        metadata: {
          sourceFile: source,
          exportType: result.exportType,
          itemId: item.itemId,
        },
      };

      listings.push({
        ...listing,
        provenance,
      });
    }

    if (listings.length > 0) {
      this.lastSuccessfulParse = new Date().toISOString();
      this.trackParse(true);
    } else {
      this.trackParse(false);
    }

    return listings;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private detectExportType(firstRow: EbayOrderRow | EbayListingRow): 'orders' | 'listings' | 'unknown' {
    const keys = Object.keys(firstRow);

    // Order exports have these fields
    if (keys.some(k => ['Sales Record Number', 'Order Number', 'Buyer Username', 'Paid on Date'].includes(k))) {
      return 'orders';
    }

    // Listing exports have these fields
    if (keys.some(k => ['Format', 'Duration', 'Start Date', 'End Date', 'Quantity Available'].includes(k))) {
      return 'listings';
    }

    return 'unknown';
  }

  private parseRow(
    row: EbayOrderRow | EbayListingRow,
    index: number,
    _exportType: 'orders' | 'listings' | 'unknown'
  ): EbayExportItem | null {
    // Get item ID
    const itemId =
      row['Item Number'] ||
      row['Item ID'] ||
      row['eBay Item Number'] ||
      `ebay-export-${index}`;

    // Get title
    const title =
      row['Item Title'] ||
      row['Title'] ||
      (row as EbayListingRow)['Item Title'];

    if (!title) {
      return null;
    }

    // Get order ID (for order exports)
    const orderId =
      row['Sales Record Number'] ||
      row['Order Number'] ||
      row['Transaction ID'];

    // Get SKU
    const sku = row['Custom Label'] || row['SKU'];

    // Get price
    const priceStr =
      row['Sale Price'] ||
      row['Total Price'] ||
      row['Item Price'] ||
      (row as EbayListingRow)['Current Price'] ||
      (row as EbayListingRow)['Start Price'] ||
      '0';

    const price = this.parsePrice(priceStr);

    // Get shipping cost
    const shippingStr = row['Shipping and Handling'] || row['Shipping Cost'];
    const shippingCost = shippingStr ? this.parsePrice(shippingStr) : undefined;

    // Get quantity
    const quantityStr = row['Quantity'] || (row as EbayListingRow)['Quantity Sold'] || '1';
    const quantity = parseInt(quantityStr, 10) || 1;

    // Get sale date
    const dateStr =
      row['Sale Date'] ||
      row['Sold Date'] ||
      row['Paid on Date'] ||
      (row as EbayListingRow)['Start Date'];
    const saleDate = dateStr ? this.parseDate(dateStr) : undefined;

    // Get condition
    const condition = (row as EbayListingRow)['Condition'];

    // Get category
    const category = (row as EbayListingRow)['Category'] || (row as EbayListingRow)['Store Category'];

    // Get buyer
    const buyer = row['Buyer Username'] || row['Buyer Name'];

    // Get tracking
    const trackingNumber = row['Tracking Number'];

    // Get image URL
    const imageUrl = (row as EbayListingRow)['Picture URL'];

    // Get item URL
    const url = (row as EbayListingRow)['View Item URL'] ||
      (itemId && !itemId.startsWith('ebay-export-') ? `https://www.ebay.com/itm/${itemId}` : undefined);

    return {
      itemId,
      orderId,
      title,
      sku,
      price,
      shippingCost,
      quantity,
      saleDate,
      condition,
      category,
      buyer,
      trackingNumber,
      imageUrl,
      url,
      rawRow: row,
    };
  }

  private exportItemToListing(item: EbayExportItem, source: string): MarketplaceListing {
    return {
      id: item.orderId || item.itemId,
      marketplace: 'ebay',
      url: item.url || `https://www.ebay.com/itm/${item.itemId}`,
      title: item.title,
      price: item.price,
      shippingCost: item.shippingCost,
      condition: this.mapCondition(item.condition),
      availability: item.saleDate ? 'sold' : 'unknown',
      soldDate: item.saleDate?.toISOString().split('T')[0],
      seller: {
        name: null, // Seller is "self" in exports
      },
      images: item.imageUrl ? [item.imageUrl] : [],
      itemNumber: item.itemId,
      category: item.category ? [item.category] : undefined,
      extractedAt: new Date().toISOString(),
      extractionMethod: `${this.name} v${this.version}`,
      confidence: this.calculateConfidence(item),
      extractorVersion: this.version,
      attributes: {
        sku: item.sku,
        quantity: item.quantity,
        buyer: item.buyer,
        trackingNumber: item.trackingNumber,
        sourceFile: source,
      },
    };
  }

  private parseDate(dateStr: string): Date {
    // eBay uses various formats
    // Try common formats
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // Try MM/DD/YYYY
    const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      return new Date(parseInt(usMatch[3]), parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
    }

    // Try DD-Mon-YYYY (e.g., 15-Jan-2024)
    const ukMatch = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
    if (ukMatch) {
      return new Date(`${ukMatch[2]} ${ukMatch[1]}, ${ukMatch[3]}`);
    }

    logger.warn('eBay data export: could not parse date', { dateStr });
    return new Date();
  }

  private parsePrice(priceStr: string): MoneyAmount {
    let currency = 'USD';

    if (priceStr.includes('£')) currency = 'GBP';
    else if (priceStr.includes('€')) currency = 'EUR';
    else if (priceStr.includes('$')) currency = 'USD';

    const numericMatch = priceStr.match(/[\d,]+\.?\d*/);
    const amount = numericMatch
      ? parseFloat(numericMatch[0].replace(/,/g, ''))
      : 0;

    return { amount: isNaN(amount) ? 0 : amount, currency };
  }

  private mapCondition(condition?: string): ProductCondition {
    if (!condition) return 'unknown';

    const lower = condition.toLowerCase();
    const conditionId = parseInt(condition, 10);

    // Handle condition IDs
    if (conditionId === 1000) return 'new';
    if (conditionId === 1500) return 'used_like_new';
    if (conditionId === 2000) return 'refurbished';
    if (conditionId === 3000) return 'used_good';
    if (conditionId === 4000) return 'used_acceptable';

    // Handle text conditions
    if (lower.includes('new')) return 'new';
    if (lower.includes('like new')) return 'used_like_new';
    if (lower.includes('very good')) return 'used_very_good';
    if (lower.includes('good')) return 'used_good';
    if (lower.includes('acceptable')) return 'used_acceptable';
    if (lower.includes('refurbished') || lower.includes('certified')) return 'refurbished';
    if (lower.includes('used') || lower.includes('pre-owned')) return 'used_good';

    return 'unknown';
  }

  private calculateConfidence(item: EbayExportItem): number {
    let confidence = 0.75; // Base for data exports

    if (item.itemId && !item.itemId.startsWith('ebay-export-')) confidence += 0.1;
    if (item.price.amount > 0) confidence += 0.05;
    if (item.saleDate) confidence += 0.05;
    if (item.sku) confidence += 0.025;
    if (item.orderId) confidence += 0.025;

    return Math.min(confidence, this.confidenceRange.max);
  }

  private trackParse(success: boolean): void {
    const now = Date.now();
    this.recentParses.push({ success, timestamp: now });

    const oneHourAgo = now - 60 * 60 * 1000;
    this.recentParses = this.recentParses
      .filter(p => p.timestamp > oneHourAgo)
      .slice(-100);
  }
}

// Export singleton instance
export const ebayDataExportAdapter = new EbayDataExportAdapter();
