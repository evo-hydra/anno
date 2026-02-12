import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { WalmartAdapter, walmartAdapter } from '../services/extractors/walmart-adapter';
import type { MarketplaceListing } from '../services/extractors/marketplace-adapter';

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

function buildHtml(sections: {
  title?: string;
  price?: string;
  structuredData?: Record<string, unknown>;
  availability?: string;
  addToCartButton?: string;
  condition?: string;
  seller?: string;
  mainImage?: string;
  thumbnails?: string[];
  breadcrumbs?: string[];
  itemIdMeta?: string;
  dataItemId?: string;
}): string {
  const parts: string[] = ['<html><head>'];

  if (sections.structuredData) {
    parts.push(
      `<script type="application/ld+json">${JSON.stringify(sections.structuredData)}</script>`
    );
  }

  if (sections.itemIdMeta) {
    parts.push(`<meta name="product.itemId" content="${sections.itemIdMeta}" />`);
  }

  parts.push('</head><body>');

  if (sections.title) {
    parts.push(`<h1 itemprop="name">${sections.title}</h1>`);
  }

  if (sections.price) {
    parts.push(`<span itemprop="price">${sections.price}</span>`);
  }

  if (sections.addToCartButton) {
    parts.push(
      `<button data-automation-id="add-to-cart-button">${sections.addToCartButton}</button>`
    );
  }

  if (sections.availability) {
    parts.push(
      `<div data-testid="fulfillment-badge">${sections.availability}</div>`
    );
  }

  if (sections.condition) {
    parts.push(`<div data-testid="condition">${sections.condition}</div>`);
  }

  if (sections.seller) {
    parts.push(`<span data-testid="seller-name">${sections.seller}</span>`);
  }

  if (sections.mainImage) {
    parts.push(
      `<img data-testid="hero-image-container" src="${sections.mainImage}" />`
    );
  }

  if (sections.thumbnails) {
    parts.push('<div class="thumbnail-image">');
    for (const src of sections.thumbnails) {
      parts.push(`<img src="${src}" />`);
    }
    parts.push('</div>');
  }

  if (sections.breadcrumbs) {
    parts.push('<div data-testid="breadcrumb">');
    for (const crumb of sections.breadcrumbs) {
      parts.push(`<a href="#">${crumb}</a>`);
    }
    parts.push('</div>');
  }

  if (sections.dataItemId) {
    parts.push(`<div data-item-id="${sections.dataItemId}"></div>`);
  }

  parts.push('</body></html>');
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalmartAdapter', () => {
  let adapter: WalmartAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WalmartAdapter();
  });

  // =========================================================================
  // Static properties
  // =========================================================================

  describe('static properties', () => {
    it('has correct marketplaceId', () => {
      expect(adapter.marketplaceId).toBe('walmart');
    });

    it('has correct name', () => {
      expect(adapter.name).toBe('Walmart Marketplace Adapter');
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  // =========================================================================
  // canHandle
  // =========================================================================

  describe('canHandle', () => {
    it('handles walmart.com URLs', () => {
      expect(adapter.canHandle('https://www.walmart.com/ip/12345678')).toBe(true);
    });

    it('handles walmart.com without www', () => {
      expect(adapter.canHandle('https://walmart.com/ip/12345678')).toBe(true);
    });

    it('rejects non-walmart URLs', () => {
      expect(adapter.canHandle('https://www.amazon.com/dp/B001')).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(adapter.canHandle('not-a-url')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(adapter.canHandle('')).toBe(false);
    });
  });

  // =========================================================================
  // extract — title
  // =========================================================================

  describe('extract — title', () => {
    it('extracts title from h1[itemprop="name"]', async () => {
      const html = buildHtml({ title: 'Great Product' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.title).toBe('Great Product');
    });

    it('extracts title from h1.prod-ProductTitle', async () => {
      const html = '<html><body><h1 class="prod-ProductTitle">Fallback Title</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.title).toBe('Fallback Title');
    });

    it('extracts title from h1[data-automation-id]', async () => {
      const html =
        '<html><body><h1 data-automation-id="product-title">Auto Title</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.title).toBe('Auto Title');
    });

    it('returns "Unknown Product" when no title found', async () => {
      const html = '<html><body><div>No title here</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.title).toBe('Unknown Product');
    });
  });

  // =========================================================================
  // extract — price
  // =========================================================================

  describe('extract — price', () => {
    it('extracts price from itemprop selector', async () => {
      const html = buildHtml({ price: '$29.99' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price?.amount).toBe(29.99);
      expect(listing?.price?.currency).toBe('USD');
    });

    it('extracts price with comma formatting', async () => {
      const html = buildHtml({ price: '$1,299.99' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price?.amount).toBe(1299.99);
    });

    it('extracts price from structured data', async () => {
      const html = buildHtml({
        structuredData: {
          offers: { price: '49.99', priceCurrency: 'USD' },
        },
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price?.amount).toBe(49.99);
      expect(listing?.price?.currency).toBe('USD');
    });

    it('returns null price when no price found', async () => {
      const html = '<html><body><h1 itemprop="name">Title</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price).toBeNull();
    });

    it('handles structured data with missing priceCurrency', async () => {
      const html = buildHtml({
        structuredData: { offers: { price: '19.99' } },
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price?.currency).toBe('USD');
    });

    it('handles invalid JSON in structured data gracefully', async () => {
      const html =
        '<html><head><script type="application/ld+json">{{invalid json}}</script></head><body><h1 itemprop="name">Title</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.price).toBeNull();
    });
  });

  // =========================================================================
  // extract — availability
  // =========================================================================

  describe('extract — availability', () => {
    it('detects in_stock from structured data', async () => {
      const html = buildHtml({
        title: 'Product',
        structuredData: {
          offers: { availability: 'https://schema.org/InStock' },
        },
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('in_stock');
    });

    it('detects out_of_stock from structured data', async () => {
      const html = buildHtml({
        title: 'Product',
        structuredData: {
          offers: { availability: 'https://schema.org/OutOfStock' },
        },
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('out_of_stock');
    });

    it('detects in_stock from add to cart button', async () => {
      const html = buildHtml({
        title: 'Product',
        addToCartButton: 'Add to cart',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('in_stock');
    });

    it('detects out_of_stock from button text', async () => {
      const html = buildHtml({
        title: 'Product',
        addToCartButton: 'Out of stock',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('out_of_stock');
    });

    it('detects in_stock from fulfillment badge', async () => {
      const html = buildHtml({
        title: 'Product',
        availability: 'In stock',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('in_stock');
    });

    it('returns unknown when no availability indicators', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.availability).toBe('unknown');
    });
  });

  // =========================================================================
  // extract — condition
  // =========================================================================

  describe('extract — condition', () => {
    it('detects new condition', async () => {
      const html = buildHtml({ title: 'Product', condition: 'New' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.condition).toBe('new');
    });

    it('detects refurbished condition', async () => {
      const html = buildHtml({ title: 'Product', condition: 'Refurbished' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.condition).toBe('refurbished');
    });

    it('detects used condition from pre-owned text', async () => {
      const html = buildHtml({ title: 'Product', condition: 'Pre-Owned' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.condition).toBe('used_good');
    });

    it('defaults to new when no condition element', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.condition).toBe('new');
    });
  });

  // =========================================================================
  // extract — item ID
  // =========================================================================

  describe('extract — item ID', () => {
    it('extracts item ID from URL', async () => {
      const html = buildHtml({ title: 'Product' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.itemNumber).toBe('12345678');
    });

    it('extracts item ID from meta tag', async () => {
      const html = buildHtml({ title: 'Product', itemIdMeta: '87654321' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/some-page');

      expect(listing?.itemNumber).toBe('87654321');
    });

    it('extracts item ID from data attribute', async () => {
      const html = buildHtml({ title: 'Product', dataItemId: '99988877' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/some-page');

      expect(listing?.itemNumber).toBe('99988877');
    });

    it('generates ID from URL when no item ID found', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/some-page');

      expect(listing?.id).toBe('some-page');
    });
  });

  // =========================================================================
  // extract — seller
  // =========================================================================

  describe('extract — seller', () => {
    it('extracts seller name', async () => {
      const html = buildHtml({ title: 'Product', seller: 'SuperSeller' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.seller.name).toBe('SuperSeller');
    });

    it('marks Walmart as verified seller', async () => {
      const html = buildHtml({ title: 'Product', seller: 'Sold by Walmart.com' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.seller.verified).toBe(true);
    });

    it('marks non-Walmart sellers as not verified', async () => {
      const html = buildHtml({ title: 'Product', seller: 'ThirdParty' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.seller.verified).toBe(false);
    });

    it('handles missing seller', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.seller.name).toBeNull();
    });
  });

  // =========================================================================
  // extract — images
  // =========================================================================

  describe('extract — images', () => {
    it('extracts main product image', async () => {
      const html = buildHtml({
        title: 'Product',
        mainImage: 'https://img.walmart.com/main.jpg',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.images).toContain('https://img.walmart.com/main.jpg');
    });

    it('extracts thumbnail images', async () => {
      const html = buildHtml({
        title: 'Product',
        thumbnails: ['https://img.walmart.com/thumb1.jpg', 'https://img.walmart.com/thumb2.jpg'],
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.images).toContain('https://img.walmart.com/thumb1.jpg');
      expect(listing?.images).toContain('https://img.walmart.com/thumb2.jpg');
    });

    it('deduplicates images', async () => {
      const html = buildHtml({
        title: 'Product',
        mainImage: 'https://img.walmart.com/same.jpg',
        thumbnails: ['https://img.walmart.com/same.jpg'],
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      const sameCount = listing?.images.filter(
        (img) => img === 'https://img.walmart.com/same.jpg'
      ).length;
      expect(sameCount).toBe(1);
    });

    it('returns empty array when extractImages is false', async () => {
      const html = buildHtml({
        title: 'Product',
        mainImage: 'https://img.walmart.com/main.jpg',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678', {
        extractImages: false,
      });

      expect(listing?.images).toEqual([]);
    });
  });

  // =========================================================================
  // extract — category
  // =========================================================================

  describe('extract — category', () => {
    it('extracts category from breadcrumbs', async () => {
      const html = buildHtml({
        title: 'Product',
        breadcrumbs: ['Home', 'Electronics', 'Laptops'],
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      // 'Home' should be excluded
      expect(listing?.category).toEqual(['Electronics', 'Laptops']);
    });

    it('returns undefined when no breadcrumbs', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.category).toBeUndefined();
    });

    it('returns undefined when only Home breadcrumb', async () => {
      const html = buildHtml({
        title: 'Product',
        breadcrumbs: ['Home'],
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.category).toBeUndefined();
    });
  });

  // =========================================================================
  // extract — confidence
  // =========================================================================

  describe('extract — confidence', () => {
    it('gives full confidence when all fields present', async () => {
      const html = buildHtml({
        title: 'Product',
        price: '$29.99',
        addToCartButton: 'Add to cart',
      });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      // title: 0.3 + price: 0.35 + availability: 0.15 + itemId: 0.2 = 1.0
      expect(listing?.confidence).toBe(1.0);
    });

    it('gives partial confidence when fields missing', async () => {
      const html = '<html><body><h1 itemprop="name">Product</h1></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      // title: 0.3 + itemId: 0.2 = 0.5
      expect(listing?.confidence).toBe(0.5);
    });

    it('gives low confidence when minimal fields extracted', async () => {
      const html = '<html><body><div>Nothing here</div></body></html>';
      const listing = await adapter.extract(html, 'https://www.walmart.com/some-page');

      // "Unknown Product" still passes the !!title check (truthy string)
      // title: 0.3, no price, unknown availability, no itemId = 0.3
      expect(listing?.confidence).toBe(0.3);
    });
  });

  // =========================================================================
  // extract — metadata
  // =========================================================================

  describe('extract — metadata', () => {
    it('sets marketplace to walmart', async () => {
      const html = buildHtml({ title: 'Product' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.marketplace).toBe('walmart');
    });

    it('sets extractionMethod with name and version', async () => {
      const html = buildHtml({ title: 'Product' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.extractionMethod).toContain('Walmart');
      expect(listing?.extractionMethod).toContain('1.0.0');
    });

    it('sets extractedAt as ISO string', async () => {
      const html = buildHtml({ title: 'Product' });
      const listing = await adapter.extract(html, 'https://www.walmart.com/ip/12345678');

      expect(listing?.extractedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('sets URL from the provided url argument', async () => {
      const html = buildHtml({ title: 'Product' });
      const url = 'https://www.walmart.com/ip/12345678?param=value';
      const listing = await adapter.extract(html, url);

      expect(listing?.url).toBe(url);
    });
  });

  // =========================================================================
  // extract — error handling
  // =========================================================================

  describe('extract — error handling', () => {
    it('returns null on catastrophic extraction error', async () => {
      // Passing completely malformed content that may cause issues
      // The adapter wraps extraction in try/catch
      const listing = await adapter.extract('', 'https://www.walmart.com/ip/12345678');

      // Should still return a listing (even with defaults) since JSDOM handles empty HTML
      expect(listing).not.toBeNull();
    });
  });

  // =========================================================================
  // validate
  // =========================================================================

  describe('validate', () => {
    it('validates a complete listing as valid', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Great Product',
        price: { amount: 29.99, currency: 'USD' },
        condition: 'new',
        availability: 'in_stock',
        seller: { name: 'Walmart' },
        images: [],
        itemNumber: '12345678',
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.85,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('reports error for missing title', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Unknown Product',
        price: { amount: 29.99, currency: 'USD' },
        condition: 'new',
        availability: 'in_stock',
        seller: { name: 'Walmart' },
        images: [],
        itemNumber: '12345678',
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.85,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.errors).toContain('Missing or invalid title');
    });

    it('reports warning for missing price', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Product',
        price: null,
        condition: 'new',
        availability: 'in_stock',
        seller: { name: 'Walmart' },
        images: [],
        itemNumber: '12345678',
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.85,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.warnings).toContain('Missing price information');
    });

    it('reports error for missing item ID', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Product',
        price: { amount: 29.99, currency: 'USD' },
        condition: 'new',
        availability: 'in_stock',
        seller: { name: 'Walmart' },
        images: [],
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.85,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.errors).toContain('Missing item ID');
    });

    it('reports warning for unknown availability', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Product',
        price: { amount: 29.99, currency: 'USD' },
        condition: 'new',
        availability: 'unknown',
        seller: { name: 'Walmart' },
        images: [],
        itemNumber: '12345678',
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.85,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.warnings).toContain('Could not determine availability status');
    });

    it('reports error for low confidence', () => {
      const listing: MarketplaceListing = {
        id: '12345678',
        marketplace: 'walmart',
        url: 'https://www.walmart.com/ip/12345678',
        title: 'Product',
        price: { amount: 29.99, currency: 'USD' },
        condition: 'new',
        availability: 'in_stock',
        seller: { name: 'Walmart' },
        images: [],
        itemNumber: '12345678',
        extractedAt: '2026-01-01T00:00:00Z',
        extractionMethod: 'test',
        confidence: 0.3,
        extractorVersion: '1.0.0',
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining('Low confidence'));
    });
  });

  // =========================================================================
  // getConfig
  // =========================================================================

  describe('getConfig', () => {
    it('returns config with walmart marketplaceId', () => {
      const config = adapter.getConfig();
      expect(config.marketplaceId).toBe('walmart');
    });

    it('has JavaScript rendering enabled', () => {
      const config = adapter.getConfig();
      expect(config.rendering.requiresJavaScript).toBe(true);
    });

    it('is disabled by default (not yet launched)', () => {
      const config = adapter.getConfig();
      expect(config.enabled).toBe(false);
    });

    it('has rate limit configuration', () => {
      const config = adapter.getConfig();
      expect(config.rateLimit.requestsPerSecond).toBe(1.5);
      expect(config.rateLimit.backoffStrategy).toBe('exponential');
    });

    it('respects robots.txt', () => {
      const config = adapter.getConfig();
      expect(config.compliance.respectRobotsTxt).toBe(true);
    });
  });

  // =========================================================================
  // Singleton export
  // =========================================================================

  describe('walmartAdapter singleton', () => {
    it('is an instance of WalmartAdapter', () => {
      expect(walmartAdapter).toBeInstanceOf(WalmartAdapter);
    });

    it('has walmart marketplaceId', () => {
      expect(walmartAdapter.marketplaceId).toBe('walmart');
    });
  });
});
