/**
 * Tests for Data Export Adapters
 *
 * Tests the Tier 2 data source adapters that parse
 * user-exported CSV data from Amazon and eBay.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  AmazonDataExportAdapter,
  amazonDataExportAdapter,
} from '../services/extractors/amazon-data-export-adapter';
import {
  EbayDataExportAdapter,
  ebayDataExportAdapter,
} from '../services/extractors/ebay-data-export-adapter';
import { CHANNEL_CONFIDENCE_DEFAULTS } from '../services/extractors/marketplace-adapter';

// ============================================================================
// Test Fixtures
// ============================================================================

const AMAZON_CSV_FIXTURE = `Order ID,Order Date,Item Name,ASIN,Item Price,Quantity,Seller,Category,Condition,Shipping City,Shipping State,Shipping Postal Code
111-1234567-1234567,01/15/2024,Sony WH-1000XM5 Wireless Headphones,B09XS7JWHH,$348.00,1,Amazon.com,Electronics,New,Seattle,WA,98101
111-7654321-7654321,02/20/2024,Kindle Paperwhite,B08KTZ8249,$139.99,2,Amazon.com,Electronics,New,Portland,OR,97201
111-9876543-9876543,03/05/2024,Used Nintendo Switch Console,B07VGRJDFY,$199.99,1,GameStop,Video Games,Used - Very Good,San Francisco,CA,94102`;

const AMAZON_CSV_WITH_CURRENCY = `Order ID,Order Date,Item Name,ASIN,Item Price,Quantity,Currency
UK-111-1234,01/15/2024,British Tea Set,B012345678,£45.99,1,GBP
EU-222-5678,01/16/2024,German Coffee Maker,B098765432,€89.99,1,EUR`;

const AMAZON_CSV_MISSING_FIELDS = `Order ID,Order Date,Item Name
111-1111111-1111111,01/01/2024,Complete Item
,01/02/2024,Missing Order ID
111-2222222-2222222,,Item Missing Date`;

const EBAY_ORDERS_CSV_FIXTURE = `Sales Record Number,Order Number,Item Number,Item Title,Sale Price,Quantity,Sale Date,Buyer Username,Ship to City,Ship to State,Tracking Number
1001,12-34567-89012,123456789012,Nintendo Switch OLED Console,$299.99,1,01/10/2024,buyer123,Seattle,WA,1Z999AA10123456784
1002,12-34567-89013,234567890123,PlayStation 5 Controller,$69.99,2,01/15/2024,gamer456,Portland,OR,1Z999AA10123456785
1003,12-34567-89014,345678901234,Xbox Series X,$499.99,1,01/20/2024,xboxfan789,Denver,CO,1Z999AA10123456786`;

const EBAY_LISTINGS_CSV_FIXTURE = `Item Number,Title,Start Price,Current Price,Quantity,Quantity Available,Quantity Sold,Format,Duration,Condition,Category,Start Date,End Date,View Item URL,Picture URL
111222333444,Vintage Nintendo 64 Console,$149.99,$149.99,5,3,2,Fixed Price,GTC,Used - Good,Video Games,12/01/2023,12/31/2024,https://www.ebay.com/itm/111222333444,https://example.com/pic1.jpg
222333444555,New PS5 Games Bundle,$199.99,$179.99,10,8,2,Fixed Price,30 Days,New,Video Games,01/01/2024,01/31/2024,https://www.ebay.com/itm/222333444555,https://example.com/pic2.jpg`;

const EBAY_CSV_WITH_SHIPPING = `Sales Record Number,Item Number,Item Title,Sale Price,Shipping and Handling,Quantity,Sale Date
2001,999888777666,Gaming Keyboard,$89.99,$12.99,1,02/01/2024
2002,888777666555,Gaming Mouse,$49.99,$8.99,1,02/05/2024`;

const EBAY_CSV_WITH_CONDITIONS = `Item Number,Title,Condition,Start Price
111,New Item,New,$50.00
222,Like New Item,Like New,$45.00
333,Refurbished Item,Certified - Refurbished,$40.00
444,Good Condition Item,Good,$35.00
555,Condition ID 1000,1000,$30.00
666,Condition ID 3000,3000,$25.00`;

// ============================================================================
// Amazon Data Export Adapter Tests
// ============================================================================

describe('AmazonDataExportAdapter', () => {
  let adapter: AmazonDataExportAdapter;

  beforeEach(() => {
    adapter = new AmazonDataExportAdapter();
  });

  describe('adapter properties', () => {
    it('has correct marketplace ID', () => {
      expect(adapter.marketplaceId).toBe('amazon');
    });

    it('has correct channel and tier', () => {
      expect(adapter.channel).toBe('data_export');
      expect(adapter.tier).toBe(2);
    });

    it('has correct confidence range', () => {
      expect(adapter.confidenceRange).toEqual(CHANNEL_CONFIDENCE_DEFAULTS.data_export);
    });

    it('requires user action', () => {
      expect(adapter.requiresUserAction).toBe(true);
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  describe('canHandle', () => {
    it('handles CSV file paths', () => {
      expect(adapter.canHandle('/path/to/orders.csv')).toBe(true);
      expect(adapter.canHandle('Retail.OrderHistory.1.csv')).toBe(true);
    });

    it('handles CSV content with Amazon headers', () => {
      expect(adapter.canHandle('Order ID,Order Date,Item Name')).toBe(true);
      expect(adapter.canHandle('ASIN,Title,Price')).toBe(true);
    });

    it('rejects non-CSV content', () => {
      expect(adapter.canHandle('https://www.amazon.com/dp/B09XS7JWHH')).toBe(false);
      expect(adapter.canHandle('<html><body>Product page</body></html>')).toBe(false);
    });
  });

  describe('parseCSV', () => {
    it('parses valid Amazon order CSV', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_FIXTURE, 'test.csv');

      expect(result.orders).toHaveLength(3);
      expect(result.totalOrders).toBe(3);
      expect(result.parseErrors).toHaveLength(0);
      expect(result.sourceFile).toBe('test.csv');
    });

    it('extracts correct order data', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_FIXTURE, 'test.csv');
      const [first] = result.orders;

      expect(first.orderId).toBe('111-1234567-1234567');
      expect(first.itemName).toBe('Sony WH-1000XM5 Wireless Headphones');
      expect(first.asin).toBe('B09XS7JWHH');
      expect(first.unitPrice.amount).toBe(348);
      expect(first.unitPrice.currency).toBe('USD');
      expect(first.quantity).toBe(1);
      expect(first.seller).toBe('Amazon.com');
      expect(first.category).toBe('Electronics');
      expect(first.condition).toBe('New');
    });

    it('parses shipping address', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_FIXTURE, 'test.csv');
      const [first] = result.orders;

      expect(first.shippingAddress).toEqual({
        city: 'Seattle',
        state: 'WA',
        postalCode: '98101',
      });
    });

    it('calculates date range correctly', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_FIXTURE, 'test.csv');

      expect(result.dateRange.earliest).toBeDefined();
      expect(result.dateRange.latest).toBeDefined();
      expect(result.dateRange.earliest!.getTime()).toBeLessThanOrEqual(
        result.dateRange.latest!.getTime()
      );
    });

    it('handles different currencies', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_WITH_CURRENCY, 'test.csv');

      expect(result.orders[0].unitPrice.currency).toBe('GBP');
      expect(result.orders[0].unitPrice.amount).toBe(45.99);
      expect(result.orders[1].unitPrice.currency).toBe('EUR');
      expect(result.orders[1].unitPrice.amount).toBe(89.99);
    });

    it('handles rows with missing fields', async () => {
      const result = await adapter.parseCSV(AMAZON_CSV_MISSING_FIELDS, 'test.csv');

      // Should still parse rows with partial data
      expect(result.orders.length).toBeGreaterThan(0);
      // Rows missing item names should be skipped
      const completedOrder = result.orders.find(o => o.itemName === 'Complete Item');
      expect(completedOrder).toBeDefined();
    });

    it('returns empty result for invalid CSV', async () => {
      const result = await adapter.parseCSV('not,valid\ncsv', 'invalid.csv');

      // Should handle gracefully
      expect(result.orders).toHaveLength(0);
    });
  });

  describe('extract', () => {
    it('extracts first order as MarketplaceListing', async () => {
      const listing = await adapter.extract(AMAZON_CSV_FIXTURE, 'test.csv');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('amazon');
      expect(listing!.title).toBe('Sony WH-1000XM5 Wireless Headphones');
      expect(listing!.price.amount).toBe(348);
      expect(listing!.availability).toBe('sold');
    });

    it('returns null for empty CSV', async () => {
      const listing = await adapter.extract('Order ID,Item Name\n', 'empty.csv');
      expect(listing).toBeNull();
    });
  });

  describe('extractWithProvenance', () => {
    it('includes provenance data', async () => {
      const result = await adapter.extractWithProvenance(AMAZON_CSV_FIXTURE, 'test.csv');

      expect(result).not.toBeNull();
      expect(result!.provenance).toBeDefined();
      expect(result!.provenance.channel).toBe('data_export');
      expect(result!.provenance.tier).toBe(2);
      expect(result!.provenance.userConsented).toBe(true);
      expect(result!.provenance.termsCompliant).toBe(true);
      expect(result!.provenance.freshness).toBe('historical');
    });
  });

  describe('extractAllWithProvenance', () => {
    it('extracts all orders with provenance', async () => {
      const results = await adapter.extractAllWithProvenance(AMAZON_CSV_FIXTURE, 'test.csv');

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.provenance).toBeDefined();
        expect(result.provenance.channel).toBe('data_export');
        expect(result.provenance.termsCompliant).toBe(true);
      });
    });
  });

  describe('validate', () => {
    it('validates complete listing', async () => {
      const listing = await adapter.extract(AMAZON_CSV_FIXTURE, 'test.csv');
      const validation = adapter.validate(listing!);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('catches missing title', () => {
      const invalidListing = {
        id: 'test',
        marketplace: 'amazon' as const,
        url: 'https://amazon.com',
        title: '',
        confidence: 0.8,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'test',
      };

      const validation = adapter.validate(invalidListing);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing item name');
    });
  });

  describe('health monitoring', () => {
    it('reports available status', async () => {
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it('returns health status', async () => {
      const health = await adapter.getHealth();

      expect(health.available).toBe(true);
      expect(health.statusMessage).toContain('always available');
    });

    it('tracks successful parses', async () => {
      await adapter.extractWithProvenance(AMAZON_CSV_FIXTURE, 'test.csv');
      const health = await adapter.getHealth();

      expect(health.lastSuccessfulExtraction).toBeDefined();
      expect(health.recentFailureRate).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('returns valid configuration', () => {
      const config = adapter.getConfig();

      expect(config.marketplaceId).toBe('amazon');
      expect(config.enabled).toBe(true);
      expect(config.rendering.requiresJavaScript).toBe(false);
      expect(config.quality.requiredFields).toContain('title');
    });
  });
});

describe('amazonDataExportAdapter singleton', () => {
  it('is an instance of AmazonDataExportAdapter', () => {
    expect(amazonDataExportAdapter).toBeInstanceOf(AmazonDataExportAdapter);
  });
});

// ============================================================================
// eBay Data Export Adapter Tests
// ============================================================================

describe('EbayDataExportAdapter', () => {
  let adapter: EbayDataExportAdapter;

  beforeEach(() => {
    adapter = new EbayDataExportAdapter();
  });

  describe('adapter properties', () => {
    it('has correct marketplace ID', () => {
      expect(adapter.marketplaceId).toBe('ebay');
    });

    it('has correct channel and tier', () => {
      expect(adapter.channel).toBe('data_export');
      expect(adapter.tier).toBe(2);
    });

    it('has correct confidence range', () => {
      expect(adapter.confidenceRange).toEqual(CHANNEL_CONFIDENCE_DEFAULTS.data_export);
    });

    it('requires user action', () => {
      expect(adapter.requiresUserAction).toBe(true);
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  describe('canHandle', () => {
    it('handles CSV file paths', () => {
      expect(adapter.canHandle('/path/to/ebay-orders.csv')).toBe(true);
      expect(adapter.canHandle('sales_report.csv')).toBe(true);
    });

    it('handles CSV content with eBay headers', () => {
      expect(adapter.canHandle('Sales Record Number,Item Title')).toBe(true);
      expect(adapter.canHandle('Item Number,Buyer Username')).toBe(true);
      expect(adapter.canHandle('eBay Item Number,Ship to')).toBe(true);
    });

    it('rejects non-CSV content', () => {
      expect(adapter.canHandle('https://www.ebay.com/itm/123456')).toBe(false);
      expect(adapter.canHandle('<html><body>eBay item</body></html>')).toBe(false);
    });
  });

  describe('parseCSV - orders export', () => {
    it('parses valid eBay orders CSV', async () => {
      const result = await adapter.parseCSV(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      expect(result.items).toHaveLength(3);
      expect(result.totalItems).toBe(3);
      expect(result.exportType).toBe('orders');
      expect(result.parseErrors).toHaveLength(0);
    });

    it('extracts correct order data', async () => {
      const result = await adapter.parseCSV(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');
      const [first] = result.items;

      expect(first.itemId).toBe('123456789012');
      expect(first.orderId).toBe('1001');
      expect(first.title).toBe('Nintendo Switch OLED Console');
      expect(first.price.amount).toBe(299.99);
      expect(first.price.currency).toBe('USD');
      expect(first.quantity).toBe(1);
      expect(first.buyer).toBe('buyer123');
      expect(first.trackingNumber).toBe('1Z999AA10123456784');
    });

    it('calculates date range', async () => {
      const result = await adapter.parseCSV(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      expect(result.dateRange.earliest).toBeDefined();
      expect(result.dateRange.latest).toBeDefined();
    });
  });

  describe('parseCSV - listings export', () => {
    it('parses valid eBay listings CSV', async () => {
      const result = await adapter.parseCSV(EBAY_LISTINGS_CSV_FIXTURE, 'listings.csv');

      expect(result.items).toHaveLength(2);
      expect(result.exportType).toBe('listings');
      expect(result.parseErrors).toHaveLength(0);
    });

    it('extracts listing-specific fields', async () => {
      const result = await adapter.parseCSV(EBAY_LISTINGS_CSV_FIXTURE, 'listings.csv');
      const [first] = result.items;

      expect(first.itemId).toBe('111222333444');
      expect(first.title).toBe('Vintage Nintendo 64 Console');
      expect(first.price.amount).toBe(149.99);
      expect(first.condition).toBe('Used - Good');
      expect(first.category).toBe('Video Games');
      expect(first.imageUrl).toBe('https://example.com/pic1.jpg');
      expect(first.url).toBe('https://www.ebay.com/itm/111222333444');
    });
  });

  describe('parseCSV - shipping costs', () => {
    it('parses shipping costs correctly', async () => {
      const result = await adapter.parseCSV(EBAY_CSV_WITH_SHIPPING, 'shipping.csv');
      const [first] = result.items;

      expect(first.price.amount).toBe(89.99);
      expect(first.shippingCost).toBeDefined();
      expect(first.shippingCost!.amount).toBe(12.99);
    });
  });

  describe('parseCSV - condition mapping', () => {
    it('maps text conditions correctly', async () => {
      const result = await adapter.parseCSV(EBAY_CSV_WITH_CONDITIONS, 'conditions.csv');

      const findByTitle = (title: string) =>
        result.items.find(i => i.title === title);

      // Check that conditions are extracted (mapping happens in exportItemToListing)
      expect(findByTitle('New Item')?.condition).toBe('New');
      expect(findByTitle('Like New Item')?.condition).toBe('Like New');
      expect(findByTitle('Refurbished Item')?.condition).toBe('Certified - Refurbished');
      expect(findByTitle('Good Condition Item')?.condition).toBe('Good');
    });
  });

  describe('extract', () => {
    it('extracts first item as MarketplaceListing', async () => {
      const listing = await adapter.extract(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('ebay');
      expect(listing!.title).toBe('Nintendo Switch OLED Console');
      expect(listing!.price.amount).toBe(299.99);
      expect(listing!.itemNumber).toBe('123456789012');
    });

    it('returns null for empty CSV', async () => {
      const listing = await adapter.extract('Item Number,Title\n', 'empty.csv');
      expect(listing).toBeNull();
    });
  });

  describe('extractWithProvenance', () => {
    it('includes provenance data', async () => {
      const result = await adapter.extractWithProvenance(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      expect(result).not.toBeNull();
      expect(result!.provenance).toBeDefined();
      expect(result!.provenance.channel).toBe('data_export');
      expect(result!.provenance.tier).toBe(2);
      expect(result!.provenance.userConsented).toBe(true);
      expect(result!.provenance.termsCompliant).toBe(true);
      expect(result!.provenance.freshness).toBe('historical');
      expect(result!.provenance.metadata?.exportType).toBe('eBay Seller Hub');
    });
  });

  describe('extractAllWithProvenance', () => {
    it('extracts all items with provenance', async () => {
      const results = await adapter.extractAllWithProvenance(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.provenance).toBeDefined();
        expect(result.provenance.channel).toBe('data_export');
        expect(result.provenance.termsCompliant).toBe(true);
        expect(result.provenance.metadata?.exportType).toBe('orders');
      });
    });
  });

  describe('validate', () => {
    it('validates complete listing', async () => {
      const listing = await adapter.extract(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');
      const validation = adapter.validate(listing!);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('catches missing title', () => {
      const invalidListing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'https://ebay.com',
        title: '',
        confidence: 0.8,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'test',
      };

      const validation = adapter.validate(invalidListing);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing item title');
    });

    it('warns on missing item number', () => {
      const listing = {
        id: 'test',
        marketplace: 'ebay' as const,
        url: 'https://ebay.com',
        title: 'Test Item',
        confidence: 0.8,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'test',
        itemNumber: undefined,
      };

      const validation = adapter.validate(listing);
      expect(validation.warnings).toContain('Missing eBay item number');
    });
  });

  describe('health monitoring', () => {
    it('reports available status', async () => {
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it('returns health status', async () => {
      const health = await adapter.getHealth();

      expect(health.available).toBe(true);
      expect(health.statusMessage).toContain('always available');
    });

    it('tracks successful parses', async () => {
      await adapter.extractWithProvenance(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');
      const health = await adapter.getHealth();

      expect(health.lastSuccessfulExtraction).toBeDefined();
      expect(health.recentFailureRate).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('returns valid configuration', () => {
      const config = adapter.getConfig();

      expect(config.marketplaceId).toBe('ebay');
      expect(config.enabled).toBe(true);
      expect(config.rendering.requiresJavaScript).toBe(false);
      expect(config.quality.requiredFields).toContain('title');
    });
  });

  describe('confidence calculation', () => {
    it('calculates higher confidence for complete data', async () => {
      const results = await adapter.extractAllWithProvenance(EBAY_ORDERS_CSV_FIXTURE, 'orders.csv');

      // Items with item IDs, prices, sale dates should have higher confidence
      results.forEach(result => {
        expect(result.confidence).toBeGreaterThanOrEqual(0.75); // Base
        expect(result.confidence).toBeLessThanOrEqual(adapter.confidenceRange.max);
      });
    });
  });
});

describe('ebayDataExportAdapter singleton', () => {
  it('is an instance of EbayDataExportAdapter', () => {
    expect(ebayDataExportAdapter).toBeInstanceOf(EbayDataExportAdapter);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Data Export Adapters Integration', () => {
  it('both adapters have consistent interface', () => {
    const amazon = amazonDataExportAdapter;
    const ebay = ebayDataExportAdapter;

    // Same channel and tier
    expect(amazon.channel).toBe(ebay.channel);
    expect(amazon.tier).toBe(ebay.tier);

    // Both require user action
    expect(amazon.requiresUserAction).toBe(ebay.requiresUserAction);

    // Same confidence range
    expect(amazon.confidenceRange).toEqual(ebay.confidenceRange);
  });

  it('both adapters report same tier compliance', async () => {
    const amazonProvenance = await amazonDataExportAdapter.extractWithProvenance(
      AMAZON_CSV_FIXTURE,
      'amazon.csv'
    );
    const ebayProvenance = await ebayDataExportAdapter.extractWithProvenance(
      EBAY_ORDERS_CSV_FIXTURE,
      'ebay.csv'
    );

    expect(amazonProvenance!.provenance.tier).toBe(2);
    expect(ebayProvenance!.provenance.tier).toBe(2);
    expect(amazonProvenance!.provenance.termsCompliant).toBe(true);
    expect(ebayProvenance!.provenance.termsCompliant).toBe(true);
  });

  it('both adapters are always available', async () => {
    expect(await amazonDataExportAdapter.isAvailable()).toBe(true);
    expect(await ebayDataExportAdapter.isAvailable()).toBe(true);
  });
});
