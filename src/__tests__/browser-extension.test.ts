/**
 * Tests for Browser Extension Components (Phase 3)
 *
 * Tests the ExtensionBridgeServer and BrowserExtensionAdapter.
 * These components enable Tier 2 data capture from user's authenticated sessions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ExtensionBridgeServer,
  createBridgeServer,
  CapturedData,
} from '../services/extension-bridge-server';
import {
  BrowserExtensionAdapter,
  createBrowserExtensionAdapter,
  createIsolatedBrowserExtensionAdapter,
} from '../services/extractors/browser-extension-adapter';
import { CHANNEL_CONFIDENCE_DEFAULTS } from '../services/extractors/marketplace-adapter';

// ============================================================================
// Test Fixtures
// ============================================================================

const AMAZON_CAPTURED_DATA: CapturedData = {
  id: 'cap_1706000000000_abc123',
  marketplace: 'amazon',
  dataType: 'orders',
  items: [
    {
      orderId: '111-1234567-1234567',
      orderDate: '2024-01-15',
      total: { amount: 348, currency: 'USD' },
      items: [
        {
          title: 'Sony WH-1000XM5 Wireless Headphones',
          asin: 'B09XS7JWHH',
          productUrl: 'https://www.amazon.com/dp/B09XS7JWHH',
          price: { amount: 348, currency: 'USD' },
          quantity: 1,
          imageUrl: 'https://images-na.ssl-images-amazon.com/images/I/51aXvjzcukL._AC_.jpg',
        },
      ],
      seller: { name: 'Amazon.com' },
      shippingStatus: 'Delivered',
    },
  ],
  pageUrl: 'https://www.amazon.com/gp/your-account/order-history',
  capturedAt: '2024-01-20T10:30:00.000Z',
  extensionVersion: '1.0.0',
  receivedAt: '2024-01-20T10:30:01.000Z',
};

const EBAY_CAPTURED_DATA: CapturedData = {
  id: 'cap_1706000001000_def456',
  marketplace: 'ebay',
  dataType: 'purchases',
  items: [
    {
      orderId: '12-34567-89012',
      orderDate: '2024-01-18',
      total: { amount: 312.98, currency: 'USD' },
      items: [
        {
          title: 'Nintendo Switch OLED Console - White',
          itemNumber: '123456789012',
          productUrl: 'https://www.ebay.com/itm/123456789012',
          price: { amount: 299.99, currency: 'USD' },
          quantity: 1,
        },
      ],
      seller: { name: 'seller123', rating: '99.5' },
      shipping: { amount: 12.99, currency: 'USD' },
      status: 'Delivered',
    },
  ],
  pageUrl: 'https://www.ebay.com/myb/PurchaseHistory',
  capturedAt: '2024-01-20T14:45:00.000Z',
  extensionVersion: '1.0.0',
  receivedAt: '2024-01-20T14:45:01.000Z',
};

const MULTI_ITEM_ORDER: CapturedData = {
  id: 'cap_1706000002000_ghi789',
  marketplace: 'amazon',
  dataType: 'orders',
  items: [
    {
      orderId: '111-7654321-7654321',
      orderDate: '2024-01-10',
      total: { amount: 125.97, currency: 'USD' },
      items: [
        {
          title: 'USB-C Cable 3-Pack',
          asin: 'B08ABC1234',
          price: { amount: 15.99, currency: 'USD' },
          quantity: 1,
        },
        {
          title: 'Wireless Mouse',
          asin: 'B08DEF5678',
          price: { amount: 29.99, currency: 'USD' },
          quantity: 1,
        },
        {
          title: 'Keyboard Stand',
          asin: 'B08GHI9012',
          price: { amount: 79.99, currency: 'USD' },
          quantity: 1,
        },
      ],
      seller: { name: 'TechStore' },
    },
  ],
  pageUrl: 'https://www.amazon.com/gp/your-account/order-history',
  capturedAt: '2024-01-20T16:00:00.000Z',
  extensionVersion: '1.0.0',
  receivedAt: '2024-01-20T16:00:01.000Z',
};

// ============================================================================
// ExtensionBridgeServer Tests
// ============================================================================

describe('ExtensionBridgeServer', () => {
  let server: ExtensionBridgeServer;

  beforeEach(() => {
    // Use random port for each test to avoid conflicts
    const port = 30000 + Math.floor(Math.random() * 10000);
    server = createBridgeServer({ port });
  });

  afterEach(async () => {
    if (server.isServerRunning()) {
      await server.stop();
    }
  });

  describe('server lifecycle', () => {
    it('starts and stops correctly', async () => {
      expect(server.isServerRunning()).toBe(false);

      await server.start();
      expect(server.isServerRunning()).toBe(true);

      await server.stop();
      expect(server.isServerRunning()).toBe(false);
    });

    it('generates auth token on creation', () => {
      const token = server.getAuthToken();
      expect(token).toBeDefined();
      expect(token.length).toBe(64); // 32 bytes hex = 64 chars
    });

    it('uses configured port', () => {
      const customPort = 4567;
      const customServer = createBridgeServer({ port: customPort });
      expect(customServer.getPort()).toBe(customPort);
    });
  });

  describe('data management', () => {
    it('starts with empty captured data', () => {
      expect(server.getCapturedData()).toEqual([]);
      expect(server.getCapturedCount()).toBe(0);
    });

    it('clears captured data', () => {
      // Manually add some data for testing
      const data = server.getCapturedData();
      expect(data.length).toBe(0);

      server.clearCapturedData();
      expect(server.getCapturedCount()).toBe(0);
    });
  });

  describe('data filtering', () => {
    it('filters by marketplace', () => {
      const amazonData = server.getCapturedDataByMarketplace('amazon');
      expect(Array.isArray(amazonData)).toBe(true);
    });
  });
});

// ============================================================================
// BrowserExtensionAdapter Tests
// ============================================================================

describe('BrowserExtensionAdapter', () => {
  let adapter: BrowserExtensionAdapter;
  let bridgeServer: ExtensionBridgeServer;

  beforeEach(() => {
    const port = 30000 + Math.floor(Math.random() * 10000);
    bridgeServer = createBridgeServer({ port });
    adapter = createBrowserExtensionAdapter({ bridgeServer });
  });

  afterEach(async () => {
    if (bridgeServer.isServerRunning()) {
      await bridgeServer.stop();
    }
  });

  describe('adapter properties', () => {
    it('has correct channel and tier', () => {
      expect(adapter.channel).toBe('browser_extension');
      expect(adapter.tier).toBe(2);
    });

    it('has correct confidence range', () => {
      expect(adapter.confidenceRange).toEqual(CHANNEL_CONFIDENCE_DEFAULTS.browser_extension);
    });

    it('requires user action', () => {
      expect(adapter.requiresUserAction).toBe(true);
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });

    it('has correct name', () => {
      expect(adapter.name).toBe('Browser Extension Adapter');
    });
  });

  describe('canHandle', () => {
    it('handles valid captured data JSON', () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      expect(adapter.canHandle(content)).toBe(true);
    });

    it('rejects invalid JSON', () => {
      expect(adapter.canHandle('not json')).toBe(false);
    });

    it('rejects JSON without required fields', () => {
      expect(adapter.canHandle(JSON.stringify({ foo: 'bar' }))).toBe(false);
      expect(adapter.canHandle(JSON.stringify({ marketplace: 'amazon' }))).toBe(false);
    });
  });

  describe('extract - Amazon data', () => {
    it('extracts listing from Amazon captured data', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('amazon');
      expect(listing!.title).toBe('Sony WH-1000XM5 Wireless Headphones');
      expect(listing!.itemNumber).toBe('B09XS7JWHH');
    });

    it('extracts price correctly', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');

      expect(listing!.price).toEqual({ amount: 348, currency: 'USD' });
    });

    it('extracts seller information', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');

      expect(listing!.seller.name).toBe('Amazon.com');
    });

    it('extracts images', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');

      expect(listing!.images.length).toBe(1);
      expect(listing!.images[0]).toContain('ssl-images-amazon.com');
    });
  });

  describe('extract - eBay data', () => {
    it('extracts listing from eBay captured data', async () => {
      const content = JSON.stringify(EBAY_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://ebay');

      expect(listing).not.toBeNull();
      expect(listing!.marketplace).toBe('ebay');
      expect(listing!.title).toBe('Nintendo Switch OLED Console - White');
      expect(listing!.itemNumber).toBe('123456789012');
    });

    it('extracts seller rating', async () => {
      const content = JSON.stringify(EBAY_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://ebay');

      expect(listing!.seller.name).toBe('seller123');
      expect(listing!.seller.rating).toBe(99.5);
    });

    it('extracts shipping cost in attributes', async () => {
      const content = JSON.stringify(EBAY_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://ebay');

      expect(listing!.attributes?.shippingCost).toEqual({ amount: 12.99, currency: 'USD' });
    });
  });

  describe('extractWithProvenance', () => {
    it('includes provenance data', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const result = await adapter.extractWithProvenance(content, 'extension://amazon');

      expect(result).not.toBeNull();
      expect(result!.provenance).toBeDefined();
      expect(result!.provenance.channel).toBe('browser_extension');
      expect(result!.provenance.tier).toBe(2);
      expect(result!.provenance.userConsented).toBe(true);
      expect(result!.provenance.termsCompliant).toBe(true);
    });

    it('includes extension version in provenance', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const result = await adapter.extractWithProvenance(content, 'extension://amazon');

      expect(result!.provenance.sourceId).toBe('extension_v1.0.0');
    });

    it('includes raw data hash', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const result = await adapter.extractWithProvenance(content, 'extension://amazon');

      expect(result!.provenance.rawDataHash).toBeDefined();
      expect(result!.provenance.rawDataHash!.length).toBe(16);
    });

    it('sets freshness to realtime', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const result = await adapter.extractWithProvenance(content, 'extension://amazon');

      expect(result!.provenance.freshness).toBe('realtime');
    });
  });

  describe('extractAllItems', () => {
    it('extracts multiple items from an order', async () => {
      const content = JSON.stringify(MULTI_ITEM_ORDER);
      const listings = await adapter.extractAllItems(content, 'extension://amazon');

      // Should extract the first item from the order
      expect(listings.length).toBeGreaterThan(0);
      expect(listings[0].title).toBe('USB-C Cable 3-Pack');
    });

    it('each item has provenance', async () => {
      const content = JSON.stringify(MULTI_ITEM_ORDER);
      const listings = await adapter.extractAllItems(content, 'extension://amazon');

      listings.forEach((listing) => {
        expect(listing.provenance).toBeDefined();
        expect(listing.provenance.channel).toBe('browser_extension');
      });
    });
  });

  describe('validate', () => {
    it('validates complete listing', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');
      const result = adapter.validate(listing!);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails validation without title', () => {
      const listing = {
        id: 'test',
        marketplace: 'amazon' as const,
        url: 'extension://test',
        title: '',
        confidence: 0.9,
        extractedAt: new Date().toISOString(),
        extractionMethod: 'browser_extension',
        extractorVersion: '1.0.0',
        seller: { name: null },
        images: [],
        availability: 'unknown' as const,
      };

      const result = adapter.validate(listing);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing item title from extension capture');
    });

    it('warns about authentication verification', async () => {
      const content = JSON.stringify(AMAZON_CAPTURED_DATA);
      const listing = await adapter.extract(content, 'extension://amazon');
      const result = adapter.validate(listing!);

      expect(result.warnings.some((w) => w.includes('authenticated'))).toBe(true);
    });
  });

  describe('health monitoring', () => {
    it('reports unavailable when bridge not running', async () => {
      const available = await adapter.isAvailable();
      expect(available).toBe(false);
    });

    it('reports available when bridge is running', async () => {
      await bridgeServer.start();
      const available = await adapter.isAvailable();
      expect(available).toBe(true);
    });

    it('returns health status', async () => {
      const health = await adapter.getHealth();

      expect(health).toHaveProperty('available');
      expect(health).toHaveProperty('recentFailureRate');
      expect(health).toHaveProperty('estimatedReliability');
      expect(health).toHaveProperty('statusMessage');
    });

    it('health includes bridge port info when running', async () => {
      await bridgeServer.start();
      const health = await adapter.getHealth();

      expect(health.available).toBe(true);
      expect(health.statusMessage).toContain('Bridge running');
    });
  });

  describe('getConfig', () => {
    it('returns valid configuration', () => {
      const config = adapter.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.rendering.requiresJavaScript).toBe(false);
      expect(config.session.requireProxy).toBe(false);
      expect(config.compliance.respectRobotsTxt).toBe(false);
    });

    it('has correct quality settings', () => {
      const config = adapter.getConfig();

      expect(config.quality.minConfidenceScore).toBe(CHANNEL_CONFIDENCE_DEFAULTS.browser_extension.min);
      expect(config.quality.requiredFields).toContain('title');
      expect(config.quality.requiredFields).toContain('id');
    });
  });

  describe('bridge server interaction', () => {
    it('can start bridge through adapter', async () => {
      expect(bridgeServer.isServerRunning()).toBe(false);
      await adapter.startBridge();
      expect(bridgeServer.isServerRunning()).toBe(true);
    });

    it('can stop bridge through adapter', async () => {
      await adapter.startBridge();
      expect(bridgeServer.isServerRunning()).toBe(true);
      await adapter.stopBridge();
      expect(bridgeServer.isServerRunning()).toBe(false);
    });

    it('can get bridge auth token', () => {
      const token = adapter.getBridgeAuthToken();
      expect(token).toBeDefined();
      expect(token.length).toBe(64);
    });

    it('can get bridge port', () => {
      const port = adapter.getBridgePort();
      expect(port).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Browser Extension Integration', () => {
  it('adapter tier matches channel tier map', () => {
    const adapter = createIsolatedBrowserExtensionAdapter();
    expect(adapter.tier).toBe(2);
    expect(adapter.channel).toBe('browser_extension');
  });

  it('adapter implements DataSourceAdapter interface', () => {
    const adapter = createIsolatedBrowserExtensionAdapter();

    // Check all required DataSourceAdapter properties
    expect(adapter.channel).toBeDefined();
    expect(adapter.tier).toBeDefined();
    expect(adapter.confidenceRange).toBeDefined();
    expect(adapter.requiresUserAction).toBeDefined();

    // Check all required methods
    expect(typeof adapter.canHandle).toBe('function');
    expect(typeof adapter.extract).toBe('function');
    expect(typeof adapter.extractWithProvenance).toBe('function');
    expect(typeof adapter.isAvailable).toBe('function');
    expect(typeof adapter.getHealth).toBe('function');
    expect(typeof adapter.validate).toBe('function');
    expect(typeof adapter.getConfig).toBe('function');
  });

  it('confidence falls within defined range', async () => {
    const adapter = createIsolatedBrowserExtensionAdapter();
    const content = JSON.stringify(AMAZON_CAPTURED_DATA);
    const listing = await adapter.extract(content, 'extension://amazon');

    expect(listing!.confidence).toBeGreaterThanOrEqual(adapter.confidenceRange.min);
    expect(listing!.confidence).toBeLessThanOrEqual(adapter.confidenceRange.max);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  let adapter: BrowserExtensionAdapter;

  beforeEach(() => {
    adapter = createIsolatedBrowserExtensionAdapter();
  });

  it('handles empty items array', async () => {
    const emptyData = {
      ...AMAZON_CAPTURED_DATA,
      items: [],
    };
    const content = JSON.stringify(emptyData);
    const listing = await adapter.extract(content, 'extension://amazon');

    expect(listing).toBeNull();
  });

  it('handles missing optional fields', async () => {
    const minimalData: CapturedData = {
      id: 'cap_minimal',
      marketplace: 'amazon',
      dataType: 'orders',
      items: [
        {
          items: [{ title: 'Minimal Item' }],
        },
      ],
      capturedAt: new Date().toISOString(),
      extensionVersion: '1.0.0',
      receivedAt: new Date().toISOString(),
    };
    const content = JSON.stringify(minimalData);
    const listing = await adapter.extract(content, 'extension://amazon');

    expect(listing).not.toBeNull();
    expect(listing!.title).toBe('Minimal Item');
    expect(listing!.price).toBeNull();
  });

  it('handles malformed JSON gracefully', async () => {
    const listing = await adapter.extract('{ invalid json }', 'extension://test');
    expect(listing).toBeNull();
  });

  it('handles missing marketplace gracefully', async () => {
    const noMarketplace = {
      ...AMAZON_CAPTURED_DATA,
      marketplace: undefined,
    };
    const content = JSON.stringify(noMarketplace);
    const listing = await adapter.extract(content, 'extension://test');

    expect(listing).toBeNull();
  });
});
