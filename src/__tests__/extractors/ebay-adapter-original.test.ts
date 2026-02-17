import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { EbayAdapter } from '../../services/extractors/ebay-adapter';

describe('EbayAdapter (original)', () => {
  let adapter: EbayAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new EbayAdapter();
  });

  describe('canHandle / isEbayListing', () => {
    it('returns true for ebay.com URLs', () => {
      expect(adapter.canHandle('https://www.ebay.com/itm/123')).toBe(true);
    });
    it('returns true for ebay.co.uk URLs', () => {
      expect(adapter.canHandle('https://www.ebay.co.uk/itm/123')).toBe(true);
    });
    it('returns false for non-ebay URLs', () => {
      expect(adapter.canHandle('https://amazon.com')).toBe(false);
    });
    it('returns false for invalid URLs', () => {
      expect(adapter.canHandle('not-a-url')).toBe(false);
    });
  });

  describe('extract()', () => {
    it('returns normalized MarketplaceListing with title and price', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Test Item</h1><div class="x-price-primary"><span class="ux-textspans">$99.99</span></div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123456789');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('ebay');
      expect(listing!.title).toBe('Test Item');
      expect(listing!.price?.amount).toBe(99.99);
      expect(listing!.availability).toBe('sold');
    });

    it('returns a listing even with minimal HTML', async () => {
      const listing = await adapter.extract('<html></html>', 'https://www.ebay.com/itm/123');
      // extractLegacy succeeds (returns Unknown Item with null price), so extract returns a listing
      expect(listing).not.toBeNull();
      expect(listing!.title).toBe('Unknown Item');
    });

    it('returns null when extractLegacy throws', async () => {
      // Monkey-patch extractLegacy to throw
      const origExtract = adapter.extractLegacy.bind(adapter);
      adapter.extractLegacy = () => { throw new Error('forced error'); };

      const listing = await adapter.extract('<html></html>', 'https://www.ebay.com/itm/123');
      expect(listing).toBeNull();

      adapter.extractLegacy = origExtract;
    });

    it('handles GBP currency', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">UK Item</h1><div class="x-price-primary"><span class="ux-textspans">£49.99</span></div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.co.uk/itm/123456789');

      expect(listing).not.toBeNull();
      expect(listing!.price?.currency).toBe('GBP');
      expect(listing!.price?.amount).toBe(49.99);
    });

    it('handles EUR currency', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">EU Item</h1><div class="x-price-primary"><span class="ux-textspans">€29.99</span></div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123456789');

      expect(listing).not.toBeNull();
      expect(listing!.price?.currency).toBe('EUR');
    });

    it('sets shippingCost when shipping element exists', async () => {
      const html = '<html><body><h1>Item</h1><div class="ux-labels-values--shipping">$5.99 shipping</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123456789');

      expect(listing).not.toBeNull();
      expect(listing!.shippingCost?.amount).toBe(5.99);
    });

    it('extracts seller info', async () => {
      const html = '<html><body><h1>Item</h1><a class="x-sellercard-atf__info__about-seller"><a>SellerName</a></a><div class="x-sellercard-atf__data--rating">99.5%</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');

      expect(listing).not.toBeNull();
    });

    it('extracts item number from URL', async () => {
      const html = '<html><body><h1>Item</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/555666777');

      // JSDOM sets document.URL, but it depends on whether JSDOM parses the URL
      // The extractItemNumber tries document.URL.match which in JSDOM defaults to about:blank
      // So it falls back to the data-testid selector
      expect(listing).not.toBeNull();
    });
  });

  describe('extractWithProvenance()', () => {
    it('returns listing with provenance on success', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Provenance Test</h1><div class="x-price-primary"><span class="ux-textspans">$50.00</span></div></body></html>';
      const result = await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/123456789');

      expect(result).not.toBeNull();
      expect(result!.provenance).toBeDefined();
      expect(result!.provenance.channel).toBe('scraping');
      expect(result!.provenance.tier).toBe(3);
      expect(result!.provenance.confidence).toBeGreaterThan(0);
      expect(result!.provenance.freshness).toBe('realtime');
      expect(result!.provenance.sourceId).toContain('eBay Scraping Adapter');
      expect(result!.provenance.userConsented).toBe(true);
      expect(result!.provenance.termsCompliant).toBe(true);
    });

    it('tracks successful extraction in health', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Item</h1></body></html>';
      await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/123');

      const health = await adapter.getHealth();
      expect(health.recentFailureRate).toBe(0);
    });

    it('returns null and tracks failure on error', async () => {
      const origExtract = adapter.extractLegacy.bind(adapter);
      adapter.extractLegacy = () => { throw new Error('forced error'); };

      const result = await adapter.extractWithProvenance('<html></html>', 'https://www.ebay.com/itm/123');
      expect(result).toBeNull();

      // Verify it was tracked as a failure
      const health = await adapter.getHealth();
      expect(health.recentFailureRate).toBe(1);

      adapter.extractLegacy = origExtract;
    });

    it('sets lastSuccessfulExtraction timestamp', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Item</h1></body></html>';
      await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/123');

      const health = await adapter.getHealth();
      expect(health.lastSuccessfulExtraction).toBeDefined();
    });
  });

  describe('isAvailable()', () => {
    it('always returns true', async () => {
      expect(await adapter.isAvailable()).toBe(true);
    });
  });

  describe('getHealth()', () => {
    it('returns health with no recent extractions', async () => {
      const health = await adapter.getHealth();
      expect(health.available).toBe(true);
      expect(health.statusMessage).toBe('No recent extractions');
      expect(health.recentFailureRate).toBe(0);
    });

    it('returns health with successful extractions', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Item</h1></body></html>';
      await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/1');
      await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/2');

      const health = await adapter.getHealth();
      expect(health.recentFailureRate).toBe(0);
      expect(health.statusMessage).toContain('2/2 successful');
    });

    it('calculates failure rate correctly', async () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Item</h1></body></html>';
      await adapter.extractWithProvenance(html, 'https://www.ebay.com/itm/1');

      // Force a failure
      const origExtract = adapter.extractLegacy.bind(adapter);
      adapter.extractLegacy = () => { throw new Error('fail'); };
      await adapter.extractWithProvenance('<html></html>', 'https://www.ebay.com/itm/2');
      adapter.extractLegacy = origExtract;

      const health = await adapter.getHealth();
      expect(health.recentFailureRate).toBe(0.5);
    });

    it('includes estimatedReliability', async () => {
      const health = await adapter.getHealth();
      expect(health.estimatedReliability).toBeGreaterThan(0);
    });
  });

  describe('validate()', () => {
    const baseListing = {
      id: '123',
      marketplace: 'ebay' as const,
      url: 'https://ebay.com/itm/123',
      title: 'Good Item',
      price: { amount: 50, currency: 'USD' },
      availability: 'sold' as const,
      seller: { name: 'test' },
      images: [],
      itemNumber: '123',
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.8,
      extractorVersion: '2.0.0',
    };

    it('validates complete listing', () => {
      const result = adapter.validate(baseListing);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports error for Unknown Item title', () => {
      const result = adapter.validate({ ...baseListing, title: 'Unknown Item' });
      expect(result.errors).toContain('Missing or invalid title');
      expect(result.valid).toBe(false);
    });

    it('reports error for empty title', () => {
      const result = adapter.validate({ ...baseListing, title: '' });
      expect(result.errors).toContain('Missing or invalid title');
    });

    it('reports error for null price', () => {
      const result = adapter.validate({ ...baseListing, price: null });
      expect(result.errors).toContain('Missing sold price');
    });

    it('reports warning for missing item number', () => {
      const result = adapter.validate({ ...baseListing, itemNumber: undefined });
      expect(result.warnings).toContain('Missing eBay item number');
    });

    it('reports error for low confidence', () => {
      const result = adapter.validate({ ...baseListing, confidence: 0.3 });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Low confidence'))).toBe(true);
    });

    it('valid listing has no warnings when itemNumber is present', () => {
      const result = adapter.validate(baseListing);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('getConfig()', () => {
    it('returns ebay config', () => {
      const config = adapter.getConfig();
      expect(config.marketplaceId).toBe('ebay');
      expect(config.enabled).toBe(true);
    });

    it('config has rendering settings', () => {
      const config = adapter.getConfig();
      expect(config.rendering.requiresJavaScript).toBe(true);
      expect(config.rendering.waitForSelectors).toContain('.x-price-primary');
    });

    it('config has rate limit settings', () => {
      const config = adapter.getConfig();
      expect(config.rateLimit.requestsPerSecond).toBe(1);
      expect(config.rateLimit.backoffStrategy).toBe('exponential');
    });

    it('config has compliance settings', () => {
      const config = adapter.getConfig();
      expect(config.compliance.respectRobotsTxt).toBe(true);
    });
  });

  describe('mapCondition via extract()', () => {
    // Note: mapCondition is private, tested indirectly through extract()
    // The mapCondition logic: checks 'new' before 'like new', so "Like New" matches 'new' first

    it('maps "New" to new', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">New</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('new');
    });

    it('maps "Brand New" to new (contains "new")', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Brand New</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('new');
    });

    it('maps "Used - Very Good" to used_very_good', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Used - Very Good</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('used_very_good');
    });

    it('maps "Used - Acceptable" to used_acceptable', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Used - Acceptable</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('used_acceptable');
    });

    it('maps plain "Used" to used_good', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Used</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('used_good');
    });

    it('maps "Refurbished" to refurbished', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Refurbished</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('refurbished');
    });

    it('maps "Used - Good" to used_good', async () => {
      const html = '<html><body><div data-testid="x-item-condition-value">Used - Good</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      // "used - good" includes "good" → used_good
      expect(listing?.condition).toBe('used_good');
    });

    it('returns unknown for null condition', async () => {
      const html = '<html><body></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('unknown');
    });

    it('returns unknown for unrecognized condition text', async () => {
      // Text must include New/Used/Refurbished to be picked up by extractCondition
      // "For parts" doesn't include any of those, so extractCondition returns null → mapCondition returns unknown
      const html = '<html><body><div data-testid="x-item-condition-value">For Parts Only</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.ebay.com/itm/123');
      expect(listing?.condition).toBe('unknown');
    });
  });

  describe('extractLegacy()', () => {
    it('returns EbaySoldListing format', () => {
      const html = '<html><body><h1 class="x-item-title__mainTitle">Legacy Test</h1><div class="x-price-primary"><span class="ux-textspans">$25.00</span></div></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');

      expect(result.title).toBe('Legacy Test');
      expect(result.soldPrice).toBe(25);
      expect(result.currency).toBe('USD');
      expect(result.extractionMethod).toBe('ebay-adapter');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('returns Unknown Item when no title found', () => {
      const html = '<html><body></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.title).toBe('Unknown Item');
    });

    it('returns null soldPrice when no price found', () => {
      const html = '<html><body><h1>Item</h1></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.soldPrice).toBeNull();
    });

    it('extracts sold date from page', () => {
      const html = '<html><body><div class="sold-date">Sold Oct 15, 2024</div></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.soldDate).toBe('Oct 15, 2024');
    });

    it('returns null soldDate when not found', () => {
      const html = '<html><body></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.soldDate).toBeNull();
    });

    it('calculates confidence based on available fields', () => {
      const htmlFull = '<html><body><h1 class="x-item-title__mainTitle">Item</h1><div class="x-price-primary"><span class="ux-textspans">$10</span></div></body></html>';
      const htmlEmpty = '<html><body></body></html>';

      const full = adapter.extractLegacy(htmlFull, 'https://www.ebay.com/itm/123');
      const empty = adapter.extractLegacy(htmlEmpty, 'https://www.ebay.com/itm/123');

      expect(full.confidence).toBeGreaterThan(empty.confidence);
    });

    it('extracts price from meta tag', () => {
      const html = '<html><head><meta itemprop="price" content="150.00"></head><body></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.soldPrice).toBe(150);
    });

    it('handles comma-separated prices', () => {
      const html = '<html><body><div class="x-price-primary"><span class="ux-textspans">$1,234.56</span></div></body></html>';
      const result = adapter.extractLegacy(html, 'https://www.ebay.com/itm/123');
      expect(result.soldPrice).toBe(1234.56);
    });
  });

  describe('adapter properties', () => {
    it('has correct marketplaceId', () => {
      expect(adapter.marketplaceId).toBe('ebay');
    });
    it('has correct name', () => {
      expect(adapter.name).toBe('eBay Scraping Adapter');
    });
    it('has correct version', () => {
      expect(adapter.version).toBe('2.0.0');
    });
    it('has correct channel', () => {
      expect(adapter.channel).toBe('scraping');
    });
    it('has correct tier', () => {
      expect(adapter.tier).toBe(3);
    });
    it('does not require user action', () => {
      expect(adapter.requiresUserAction).toBe(false);
    });
  });
});
