/**
 * Amazon Data Export Adapter
 *
 * Parses Amazon Privacy Central data exports (ZIP/CSV files).
 * This is a Tier 2 (authenticated user context) data source.
 *
 * Users request their data from:
 * https://www.amazon.com/hz/privacy-central/data-requests/preview.html
 *
 * The export contains a ZIP with multiple CSV files including:
 * - Retail.OrderHistory.1.csv (or .2)
 * - Retail.OrderHistory.Refunds.csv
 * - Digital.Orders.csv
 *
 * @module extractors/amazon-data-export-adapter
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
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw order row from Amazon CSV export
 */
export interface AmazonOrderRow {
  // Common fields (names may vary)
  'Order ID'?: string;
  'Order Date'?: string;
  'Purchase Date'?: string;
  'Ship Date'?: string;
  'Item Name'?: string;
  'Product Name'?: string;
  'Title'?: string;
  'Item Price'?: string;
  'Total Owed'?: string;
  'Total Charged'?: string;
  'Unit Price'?: string;
  'Quantity'?: string;
  'Shipping Address'?: string;
  'Shipping City'?: string;
  'Shipping State'?: string;
  'Shipping Postal Code'?: string;
  'Payment Method'?: string;
  'Seller'?: string;
  'Seller Name'?: string;
  'Category'?: string;
  'ASIN'?: string;
  'UNSPSC Code'?: string;
  'Website'?: string;
  'Condition'?: string;
  'Currency'?: string;
  // Allow any other fields
  [key: string]: string | undefined;
}

/**
 * Normalized Amazon order item
 */
export interface AmazonOrderItem {
  orderId: string;
  orderDate: Date;
  shipDate?: Date;
  itemName: string;
  asin?: string;
  unitPrice: MoneyAmount;
  quantity: number;
  totalPrice: MoneyAmount;
  seller?: string;
  category?: string;
  condition?: string;
  shippingAddress?: {
    city?: string;
    state?: string;
    postalCode?: string;
  };
  rawRow: AmazonOrderRow;
}

/**
 * Result of parsing an Amazon data export
 */
export interface AmazonDataExportResult {
  orders: AmazonOrderItem[];
  totalOrders: number;
  dateRange: {
    earliest?: Date;
    latest?: Date;
  };
  parseErrors: string[];
  sourceFile: string;
}

// ============================================================================
// Amazon Data Export Adapter
// ============================================================================

export class AmazonDataExportAdapter implements DataSourceAdapter {
  // MarketplaceAdapter properties
  readonly marketplaceId = 'amazon' as const;
  readonly name = 'Amazon Data Export Adapter';
  readonly version = '1.0.0';

  // DataSourceAdapter properties
  readonly channel: DataSourceChannel = 'data_export';
  readonly tier: DataSourceTier = 2;
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.data_export;
  readonly requiresUserAction = true; // User must request and upload their data

  // Health tracking
  private lastSuccessfulParse?: string;
  private recentParses: { success: boolean; timestamp: number }[] = [];

  // =========================================================================
  // MarketplaceAdapter Interface
  // =========================================================================

  /**
   * Check if this adapter can handle the given input
   * For data exports, we check if it's a CSV file path or CSV content
   */
  canHandle(input: string): boolean {
    // Check if it's a file path ending in .csv
    if (input.endsWith('.csv')) {
      return true;
    }

    // Check if it looks like CSV content with Amazon-specific headers
    const amazonHeaders = [
      'Order ID',
      'Order Date',
      'Item Name',
      'ASIN',
      'Retail.OrderHistory',
    ];

    return amazonHeaders.some(header =>
      input.toLowerCase().includes(header.toLowerCase())
    );
  }

  /**
   * Extract orders from CSV content
   */
  async extract(
    content: string,
    source: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    // For data exports, we typically extract multiple items
    // This returns the first item for interface compatibility
    const result = await this.parseCSV(content, source);

    if (result.orders.length === 0) {
      return null;
    }

    return this.orderItemToListing(result.orders[0], source);
  }

  /**
   * Validate a listing
   */
  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!listing.title) {
      errors.push('Missing item name');
    }

    if (!listing.price) {
      warnings.push('Missing price information');
    }

    if (!listing.id || listing.id.startsWith('amazon-export-')) {
      warnings.push('No Amazon Order ID found');
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

  /**
   * Get adapter configuration
   */
  getConfig(): MarketplaceConfig {
    return {
      marketplaceId: 'amazon',
      enabled: true,
      rendering: {
        requiresJavaScript: false, // CSV parsing, no rendering needed
      },
      rateLimit: {
        requestsPerSecond: 100, // Local parsing, no rate limit
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
        respectRobotsTxt: false, // Not applicable for local files
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

  /**
   * Extract all orders with provenance tracking
   */
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
      freshness: 'historical', // Data exports are always historical
      sourceId: `${this.name}/${this.version}`,
      extractedAt: new Date().toISOString(),
      userConsented: true, // User explicitly requested and uploaded their data
      termsCompliant: true, // Using official data export is fully compliant
      metadata: {
        sourceFile: source,
        exportType: 'Amazon Privacy Central',
      },
    };

    return {
      ...listing,
      provenance,
    };
  }

  /**
   * Check availability (always available for local parsing)
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Get health status
   */
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

  /**
   * Parse CSV content and extract all orders
   */
  async parseCSV(content: string, source: string): Promise<AmazonDataExportResult> {
    const parseErrors: string[] = [];
    const orders: AmazonOrderItem[] = [];

    try {
      // Parse CSV
      const records = csvParse(content, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true,
      }) as AmazonOrderRow[];

      logger.debug('Amazon data export: parsed CSV', {
        source,
        rowCount: records.length,
      });

      for (let i = 0; i < records.length; i++) {
        try {
          const order = this.parseOrderRow(records[i], i);
          if (order) {
            orders.push(order);
          }
        } catch (error) {
          parseErrors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // Calculate date range
      const dates = orders
        .map(o => o.orderDate)
        .filter(d => d && !isNaN(d.getTime()));

      const dateRange = {
        earliest: dates.length > 0 ? new Date(Math.min(...dates.map(d => d.getTime()))) : undefined,
        latest: dates.length > 0 ? new Date(Math.max(...dates.map(d => d.getTime()))) : undefined,
      };

      logger.info('Amazon data export: extraction complete', {
        source,
        totalRows: records.length,
        extractedOrders: orders.length,
        parseErrors: parseErrors.length,
        dateRange: dateRange.earliest && dateRange.latest
          ? `${dateRange.earliest.toISOString()} to ${dateRange.latest.toISOString()}`
          : 'unknown',
      });

      return {
        orders,
        totalOrders: orders.length,
        dateRange,
        parseErrors,
        sourceFile: source,
      };
    } catch (error) {
      logger.error('Amazon data export: CSV parse failed', { source, error });
      return {
        orders: [],
        totalOrders: 0,
        dateRange: {},
        parseErrors: [`Failed to parse CSV: ${error instanceof Error ? error.message : 'Unknown error'}`],
        sourceFile: source,
      };
    }
  }

  /**
   * Parse a CSV file from disk
   */
  async parseFile(filePath: string): Promise<AmazonDataExportResult> {
    try {
      const content = await readFile(filePath, 'utf-8');
      return this.parseCSV(content, filePath);
    } catch (error) {
      logger.error('Amazon data export: file read failed', { filePath, error });
      return {
        orders: [],
        totalOrders: 0,
        dateRange: {},
        parseErrors: [`Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`],
        sourceFile: filePath,
      };
    }
  }

  /**
   * Extract all orders as listings with provenance
   */
  async extractAllWithProvenance(
    content: string,
    source: string
  ): Promise<MarketplaceListingWithProvenance[]> {
    const result = await this.parseCSV(content, source);
    const listings: MarketplaceListingWithProvenance[] = [];

    for (const order of result.orders) {
      const listing = this.orderItemToListing(order, source);

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
          orderId: order.orderId,
          orderDate: order.orderDate.toISOString(),
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

  /**
   * Parse a single order row from CSV
   */
  private parseOrderRow(row: AmazonOrderRow, index: number): AmazonOrderItem | null {
    // Get order ID (various possible column names)
    const orderId = row['Order ID'] || row['OrderId'] || row['order_id'] || `amazon-export-${index}`;

    // Get item name (various possible column names)
    const itemName =
      row['Item Name'] ||
      row['Product Name'] ||
      row['Title'] ||
      row['item_name'] ||
      row['product_name'];

    if (!itemName) {
      return null; // Skip rows without item names
    }

    // Get order date
    const dateStr =
      row['Order Date'] ||
      row['Purchase Date'] ||
      row['order_date'] ||
      row['purchase_date'];

    const orderDate = dateStr ? this.parseDate(dateStr) : new Date();

    // Get ship date
    const shipDateStr = row['Ship Date'] || row['ship_date'];
    const shipDate = shipDateStr ? this.parseDate(shipDateStr) : undefined;

    // Get price
    const priceStr =
      row['Item Price'] ||
      row['Unit Price'] ||
      row['Total Owed'] ||
      row['Total Charged'] ||
      row['item_price'] ||
      row['unit_price'];

    const { amount, currency } = this.parsePrice(priceStr || '0');

    // Get quantity
    const quantityStr = row['Quantity'] || row['quantity'] || '1';
    const quantity = parseInt(quantityStr, 10) || 1;

    // Get total price
    const totalStr = row['Total Charged'] || row['Total Owed'] || priceStr || '0';
    const total = this.parsePrice(totalStr);

    // Get seller
    const seller = row['Seller'] || row['Seller Name'] || row['seller'] || undefined;

    // Get ASIN
    const asin = row['ASIN'] || row['asin'] || undefined;

    // Get category
    const category = row['Category'] || row['category'] || undefined;

    // Get condition
    const condition = row['Condition'] || row['condition'] || undefined;

    // Get shipping address
    const shippingAddress = row['Shipping City'] || row['Shipping State']
      ? {
          city: row['Shipping City'],
          state: row['Shipping State'],
          postalCode: row['Shipping Postal Code'],
        }
      : undefined;

    return {
      orderId,
      orderDate,
      shipDate,
      itemName,
      asin,
      unitPrice: { amount, currency },
      quantity,
      totalPrice: total,
      seller,
      category,
      condition,
      shippingAddress,
      rawRow: row,
    };
  }

  /**
   * Convert an order item to a MarketplaceListing
   */
  private orderItemToListing(order: AmazonOrderItem, source: string): MarketplaceListing {
    return {
      id: order.orderId,
      marketplace: 'amazon',
      url: order.asin
        ? `https://www.amazon.com/dp/${order.asin}`
        : `https://www.amazon.com/gp/your-account/order-details?orderID=${order.orderId}`,
      title: order.itemName,
      price: order.totalPrice,
      condition: this.mapCondition(order.condition),
      availability: 'sold', // All data export items are past purchases
      soldDate: order.orderDate.toISOString().split('T')[0],
      seller: {
        name: order.seller || null,
      },
      images: [],
      itemNumber: order.asin || order.orderId,
      category: order.category ? [order.category] : undefined,
      extractedAt: new Date().toISOString(),
      extractionMethod: `${this.name} v${this.version}`,
      confidence: this.calculateConfidence(order),
      extractorVersion: this.version,
      attributes: {
        quantity: order.quantity,
        unitPrice: order.unitPrice,
        sourceFile: source,
      },
    };
  }

  /**
   * Parse a date string from Amazon export
   */
  private parseDate(dateStr: string): Date {
    // Try ISO first
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }

    // Try US format MM/DD/YYYY
    const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) {
      return new Date(parseInt(usMatch[3]), parseInt(usMatch[1]) - 1, parseInt(usMatch[2]));
    }

    // Default to current date if parsing fails
    logger.warn('Amazon data export: could not parse date', { dateStr });
    return new Date();
  }

  /**
   * Parse a price string
   */
  private parsePrice(priceStr: string): MoneyAmount {
    let currency = 'USD';

    // Detect currency
    if (priceStr.includes('£')) currency = 'GBP';
    else if (priceStr.includes('€')) currency = 'EUR';
    else if (priceStr.includes('$')) currency = 'USD';

    // Extract numeric value
    const numericMatch = priceStr.match(/[\d,]+\.?\d*/);
    const amount = numericMatch
      ? parseFloat(numericMatch[0].replace(/,/g, ''))
      : 0;

    return { amount: isNaN(amount) ? 0 : amount, currency };
  }

  /**
   * Map condition string to standard format
   */
  private mapCondition(condition?: string): MarketplaceListing['condition'] {
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
   * Calculate confidence score for an extracted order
   */
  private calculateConfidence(order: AmazonOrderItem): number {
    let confidence = 0.7; // Base confidence for data exports

    // Boost for having key fields
    if (order.asin) confidence += 0.1;
    if (order.orderId && !order.orderId.startsWith('amazon-export-')) confidence += 0.1;
    if (order.totalPrice.amount > 0) confidence += 0.05;
    if (order.seller) confidence += 0.05;

    return Math.min(confidence, this.confidenceRange.max);
  }

  /**
   * Track parse attempts for health monitoring
   */
  private trackParse(success: boolean): void {
    const now = Date.now();
    this.recentParses.push({ success, timestamp: now });

    // Keep only last 100 or last hour
    const oneHourAgo = now - 60 * 60 * 1000;
    this.recentParses = this.recentParses
      .filter(p => p.timestamp > oneHourAgo)
      .slice(-100);
  }
}

// Export singleton instance
export const amazonDataExportAdapter = new AmazonDataExportAdapter();
