import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockBuildEbaySoldUrl = vi.hoisted(() => vi.fn());

vi.mock('../utils/ebay-url-builder', () => ({
  buildEbaySoldUrl: mockBuildEbaySoldUrl,
}));

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  PriceAnalysisRAG,
} from '../ai/price-analysis-rag';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  mockBuildEbaySoldUrl.mockReturnValue('https://www.ebay.com/sch/i.html?_nkw=test&LH_Complete=1&LH_Sold=1');
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

function makeSearchItems(count: number, opts?: { priceBase?: number; withDates?: boolean; condition?: string }) {
  const priceBase = opts?.priceBase ?? 100;
  const items = [];
  for (let i = 0; i < count; i++) {
    const daysAgo = i * 2;
    items.push({
      title: `Item ${i} - Nintendo Switch OLED Console`,
      price: priceBase + (i * 5) - (count / 2 * 5),
      currency: 'USD',
      priceText: `$${(priceBase + i * 5).toFixed(2)}`,
      soldDate: opts?.withDates
        ? new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
        : null,
      condition: opts?.condition ?? (i % 2 === 0 ? 'New' : 'Used'),
      shippingText: i % 3 === 0 ? 'Free shipping' : '$5.99 shipping',
      shippingCost: i % 3 === 0 ? 0 : 5.99,
      url: `https://www.ebay.com/itm/${100000 + i}`,
    });
  }
  return items;
}

function makeAnnoJsonlResponse(items: Record<string, unknown>[]) {
  const lines: string[] = [];

  // Extraction line with ebaySearch data
  lines.push(JSON.stringify({
    type: 'extraction',
    payload: {
      method: 'ebay-search-adapter',
      confidence: 0.9,
      fallbackUsed: false,
      byline: null,
      siteName: 'eBay',
      ebaySearch: {
        items,
        totalResults: items.length,
        searchTerms: 'test',
      },
    },
  }));

  // Node lines
  for (const item of items) {
    lines.push(JSON.stringify({
      type: 'node',
      payload: { text: `${item.title} - $${item.price}` },
    }));
  }

  return lines.join('\n');
}

function mockFetchWithItems(items: Record<string, unknown>[]) {
  const responseText = makeAnnoJsonlResponse(items);
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(responseText),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PriceAnalysisRAG', () => {
  describe('analyze - with ebaySearch extraction', () => {
    it('returns full analysis result for valid data', async () => {
      const items = makeSearchItems(20, { withDates: true });
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG('http://localhost:5213');
      const result = await rag.analyze('Nintendo Switch OLED');

      expect(result.product).toBe('Nintendo Switch OLED');
      expect(result.statistics).toBeDefined();
      expect(result.statistics.count).toBe(20);
      expect(result.statistics.mean).toBeGreaterThan(0);
      expect(result.statistics.median).toBeGreaterThan(0);
      expect(result.statistics.min).toBeLessThanOrEqual(result.statistics.max);
      expect(result.statistics.range).toBe(result.statistics.max - result.statistics.min);
      expect(result.statistics.stdDev).toBeGreaterThanOrEqual(0);
      expect(result.statistics.variance).toBeGreaterThanOrEqual(0);
      expect(result.statistics.percentiles).toBeDefined();
      expect(result.byCondition).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.dataPoints).toHaveLength(20);
    });

    it('throws when no price data found', async () => {
      mockFetchWithItems([]);

      const rag = new PriceAnalysisRAG();
      await expect(rag.analyze('nonexistent product')).rejects.toThrow('No price data found');
    });

    it('filters out items with null or zero prices', async () => {
      const items = [
        { title: 'Good Item', price: 50, currency: 'USD', priceText: '$50', soldDate: null, condition: 'New', shippingText: null, shippingCost: null, url: 'http://x' },
        { title: 'Bad Item No Price', price: null, currency: 'USD', priceText: null, soldDate: null, condition: 'New', shippingText: null, shippingCost: null, url: 'http://x' },
        { title: 'Bad Item Zero Price', price: 0, currency: 'USD', priceText: '$0', soldDate: null, condition: 'New', shippingText: null, shippingCost: null, url: 'http://x' },
        { title: 'Bad Item Negative', price: -10, currency: 'USD', priceText: '-$10', soldDate: null, condition: 'New', shippingText: null, shippingCost: null, url: 'http://x' },
      ];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.dataPoints).toHaveLength(1);
      expect(result.dataPoints[0].price).toBe(50);
    });

    it('passes options to buildEbaySoldUrl', async () => {
      const items = makeSearchItems(10);
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      await rag.analyze('test', { condition: 'used', maxItems: 30, daysBack: 14 });

      expect(mockBuildEbaySoldUrl).toHaveBeenCalledWith('test', {
        condition: 'used',
        sortBy: 'date_recent',
        itemsPerPage: 30,
      });
    });

    it('uses default maxItems of 60 when not specified', async () => {
      const items = makeSearchItems(10);
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      await rag.analyze('test');

      expect(mockBuildEbaySoldUrl).toHaveBeenCalledWith('test', expect.objectContaining({
        itemsPerPage: 60,
      }));
    });
  });

  // =========================================================================
  // Statistics
  // =========================================================================

  describe('statistics calculation', () => {
    it('calculates correct mean', async () => {
      // Items with prices: 90, 95, 100, 105, 110
      const items = [90, 95, 100, 105, 110].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.mean).toBe(100);
    });

    it('calculates correct median for odd count', async () => {
      const items = [10, 20, 30, 40, 50].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.median).toBe(30);
    });

    it('calculates correct median for even count', async () => {
      const items = [10, 20, 30, 40].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.median).toBe(25); // (20+30)/2
    });

    it('detects mode when a price appears multiple times', async () => {
      const items = [50, 100, 100, 100, 200].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.mode).toBe(100);
    });

    it('returns null mode when all prices are unique', async () => {
      const items = [10, 20, 30, 40, 50].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.mode).toBeNull();
    });

    it('calculates min and max correctly', async () => {
      const items = [200, 10, 150, 5, 300].map((price, i) => ({
        title: `Item ${i}`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.statistics.min).toBe(5);
      expect(result.statistics.max).toBe(300);
      expect(result.statistics.range).toBe(295);
    });
  });

  // =========================================================================
  // Condition normalization
  // =========================================================================

  describe('condition normalization', () => {
    it('normalizes "Brand New" to "new"', async () => {
      const items = [{ title: 'Item', price: 100, currency: 'USD', priceText: '$100', soldDate: null, condition: 'Brand New', shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('new');
    });

    it('normalizes "Pre-Owned / Used" to "used"', async () => {
      const items = [{ title: 'Item', price: 100, currency: 'USD', priceText: '$100', soldDate: null, condition: 'Pre-Owned / Used', shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('used');
    });

    it('normalizes "Seller Refurbished" to "refurbished"', async () => {
      const items = [{ title: 'Item', price: 100, currency: 'USD', priceText: '$100', soldDate: null, condition: 'Seller Refurbished', shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('refurbished');
    });

    it('normalizes "For Parts or Not Working" to "parts"', async () => {
      const items = [{ title: 'Item', price: 50, currency: 'USD', priceText: '$50', soldDate: null, condition: 'For Parts or Not Working', shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('parts');
    });

    it('returns "unknown" for null condition', async () => {
      const items = [{ title: 'Item', price: 100, currency: 'USD', priceText: '$100', soldDate: null, condition: null, shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('unknown');
    });

    it('returns "unknown" for unrecognized condition', async () => {
      const items = [{ title: 'Item', price: 100, currency: 'USD', priceText: '$100', soldDate: null, condition: 'Some Random Condition', shippingText: null, shippingCost: null, url: 'http://x' }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');
      expect(result.dataPoints[0].condition).toBe('unknown');
    });
  });

  // =========================================================================
  // Deals detection
  // =========================================================================

  describe('deals detection', () => {
    it('finds deals below 85% of mean', async () => {
      // Mean = 100, deal threshold = 85
      const items = [100, 100, 100, 100, 50].map((price, i) => ({
        title: `Item ${i} with enough title length here`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.deals.length).toBeGreaterThan(0);
      // The $50 item should be a deal
      const cheapDeal = result.deals.find((d) => d.item.price === 50);
      expect(cheapDeal).toBeDefined();
      expect(cheapDeal!.savingsPercent).toBeGreaterThan(15);
    });

    it('returns empty deals when no prices below threshold', async () => {
      // All prices the same
      const items = Array.from({ length: 5 }, (_, i) => ({
        title: `Item ${i} with enough title length here`,
        price: 100,
        currency: 'USD',
        priceText: '$100',
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.deals).toHaveLength(0);
    });

    it('limits deals to top 10', async () => {
      // Create 20 items where 15 are "deals" (very cheap)
      const items = Array.from({ length: 20 }, (_, i) => ({
        title: `Item ${i} with enough title length here`,
        price: i < 15 ? 10 : 200,
        currency: 'USD',
        priceText: `$${i < 15 ? 10 : 200}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.deals.length).toBeLessThanOrEqual(10);
    });

    it('adds context for NEW items', async () => {
      const items = [
        { title: 'Expensive Used Item Length Title', price: 200, currency: 'USD', priceText: '$200', soldDate: null, condition: 'Used', shippingText: null, shippingCost: null, url: 'http://x' },
        { title: 'Expensive Used Item Length Title 2', price: 200, currency: 'USD', priceText: '$200', soldDate: null, condition: 'Used', shippingText: null, shippingCost: null, url: 'http://x' },
        { title: 'Cheap NEW Item With Long Title Here', price: 50, currency: 'USD', priceText: '$50', soldDate: null, condition: 'New', shippingText: null, shippingCost: 0, url: 'http://x' },
      ];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      const newDeal = result.deals.find((d) => d.item.condition === 'new');
      if (newDeal) {
        expect(newDeal.reason).toContain('NEW condition');
      }
    });

    it('adds context for FREE shipping', async () => {
      const items = [
        { title: 'Expensive Item Title Long Enough', price: 200, currency: 'USD', priceText: '$200', soldDate: null, condition: 'Used', shippingText: null, shippingCost: 10, url: 'http://x' },
        { title: 'Expensive Item Title Long Enough 2', price: 200, currency: 'USD', priceText: '$200', soldDate: null, condition: 'Used', shippingText: null, shippingCost: 10, url: 'http://x' },
        { title: 'Cheap Item Free Ship Long Title', price: 50, currency: 'USD', priceText: '$50', soldDate: null, condition: 'Used', shippingText: 'Free shipping', shippingCost: 0, url: 'http://x' },
      ];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      const freeDeal = result.deals.find((d) => d.item.shipping === 0);
      if (freeDeal) {
        expect(freeDeal.reason).toContain('FREE shipping');
      }
    });
  });

  // =========================================================================
  // Trends
  // =========================================================================

  describe('trends analysis', () => {
    it('returns null when fewer than 10 items have dates', async () => {
      const items = makeSearchItems(5, { withDates: false });
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.trends).toBeNull();
    });

    it('returns null when not enough data in time ranges', async () => {
      // All items from same date (recent), so no "older" bucket
      const items = makeSearchItems(15, { withDates: false });
      // Manually set all dates to today
      items.forEach((item) => {
        item.soldDate = new Date().toISOString();
      });
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test', { daysBack: 30 });

      // All items are "recent", none are "older", so trends should be null
      expect(result.trends).toBeNull();
    });

    it('detects upward trend', async () => {
      const items = [];
      // Older items: cheaper (15-30 days ago)
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `Old Item ${i} With Enough Length`,
          price: 50,
          currency: 'USD',
          priceText: '$50',
          soldDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i}`,
        });
      }
      // Recent items: more expensive (0-15 days ago)
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `New Item ${i} With Enough Length`,
          price: 100,
          currency: 'USD',
          priceText: '$100',
          soldDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i + 8}`,
        });
      }
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test', { daysBack: 30 });

      expect(result.trends).not.toBeNull();
      expect(result.trends!.direction).toBe('up');
      expect(result.trends!.changePercent).toBeGreaterThan(5);
    });

    it('detects downward trend', async () => {
      const items = [];
      // Older items: expensive
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `Old Expensive Item ${i} Title`,
          price: 200,
          currency: 'USD',
          priceText: '$200',
          soldDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i}`,
        });
      }
      // Recent items: cheap
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `New Cheap Item ${i} Title Here`,
          price: 80,
          currency: 'USD',
          priceText: '$80',
          soldDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i + 8}`,
        });
      }
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test', { daysBack: 30 });

      expect(result.trends).not.toBeNull();
      expect(result.trends!.direction).toBe('down');
      expect(result.trends!.changePercent).toBeLessThan(-5);
    });

    it('detects stable prices', async () => {
      const items = [];
      // Mix of recent and older all around same price
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `Old Stable Item ${i} Title Here`,
          price: 100 + (i % 2),
          currency: 'USD',
          priceText: '$100',
          soldDate: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i}`,
        });
      }
      for (let i = 0; i < 8; i++) {
        items.push({
          title: `New Stable Item ${i} Title Here`,
          price: 100 + (i % 2),
          currency: 'USD',
          priceText: '$100',
          soldDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i + 8}`,
        });
      }
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test', { daysBack: 30 });

      expect(result.trends).not.toBeNull();
      expect(result.trends!.direction).toBe('stable');
    });
  });

  // =========================================================================
  // Recommendations
  // =========================================================================

  describe('recommendations', () => {
    it('always includes price range recommendation', async () => {
      const items = makeSearchItems(10);
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.recommendations.some((r) => r.includes('Typical price range'))).toBe(true);
    });

    it('includes skewed distribution note when median and mean differ by >10%', async () => {
      // Create highly skewed data: many cheap, one very expensive
      const items = [10, 10, 10, 10, 10, 10, 10, 10, 10, 500].map((price, i) => ({
        title: `Item ${i} Long Enough Title Here`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://ebay.com/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.recommendations.some((r) => r.includes('skewed'))).toBe(true);
    });

    it('includes new vs used comparison when both present', async () => {
      const items = [
        ...Array.from({ length: 5 }, (_, i) => ({
          title: `New Item ${i} With Long Title`,
          price: 200,
          currency: 'USD',
          priceText: '$200',
          soldDate: null,
          condition: 'New',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i}`,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          title: `Used Item ${i} With Long Title`,
          price: 100,
          currency: 'USD',
          priceText: '$100',
          soldDate: null,
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/${i + 5}`,
        })),
      ];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.recommendations.some((r) => r.includes('used saves'))).toBe(true);
    });

    it('includes deals count when deals found', async () => {
      const items = [100, 100, 100, 100, 20].map((price, i) => ({
        title: `Item ${i} Long Enough Title Content`,
        price,
        currency: 'USD',
        priceText: `$${price}`,
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: `http://x/${i}`,
      }));
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.recommendations.some((r) => r.includes('deals below market'))).toBe(true);
    });
  });

  // =========================================================================
  // Confidence scoring
  // =========================================================================

  describe('confidence scoring', () => {
    it('gives higher confidence for more data points', async () => {
      const smallItems = makeSearchItems(5);
      mockFetchWithItems(smallItems);
      const rag = new PriceAnalysisRAG();
      const smallResult = await rag.analyze('test');

      const largeItems = makeSearchItems(55, { withDates: true });
      mockFetchWithItems(largeItems);
      const largeResult = await rag.analyze('test');

      expect(largeResult.confidence).toBeGreaterThan(smallResult.confidence);
    });

    it('gives higher confidence for data with dates', async () => {
      const noDates = makeSearchItems(20, { withDates: false });
      mockFetchWithItems(noDates);
      const rag = new PriceAnalysisRAG();
      const noDatesResult = await rag.analyze('test');

      const withDates = makeSearchItems(20, { withDates: true });
      mockFetchWithItems(withDates);
      const withDatesResult = await rag.analyze('test');

      expect(withDatesResult.confidence).toBeGreaterThan(noDatesResult.confidence);
    });

    it('confidence is capped at 1.0', async () => {
      const items = makeSearchItems(100, { withDates: true, condition: 'New' });
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });
  });

  // =========================================================================
  // By condition grouping
  // =========================================================================

  describe('groupByCondition', () => {
    it('groups data by condition with separate statistics', async () => {
      const items = [
        ...Array.from({ length: 5 }, (_, i) => ({
          title: `New Item ${i} With Long Title`,
          price: 200 + i,
          currency: 'USD',
          priceText: `$${200 + i}`,
          soldDate: null,
          condition: 'New',
          shippingText: null,
          shippingCost: null,
          url: `http://x/new${i}`,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          title: `Used Item ${i} With Long Title`,
          price: 100 + i,
          currency: 'USD',
          priceText: `$${100 + i}`,
          soldDate: null,
          condition: 'Used',
          shippingText: null,
          shippingCost: null,
          url: `http://x/used${i}`,
        })),
      ];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.byCondition.new).toBeDefined();
      expect(result.byCondition.used).toBeDefined();
      expect(result.byCondition.new.count).toBe(5);
      expect(result.byCondition.used.count).toBe(5);
      expect(result.byCondition.new.mean).toBeGreaterThan(result.byCondition.used.mean);
    });
  });

  // =========================================================================
  // Fallback markdown parsing
  // =========================================================================

  describe('fallback markdown parsing', () => {
    it('extracts prices from markdown when no ebaySearch data', async () => {
      // Create a response with no ebaySearch but with nodes containing price text
      const lines = [
        JSON.stringify({ type: 'node', payload: { text: 'Nintendo Switch OLED Console Bundle' } }),
        JSON.stringify({ type: 'node', payload: { text: '$299.99' } }),
        JSON.stringify({ type: 'node', payload: { text: 'Sold Jan 15, 2025' } }),
        JSON.stringify({ type: 'node', payload: { text: 'Condition: Used' } }),
        JSON.stringify({ type: 'node', payload: { text: '$5.99 shipping' } }),
        JSON.stringify({ type: 'node', payload: { text: '' } }),
        JSON.stringify({ type: 'node', payload: { text: 'Another Nintendo Switch OLED System' } }),
        JSON.stringify({ type: 'node', payload: { text: '$275.00' } }),
        JSON.stringify({ type: 'extraction', payload: { method: 'readability', confidence: 0.8, fallbackUsed: false } }),
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        statusText: 'OK',
        text: vi.fn().mockResolvedValue(lines.join('\n')),
      });

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('Nintendo Switch');

      expect(result.dataPoints.length).toBeGreaterThanOrEqual(1);
    });

    it('handles Anno fetch failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
      });

      const rag = new PriceAnalysisRAG();
      await expect(rag.analyze('test')).rejects.toThrow('Anno fetch failed');
    });
  });

  // =========================================================================
  // Date parsing
  // =========================================================================

  describe('date parsing', () => {
    it('handles valid dates', async () => {
      const items = [{
        title: 'Item With Date And Long Enough Title',
        price: 100,
        currency: 'USD',
        priceText: '$100',
        soldDate: '2025-01-15T00:00:00Z',
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: 'http://x/1',
      }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.dataPoints[0].soldDate).toBeInstanceOf(Date);
    });

    it('handles invalid dates gracefully', async () => {
      const items = [{
        title: 'Item With Bad Date Long Title',
        price: 100,
        currency: 'USD',
        priceText: '$100',
        soldDate: 'not-a-date',
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: 'http://x/1',
      }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      // "not-a-date" parsed by new Date() gives NaN, so soldDate should be null
      expect(result.dataPoints[0].soldDate).toBeNull();
    });

    it('handles null soldDate', async () => {
      const items = [{
        title: 'Item Without Date Long Title',
        price: 100,
        currency: 'USD',
        priceText: '$100',
        soldDate: null,
        condition: 'Used',
        shippingText: null,
        shippingCost: null,
        url: 'http://x/1',
      }];
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      const result = await rag.analyze('test');

      expect(result.dataPoints[0].soldDate).toBeNull();
    });
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('uses default endpoint when none provided', async () => {
      const items = makeSearchItems(5);
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG();
      await rag.analyze('test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://localhost:5213'),
        expect.any(Object)
      );
    });

    it('uses custom endpoint when provided', async () => {
      const items = makeSearchItems(5);
      mockFetchWithItems(items);

      const rag = new PriceAnalysisRAG('http://custom:9999');
      await rag.analyze('test');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://custom:9999'),
        expect.any(Object)
      );
    });
  });
});
