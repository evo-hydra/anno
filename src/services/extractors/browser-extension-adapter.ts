/**
 * Browser Extension Adapter
 *
 * Tier 2 DataSourceAdapter that receives data from the Anno browser extension.
 * Processes captured data from user's authenticated sessions on Amazon, eBay, etc.
 *
 * @module extractors/browser-extension-adapter
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md Phase 3
 */

import * as crypto from 'crypto';
import { logger } from '../../utils/logger';
import {
  DataSourceAdapter,
  DataSourceChannel,
  DataSourceTier,
  DataSourceHealth,
  DataProvenance,
  MarketplaceType,
  MarketplaceListing,
  MarketplaceListingWithProvenance,
  MarketplaceConfig,
  ExtractionOptions,
  ValidationResult,
  CHANNEL_CONFIDENCE_DEFAULTS,
} from './marketplace-adapter';
import {
  ExtensionBridgeServer,
  CapturedData,
  getBridgeServer,
  createBridgeServer,
} from '../extension-bridge-server';

// ============================================================================
// Types
// ============================================================================

export interface BrowserExtensionAdapterOptions {
  bridgeServer?: ExtensionBridgeServer;
  autoStartBridge?: boolean;
  bridgePort?: number;
}

interface ExtensionOrderItem {
  title?: string;
  asin?: string;
  itemNumber?: string;
  productUrl?: string;
  price?: { amount: number; currency: string } | null;
  quantity?: number;
  imageUrl?: string;
}

interface ExtensionOrderData {
  orderId?: string;
  orderDate?: string;
  status?: string;
  total?: { amount: number; currency: string } | null;
  shipping?: { amount: number; currency: string } | null;
  items?: ExtensionOrderItem[];
  seller?: { name?: string; rating?: string };
  shippingStatus?: string;
  trackingUrl?: string;
  marketplace?: string;
  extractedAt?: string;
}

// ============================================================================
// Browser Extension Adapter
// ============================================================================

export class BrowserExtensionAdapter implements DataSourceAdapter {
  // DataSourceAdapter properties
  readonly channel: DataSourceChannel = 'browser_extension';
  readonly tier: DataSourceTier = 2;
  readonly confidenceRange = CHANNEL_CONFIDENCE_DEFAULTS.browser_extension;
  readonly requiresUserAction = true;

  // MarketplaceAdapter properties
  readonly marketplaceId: MarketplaceType = 'custom';
  readonly name = 'Browser Extension Adapter';
  readonly version = '1.0.0';

  // Internal state
  private bridgeServer: ExtensionBridgeServer;
  private successCount = 0;
  private failureCount = 0;
  private lastSuccessTime?: string;
  private processedDataIds = new Set<string>();

  constructor(options: BrowserExtensionAdapterOptions = {}) {
    this.bridgeServer = options.bridgeServer ?? getBridgeServer({
      port: options.bridgePort,
    });

    // Listen for captured data events
    this.bridgeServer.on('data', (data: CapturedData) => {
      this.handleCapturedData(data);
    });

    // Auto-start bridge if requested
    if (options.autoStartBridge) {
      this.bridgeServer.start().catch((error) => {
        logger.error('Failed to start bridge server', { error: error.message });
      });
    }
  }

  // =========================================================================
  // MarketplaceAdapter Interface
  // =========================================================================

  canHandle(content: string): boolean {
    // Check if content looks like captured extension data
    try {
      const data = JSON.parse(content);
      return !!(
        data.marketplace &&
        data.dataType &&
        Array.isArray(data.items) &&
        data.extensionVersion
      );
    } catch {
      return false;
    }
  }

  async extract(
    content: string,
    url: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListing | null> {
    const result = await this.extractWithProvenance(content, url, _options);
    return result;
  }

  validate(listing: MarketplaceListing): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!listing.title || listing.title.trim() === '') {
      errors.push('Missing item title from extension capture');
    }

    if (!listing.id) {
      errors.push('Missing item/order ID');
    }

    if (!listing.marketplace) {
      errors.push('Missing marketplace identifier');
    }

    if (listing.confidence < this.confidenceRange.min) {
      warnings.push(
        `Confidence ${listing.confidence.toFixed(2)} below expected minimum ${this.confidenceRange.min}`
      );
    }

    // Extension data should be highly reliable
    warnings.push('Browser extension capture - verify user was authenticated');

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
        requiresJavaScript: false, // Extension captures rendered DOM
      },
      rateLimit: {
        requestsPerSecond: 100, // No rate limit for local data
        requestsPerMinute: 6000,
        requestsPerHour: 360000,
        backoffStrategy: 'constant',
        retryAttempts: 0,
      },
      session: {
        requireProxy: false,
        proxyRotation: 'none',
        cookiePersistence: false,
        userAgentRotation: false,
      },
      compliance: {
        respectRobotsTxt: false, // User's own authenticated session
        userAgent: 'Anno Browser Extension',
        maxConcurrentRequests: 100,
      },
      quality: {
        minConfidenceScore: this.confidenceRange.min,
        requiredFields: ['title', 'id', 'marketplace'],
      },
      features: {
        extractDescriptions: true,
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
    _url: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null> {
    try {
      // Parse the captured data
      let capturedData: CapturedData;
      try {
        capturedData = JSON.parse(content);
      } catch {
        logger.warn('Invalid JSON content for browser extension adapter');
        this.failureCount++;
        return null;
      }

      // Validate the structure
      if (!capturedData.marketplace || !capturedData.items?.length) {
        logger.warn('Invalid captured data structure', {
          hasMarketplace: !!capturedData.marketplace,
          itemCount: capturedData.items?.length,
        });
        this.failureCount++;
        return null;
      }

      // Process the first item (for single-item extraction)
      const item = capturedData.items[0] as ExtensionOrderData;
      const listing = this.normalizeOrderItem(item, capturedData);

      if (!listing) {
        this.failureCount++;
        return null;
      }

      // Create provenance
      const provenance = this.createProvenance(capturedData);

      // Attach provenance
      const result: MarketplaceListingWithProvenance = {
        ...listing,
        provenance,
      };

      this.successCount++;
      this.lastSuccessTime = new Date().toISOString();

      logger.info('Browser extension extraction successful', {
        marketplace: capturedData.marketplace,
        itemId: listing.id,
        confidence: listing.confidence,
      });

      return result;
    } catch (error) {
      logger.error('Browser extension extraction failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      this.failureCount++;
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    // Available if bridge server is running
    return this.bridgeServer.isServerRunning();
  }

  async getHealth(): Promise<DataSourceHealth> {
    const total = this.successCount + this.failureCount;
    const failureRate = total > 0 ? this.failureCount / total : 0;

    return {
      available: this.bridgeServer.isServerRunning(),
      lastSuccessfulExtraction: this.lastSuccessTime,
      recentFailureRate: failureRate,
      estimatedReliability: Math.max(0.85, 1 - failureRate),
      statusMessage: this.bridgeServer.isServerRunning()
        ? `Bridge running on port ${this.bridgeServer.getPort()}, ${this.bridgeServer.getCapturedCount()} items pending`
        : 'Bridge server not running',
    };
  }

  // =========================================================================
  // Additional Methods
  // =========================================================================

  /**
   * Process all captured orders and return listings
   */
  async extractAllItems(
    content: string,
    _url: string,
    _options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance[]> {
    try {
      const capturedData: CapturedData = JSON.parse(content);
      const listings: MarketplaceListingWithProvenance[] = [];

      for (const item of capturedData.items as ExtensionOrderData[]) {
        const listing = this.normalizeOrderItem(item, capturedData);
        if (listing) {
          const provenance = this.createProvenance(capturedData);
          listings.push({ ...listing, provenance });
        }
      }

      return listings;
    } catch (error) {
      logger.error('Failed to extract all items', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return [];
    }
  }

  /**
   * Get pending captured data from the bridge server
   */
  getPendingData(): CapturedData[] {
    return this.bridgeServer.getCapturedData();
  }

  /**
   * Pop next pending data item for processing
   */
  popPendingData(): CapturedData | undefined {
    return this.bridgeServer.popCapturedData();
  }

  /**
   * Clear all pending data
   */
  clearPendingData(): void {
    this.bridgeServer.clearCapturedData();
  }

  /**
   * Start the bridge server
   */
  async startBridge(): Promise<void> {
    await this.bridgeServer.start();
  }

  /**
   * Stop the bridge server
   */
  async stopBridge(): Promise<void> {
    await this.bridgeServer.stop();
  }

  /**
   * Get the bridge server auth token for extension configuration
   */
  getBridgeAuthToken(): string {
    return this.bridgeServer.getAuthToken();
  }

  /**
   * Get the bridge server port
   */
  getBridgePort(): number {
    return this.bridgeServer.getPort();
  }

  // =========================================================================
  // Private Helpers
  // =========================================================================

  private handleCapturedData(data: CapturedData): void {
    // Check for duplicates
    if (this.processedDataIds.has(data.id)) {
      logger.debug('Skipping duplicate captured data', { id: data.id });
      return;
    }

    this.processedDataIds.add(data.id);

    logger.info('Received captured data from extension', {
      id: data.id,
      marketplace: data.marketplace,
      itemCount: data.items.length,
    });

    // Emit event for external listeners (e.g., orchestrator)
    // The data is already stored in the bridge server
  }

  private normalizeOrderItem(
    item: ExtensionOrderData,
    capturedData: CapturedData
  ): MarketplaceListing | null {
    // For order-level data, extract the first item or create a summary
    if (item.items && item.items.length > 0) {
      const firstItem = item.items[0];
      return this.normalizeItem(firstItem, item, capturedData);
    }

    // Single item format
    return this.normalizeItem(item as unknown as ExtensionOrderItem, item, capturedData);
  }

  private normalizeItem(
    item: ExtensionOrderItem,
    order: ExtensionOrderData,
    capturedData: CapturedData
  ): MarketplaceListing | null {
    const title = item.title;
    if (!title) {
      return null;
    }

    const itemId = item.asin || item.itemNumber || order.orderId || this.generateId();
    const marketplace = (capturedData.marketplace || 'custom') as MarketplaceType;

    return {
      id: itemId,
      marketplace,
      url: item.productUrl || capturedData.pageUrl || `extension://${marketplace}/${itemId}`,
      title,
      price: item.price || order.total || null,
      condition: undefined,
      availability: order.status?.toLowerCase().includes('delivered') ? 'sold' : 'unknown',
      soldDate: order.orderDate,
      seller: {
        name: order.seller?.name || null,
        rating: order.seller?.rating ? parseFloat(order.seller.rating) : undefined,
      },
      images: item.imageUrl ? [item.imageUrl] : [],
      itemNumber: item.asin || item.itemNumber,
      attributes: {
        orderId: order.orderId,
        quantity: item.quantity || 1,
        shippingCost: order.shipping,
        trackingUrl: order.trackingUrl,
        shippingStatus: order.shippingStatus,
      },
      extractedAt: capturedData.capturedAt || new Date().toISOString(),
      extractionMethod: 'browser_extension',
      confidence: this.calculateConfidence(item, order),
      extractorVersion: this.version,
    };
  }

  private createProvenance(capturedData: CapturedData): DataProvenance {
    return {
      channel: this.channel,
      tier: this.tier,
      confidence: this.confidenceRange.max, // Extension data is highly reliable
      freshness: 'realtime',
      sourceId: `extension_v${capturedData.extensionVersion}`,
      extractedAt: capturedData.capturedAt,
      rawDataHash: this.hashData(capturedData),
      userConsented: true, // User installed extension and clicked capture
      termsCompliant: true, // User's own authenticated session
      metadata: {
        extensionVersion: capturedData.extensionVersion,
        pageUrl: capturedData.pageUrl,
        dataType: capturedData.dataType,
        receivedAt: capturedData.receivedAt,
      },
    };
  }

  private calculateConfidence(item: ExtensionOrderItem, order: ExtensionOrderData): number {
    let confidence = this.confidenceRange.min;

    // Boost for having key fields
    if (item.title) confidence += 0.02;
    if (item.price) confidence += 0.02;
    if (item.asin || item.itemNumber) confidence += 0.02;
    if (order.orderId) confidence += 0.02;
    if (order.orderDate) confidence += 0.01;
    if (order.seller?.name) confidence += 0.01;

    return Math.min(confidence, this.confidenceRange.max);
  }

  private hashData(data: unknown): string {
    const content = JSON.stringify(data);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private generateId(): string {
    return `ext_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a browser extension adapter with default configuration
 */
export function createBrowserExtensionAdapter(
  options?: BrowserExtensionAdapterOptions
): BrowserExtensionAdapter {
  return new BrowserExtensionAdapter(options);
}

/**
 * Create a browser extension adapter with a new bridge server instance
 * (useful for testing)
 */
export function createIsolatedBrowserExtensionAdapter(
  bridgePort?: number
): BrowserExtensionAdapter {
  const bridgeServer = createBridgeServer({ port: bridgePort });
  return new BrowserExtensionAdapter({ bridgeServer });
}

// Singleton instance
let adapterInstance: BrowserExtensionAdapter | null = null;

/**
 * Get the singleton browser extension adapter
 */
export function getBrowserExtensionAdapter(): BrowserExtensionAdapter {
  if (!adapterInstance) {
    adapterInstance = new BrowserExtensionAdapter();
  }
  return adapterInstance;
}
