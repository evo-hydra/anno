/**
 * Tests for eBay Search Adapter
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ebaySearchAdapter, EbaySearchAdapter } from '../services/extractors/ebay-search-adapter';
import type { MarketplaceListing } from '../services/extractors/marketplace-adapter';

describe('EbaySearchAdapter', () => {
  let adapter: EbaySearchAdapter;

  beforeEach(() => {
    adapter = new EbaySearchAdapter();
  });

  describe('buildSearchUrl', () => {
    it('should build basic search URL', () => {
      const url = adapter.buildSearchUrl('JUNIPER MX2008');
      expect(url).toContain('https://www.ebay.com/sch/i.html');
      expect(url).toContain('_nkw=JUNIPER');
      expect(url).toContain('MX2008');
    });

    it('should add sold filter when soldOnly=true', () => {
      const url = adapter.buildSearchUrl('JUNIPER MX2008', { soldOnly: true });
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('LH_Complete=1');
    });

    it('should add maxResults parameter', () => {
      const url = adapter.buildSearchUrl('test', { maxResults: 50 });
      expect(url).toContain('_ipg=50');
    });

    it('should limit maxResults to 200', () => {
      const url = adapter.buildSearchUrl('test', { maxResults: 500 });
      expect(url).toContain('_ipg=200'); // eBay max
    });

    it('should add price filters', () => {
      const url = adapter.buildSearchUrl('test', {
        filters: {
          priceMin: 100,
          priceMax: 500,
        },
      });
      expect(url).toContain('_udlo=100');
      expect(url).toContain('_udhi=500');
    });

    it('should add sorting parameter', () => {
      const url = adapter.buildSearchUrl('test', { sortBy: 'price_low' });
      expect(url).toContain('_sop=15');
    });

    it('should add condition filters', () => {
      const url = adapter.buildSearchUrl('test', {
        filters: {
          condition: ['new', 'refurbished'],
        },
      });
      expect(url).toContain('LH_ItemCondition');
      expect(url).toContain('1000'); // new
      expect(url).toContain('2000'); // refurbished
    });
  });

  describe('parseSearchResultsFromHtml', () => {
    it('should parse search results with multiple items', async () => {
      const mockHtml = `
        <html>
          <body>
            <ul class="srp-results">
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/123456789">
                  <span class="s-item__title">JUNIPER MX2008 Router</span>
                </a>
                <span class="s-item__price">$484.99</span>
                <span class="s-item__title--tag">Sold Oct 15, 2024</span>
                <img class="s-item__image-img" src="https://example.com/image.jpg" />
              </li>
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/987654321">
                  <span class="s-item__title">JUNIPER MX2008 Switch</span>
                </a>
                <span class="s-item__price">$599.00</span>
                <span class="s-item__title--tag">Sold Nov 1, 2024</span>
              </li>
            </ul>
          </body>
        </html>
      `;

      const response = await adapter.parseSearchResultsFromHtml(
        mockHtml,
        'JUNIPER MX2008',
        { soldOnly: true }
      );

      expect(response.query).toBe('JUNIPER MX2008');
      expect(response.marketplace).toBe('ebay');
      expect(response.results.length).toBe(2);
      expect(response.totalResults).toBe(2);

      // Check first result
      const first = response.results[0];
      expect(first.listing.title).toBe('JUNIPER MX2008 Router');
      expect(first.listing.price?.amount).toBe(484.99);
      expect(first.listing.price?.currency).toBe('USD');
      expect(first.listing.soldDate).toBe('Oct 15, 2024');
      expect(first.listing.availability).toBe('sold');

      // Check second result
      const second = response.results[1];
      expect(second.listing.title).toBe('JUNIPER MX2008 Switch');
      expect(second.listing.price?.amount).toBe(599.00);
    });

    it('should skip items without price', async () => {
      const mockHtml = `
        <html>
          <body>
            <ul class="srp-results">
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/123">
                  <span class="s-item__title">Item with price</span>
                </a>
                <span class="s-item__price">$100.00</span>
              </li>
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/456">
                  <span class="s-item__title">Item without price</span>
                </a>
              </li>
            </ul>
          </body>
        </html>
      `;

      const response = await adapter.parseSearchResultsFromHtml(mockHtml, 'test');
      expect(response.results.length).toBe(1);
      expect(response.results[0].listing.title).toBe('Item with price');
    });

    it('should skip "Shop on eBay" header items', async () => {
      const mockHtml = `
        <html>
          <body>
            <ul class="srp-results">
              <li class="s-item">
                <span class="s-item__title">Shop on eBay</span>
                <span class="s-item__price">$0.00</span>
              </li>
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/123">
                  <span class="s-item__title">Real Item</span>
                </a>
                <span class="s-item__price">$100.00</span>
              </li>
            </ul>
          </body>
        </html>
      `;

      const response = await adapter.parseSearchResultsFromHtml(mockHtml, 'test');
      expect(response.results.length).toBe(1);
      expect(response.results[0].listing.title).toBe('Real Item');
    });
  });

  describe('aggregatePrices', () => {
    it('should calculate price statistics correctly', () => {
      const mockResults = [
        {
          url: 'https://example.com/1',
          listing: {
            price: { amount: 100, currency: 'USD' },
          } as MarketplaceListing,
        },
        {
          url: 'https://example.com/2',
          listing: {
            price: { amount: 200, currency: 'USD' },
          } as MarketplaceListing,
        },
        {
          url: 'https://example.com/3',
          listing: {
            price: { amount: 300, currency: 'USD' },
          } as MarketplaceListing,
        },
        {
          url: 'https://example.com/4',
          listing: {
            price: { amount: 400, currency: 'USD' },
          } as MarketplaceListing,
        },
        {
          url: 'https://example.com/5',
          listing: {
            price: { amount: 500, currency: 'USD' },
          } as MarketplaceListing,
        },
      ];

      const stats = adapter.aggregatePrices(mockResults);

      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(5);
      expect(stats!.low).toBe(100);
      expect(stats!.high).toBe(500);
      expect(stats!.median).toBe(300);
      expect(stats!.average).toBe(300);
      expect(stats!.currency).toBe('USD');
      expect(stats!.prices).toEqual([100, 200, 300, 400, 500]);
    });

    it('should handle empty results', () => {
      const stats = adapter.aggregatePrices([]);
      expect(stats).toBeNull();
    });

    it('should handle results with null prices', () => {
      const mockResults = [
        {
          url: 'https://example.com/1',
          listing: {
            price: null,
          } as MarketplaceListing,
        },
        {
          url: 'https://example.com/2',
          listing: {
            price: { amount: 200, currency: 'USD' },
          } as MarketplaceListing,
        },
      ];

      const stats = adapter.aggregatePrices(mockResults);
      expect(stats).not.toBeNull();
      expect(stats!.count).toBe(1);
      expect(stats!.median).toBe(200);
    });

    it('should calculate median correctly for even number of items', () => {
      const mockResults = [
        { url: '', listing: { price: { amount: 100, currency: 'USD' } } as MarketplaceListing },
        { url: '', listing: { price: { amount: 200, currency: 'USD' } } as MarketplaceListing },
        { url: '', listing: { price: { amount: 300, currency: 'USD' } } as MarketplaceListing },
        { url: '', listing: { price: { amount: 400, currency: 'USD' } } as MarketplaceListing },
      ];

      const stats = adapter.aggregatePrices(mockResults);
      expect(stats!.median).toBe(300); // Middle-right element for even count
    });
  });

  describe('isSoldSearch', () => {
    it('should identify sold search URLs', () => {
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1';
      expect(adapter.isSoldSearch(url)).toBe(true);
    });

    it('should identify search URLs without sold filter', () => {
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test';
      expect(adapter.isSoldSearch(url)).toBe(true);
    });

    it('should reject non-eBay URLs', () => {
      const url = 'https://www.amazon.com/s?k=test';
      expect(adapter.isSoldSearch(url)).toBe(false);
    });

    it('should handle invalid URLs', () => {
      expect(adapter.isSoldSearch('not a url')).toBe(false);
    });
  });

  describe('legacy extractLegacy method', () => {
    it('should maintain backward compatibility', () => {
      const mockHtml = `
        <html>
          <body>
            <ul>
              <li class="s-item">
                <a class="s-item__link" href="https://www.ebay.com/itm/123">
                  <span class="s-item__title">Test Item</span>
                </a>
                <span class="s-item__price">$100.00</span>
                <span class="s-item__title--tag">Sold Oct 15, 2024</span>
                <span class="s-item__shipping">Free shipping</span>
              </li>
            </ul>
          </body>
        </html>
      `;

      const result = adapter.extractLegacy(mockHtml, 'https://ebay.com/sch');

      expect(result.detectedCount).toBe(1);
      expect(result.extractedCount).toBe(1);
      expect(result.items.length).toBe(1);
      expect(result.items[0].title).toBe('Test Item');
      expect(result.items[0].price).toBe(100);
      expect(result.items[0].soldDate).toBe('Oct 15, 2024');
      expect(result.items[0].shippingCost).toBe(0); // Free
    });
  });

  describe('integration', () => {
    it('should use singleton instance', () => {
      expect(ebaySearchAdapter).toBeInstanceOf(EbaySearchAdapter);
    });

    it('should extend EbayAdapterV2', () => {
      expect(adapter.marketplaceId).toBe('ebay');
      expect(adapter.name).toBe('eBay Marketplace Adapter');
      expect(adapter.version).toBe('2.1.0');
    });
  });
});
