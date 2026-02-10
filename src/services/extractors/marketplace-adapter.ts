/**
 * Marketplace Adapter System - Core Types & Interfaces
 *
 * Provides a formal, extensible architecture for extracting structured data
 * from multiple e-commerce marketplaces (eBay, Amazon, Walmart, etc.).
 *
 * @module marketplace-adapter
 * @see docs/specs/MARKETPLACE_ADAPTER_RFC.md
 */

// ============================================================================
// Core Types
// ============================================================================

export type MarketplaceType = 'ebay' | 'amazon' | 'walmart' | 'etsy' | 'custom';

export interface MoneyAmount {
  amount: number;
  currency: string; // ISO 4217 code (USD, GBP, EUR, etc.)
}

export type ProductCondition =
  | 'new'
  | 'used_like_new'
  | 'used_very_good'
  | 'used_good'
  | 'used_acceptable'
  | 'refurbished'
  | 'unknown';

export type AvailabilityStatus =
  | 'in_stock'
  | 'sold'
  | 'out_of_stock'
  | 'unavailable'
  | 'unknown';

// ============================================================================
// Data Source Channel Types (Multi-Channel Architecture)
// ============================================================================

/**
 * Data source channel classification.
 * Defines how data was obtained, enabling fallback chains and confidence scoring.
 *
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */
export type DataSourceChannel =
  | 'official_api'      // Tier 1: Official marketplace APIs (eBay Browse, Amazon PA-API)
  | 'financial_api'     // Tier 1: Financial aggregators (Plaid, Finicity)
  | 'browser_extension' // Tier 2: User's authenticated browser context
  | 'data_export'       // Tier 2: User-initiated data download (Amazon Privacy Central)
  | 'email_parsing'     // Tier 2: Order confirmation email extraction
  | 'cookie_import'     // Tier 2: Manual session cookie import
  | 'scraping'          // Tier 3: Playwright/Puppeteer HTML extraction
  | 'ocr_extraction'    // Tier 4: Screenshot/PDF OCR processing
  | 'llm_extraction';   // Tier 4: LLM-based structure extraction

/**
 * Data source tier classification.
 * Higher tiers are preferred due to reliability and compliance.
 */
export type DataSourceTier = 1 | 2 | 3 | 4;

/**
 * Maps channels to their tiers for quick lookup
 */
export const CHANNEL_TIER_MAP: Record<DataSourceChannel, DataSourceTier> = {
  official_api: 1,
  financial_api: 1,
  browser_extension: 2,
  data_export: 2,
  email_parsing: 2,
  cookie_import: 2,
  scraping: 3,
  ocr_extraction: 4,
  llm_extraction: 4,
};

/**
 * Default confidence ranges per channel
 */
export const CHANNEL_CONFIDENCE_DEFAULTS: Record<DataSourceChannel, { min: number; max: number }> = {
  official_api: { min: 0.95, max: 1.0 },
  financial_api: { min: 0.90, max: 0.98 },
  browser_extension: { min: 0.85, max: 0.95 },
  data_export: { min: 0.85, max: 0.95 },
  email_parsing: { min: 0.80, max: 0.90 },
  cookie_import: { min: 0.80, max: 0.90 },
  scraping: { min: 0.70, max: 0.85 },
  ocr_extraction: { min: 0.60, max: 0.80 },
  llm_extraction: { min: 0.55, max: 0.75 },
};

/**
 * Data freshness classification
 */
export type DataFreshness = 'realtime' | 'recent' | 'historical';

/**
 * Source provenance - tracks how data was obtained.
 * Critical for confidence scoring, debugging, and compliance.
 */
export interface DataProvenance {
  /** Which channel was used to obtain this data */
  channel: DataSourceChannel;

  /** Tier classification (1-4, lower is more reliable) */
  tier: DataSourceTier;

  /** Confidence score for this extraction (0.0 - 1.0) */
  confidence: number;

  /** How fresh is this data? */
  freshness: DataFreshness;

  /** Identifier for the specific source (API key ID, extension version, etc.) */
  sourceId: string;

  /** When was this data extracted? (ISO 8601) */
  extractedAt: string;

  /** Content-addressed hash of raw source data for verification */
  rawDataHash?: string;

  /** Did the user explicitly authorize this data collection? */
  userConsented: boolean;

  /** Does this extraction comply with marketplace Terms of Service? */
  termsCompliant: boolean;

  /** Additional source-specific metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// MarketplaceListing - Normalized Output Schema
// ============================================================================

/**
 * Normalized listing data across all marketplaces.
 * All marketplace adapters emit this standardized schema.
 */
export interface MarketplaceListing {
  // Identification
  id: string; // Unique listing ID (marketplace-specific)
  marketplace: MarketplaceType;
  url: string; // Canonical listing URL

  // Core listing data
  title: string;
  description?: string; // May require additional extraction

  // Pricing
  price: MoneyAmount | null;
  originalPrice?: MoneyAmount; // For sale items
  shippingCost?: MoneyAmount;

  // Condition & availability
  condition?: ProductCondition;
  availability: AvailabilityStatus;
  soldDate?: string; // ISO 8601 date (for sold listings)
  quantityAvailable?: number;

  // Seller information
  seller: {
    id?: string;
    name: string | null;
    rating?: number; // 0-100 normalized
    reviewCount?: number;
    verified?: boolean;
  };

  // Media
  images: string[]; // Array of image URLs

  // Metadata
  itemNumber?: string; // Marketplace-specific SKU/item number
  category?: string[]; // Breadcrumb array
  attributes?: Record<string, any>; // Marketplace-specific attributes

  // Extraction metadata
  extractedAt: string; // ISO 8601 timestamp
  extractionMethod: string; // e.g., 'ebay-adapter-v1.0'
  confidence: number; // 0.0 - 1.0 extraction confidence score

  // Provenance
  rawDataHash?: string; // Content-addressed hash of source HTML
  extractorVersion: string; // Adapter version for schema evolution
}

/**
 * Extended listing with full provenance tracking.
 * Used by DataSourceAdapter for multi-channel data with source attribution.
 */
export interface MarketplaceListingWithProvenance extends MarketplaceListing {
  /** Full provenance information for this extraction */
  provenance: DataProvenance;

  /**
   * If the same data was confirmed by multiple sources, list them here.
   * Higher confidence when multiple independent sources agree.
   */
  correlatedSources?: DataProvenance[];

  /**
   * If different sources returned conflicting values for the same field,
   * document the conflicts for manual resolution or algorithmic merging.
   */
  conflictingData?: Array<{
    field: keyof MarketplaceListing;
    values: Array<{
      source: DataProvenance;
      value: unknown;
    }>;
  }>;
}

// ============================================================================
// MarketplaceAdapter Interface
// ============================================================================

/**
 * Options for extraction behavior
 */
export interface ExtractionOptions {
  extractImages?: boolean; // Default: true
  extractDescription?: boolean; // May require additional fetch
  includeRawData?: boolean; // Include raw HTML hash
  timeout?: number; // Milliseconds
}

/**
 * Result of validation checks
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Formal interface that all marketplace adapters must implement.
 */
export interface MarketplaceAdapter {
  /**
   * Unique identifier for this adapter
   */
  readonly marketplaceId: MarketplaceType;

  /**
   * Human-readable name
   */
  readonly name: string;

  /**
   * Semantic version of this adapter
   */
  readonly version: string;

  /**
   * Check if a URL belongs to this marketplace
   */
  canHandle(url: string): boolean;

  /**
   * Extract structured listing data from HTML/JSON
   * @param content - Raw HTML or JSON response from marketplace
   * @param url - Source URL (for context and validation)
   * @param options - Adapter-specific extraction options
   * @returns Normalized MarketplaceListing or null if extraction failed
   */
  extract(
    content: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListing | null>;

  /**
   * Validate extracted listing meets quality thresholds
   */
  validate(listing: MarketplaceListing): ValidationResult;

  /**
   * Get adapter-specific configuration
   */
  getConfig(): MarketplaceConfig;
}

// ============================================================================
// MarketplaceConfig - Per-Marketplace Compliance
// ============================================================================

/**
 * Per-marketplace compliance and operational configuration
 */
export interface MarketplaceConfig {
  marketplaceId: MarketplaceType;
  enabled: boolean; // Feature flag control

  // Rendering & fetch requirements
  rendering: {
    requiresJavaScript: boolean; // If true, use headless browser
    waitForSelectors?: string[]; // CSS selectors to wait for
    waitTime?: number; // Additional wait time (ms)
    blockResources?: string[]; // Resource types to block
  };

  // Rate limiting
  rateLimit: {
    requestsPerSecond: number;
    requestsPerMinute: number;
    requestsPerHour: number;
    burstSize?: number; // Token bucket burst capacity
    backoffStrategy: 'exponential' | 'linear' | 'constant';
    retryAttempts: number;
  };

  // Proxy & session strategy
  session: {
    requireProxy: boolean;
    proxyRotation: 'per_request' | 'per_session' | 'none';
    cookiePersistence: boolean;
    userAgentRotation: boolean;
    sessionDuration?: number; // Max session lifetime (minutes)
  };

  // Compliance rules
  compliance: {
    respectRobotsTxt: boolean;
    crawlDelay?: number; // Minimum delay between requests (ms)
    userAgent: string;
    maxConcurrentRequests: number;
  };

  // Validation thresholds
  quality: {
    minConfidenceScore: number; // 0.0 - 1.0
    requiredFields: (keyof MarketplaceListing)[];
  };

  // Feature flags (granular rollout control)
  features: {
    extractDescriptions: boolean;
    extractReviews: boolean;
    extractVariants: boolean;
    enableBackfill: boolean;
  };
}

// ============================================================================
// Extraction Results & Metrics
// ============================================================================

/**
 * Result of a marketplace extraction attempt
 */
export interface ExtractionResult {
  success: boolean;
  listing?: MarketplaceListing;
  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };
  metadata: {
    duration: number; // Milliseconds
    retryCount: number;
    rateLimited: boolean;
    cached: boolean;
  };
}

/**
 * Aggregated metrics for a marketplace
 */
export interface MarketplaceMetrics {
  totalExtractions: number;
  successfulExtractions: number;
  failedExtractions: number;
  averageConfidence: number;
  averageDuration: number;
  rateLimitHits: number;
  cacheHitRate: number;
}

// ============================================================================
// Extraction Event Pipeline
// ============================================================================

/**
 * Structured extraction event schema
 */
export interface ExtractionEvent {
  eventId: string; // UUID
  timestamp: string; // ISO 8601
  eventType: 'extraction_success' | 'extraction_failure' | 'validation_warning';

  // Source context
  marketplace: MarketplaceType;
  url: string;

  // Extraction result
  listing?: MarketplaceListing;

  // Diagnostics
  duration: number; // Milliseconds
  confidence?: number;
  validationErrors?: string[];
  validationWarnings?: string[];

  // Provenance
  extractorVersion: string;
  adapterVersion: string;

  // Compliance tracking
  rateLimited: boolean;
  retryCount: number;
  renderingUsed: boolean;
}

/**
 * Event filter for subscriptions
 */
export interface EventFilter {
  marketplaces?: MarketplaceType[];
  eventTypes?: ExtractionEvent['eventType'][];
  minConfidence?: number;
}

export type Unsubscribe = () => void;

/**
 * Event pipeline for streaming extraction events
 */
export interface ExtractionEventPipeline {
  /**
   * Emit an extraction event
   */
  emit(event: ExtractionEvent): Promise<void>;

  /**
   * Subscribe to extraction events (for analytics/AI consumers)
   */
  subscribe(
    handler: (event: ExtractionEvent) => void | Promise<void>,
    filter?: EventFilter
  ): Unsubscribe;
}

// ============================================================================
// Backfill Job System
// ============================================================================

/**
 * Backfill job configuration
 */
export interface BackfillJob {
  jobId: string;
  marketplace: MarketplaceType;

  // URL source
  urlSource: {
    type: 'file' | 'database' | 'generator';
    config: any; // Source-specific config
  };

  // Execution parameters
  concurrency: number; // Parallel workers
  batchSize: number; // URLs per batch

  // Compliance (inherited from marketplace config, can override)
  rateLimit?: Partial<MarketplaceConfig['rateLimit']>;

  // Progress tracking
  checkpoint: {
    enabled: boolean;
    interval: number; // Save every N items
    storage: 'file' | 'database';
  };

  // Error handling
  errorHandling: {
    maxConsecutiveFailures: number;
    pauseOnError: boolean;
    skipFailedUrls: boolean;
    retryStrategy: 'immediate' | 'deferred' | 'skip';
  };

  // Output
  output: {
    format: 'jsonl' | 'csv' | 'database';
    destination: string;
    emitEvents: boolean; // Emit to event pipeline
  };
}

/**
 * Backfill job status
 */
export interface BackfillStatus {
  jobId: string;
  state: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  progress: {
    totalUrls: number;
    processedUrls: number;
    successfulExtractions: number;
    failedExtractions: number;
    averageConfidence: number;
  };
  timing: {
    startedAt?: string;
    estimatedCompletion?: string;
    duration: number;
  };
  currentCheckpoint?: string;
}

// ============================================================================
// Search Functionality (for sold price lookups)
// ============================================================================

/**
 * Search options for marketplace queries
 */
export interface SearchOptions {
  soldOnly?: boolean; // Filter to sold/completed listings (eBay-specific)
  maxResults?: number; // Limit result count (default: 50)
  sortBy?: 'relevance' | 'price_low' | 'price_high' | 'date_new' | 'date_old';
  filters?: {
    priceMin?: number;
    priceMax?: number;
    condition?: ProductCondition[];
    seller?: string;
  };
  dateRange?: {
    from?: string; // ISO 8601 date
    to?: string;
  };
}

/**
 * Single search result item
 */
export interface SearchResult {
  url: string;
  listing: MarketplaceListing;
}

/**
 * Price statistics aggregated from search results
 */
export interface PriceStatistics {
  count: number;
  low: number;
  median: number;
  high: number;
  average: number;
  prices: number[]; // Sorted array of all prices
  currency: string; // ISO 4217 code
}

/**
 * Complete search response with results and aggregations
 */
export interface SearchResponse {
  query: string;
  marketplace: MarketplaceType;
  results: SearchResult[];
  totalResults: number; // Total available (may be > results.length)
  priceStats?: PriceStatistics; // Aggregated price statistics
  searchedAt: string; // ISO 8601 timestamp
}

/**
 * Extended adapter interface with search capability
 * Implement this interface for marketplaces that support search
 */
export interface MarketplaceSearchAdapter extends MarketplaceAdapter {
  /**
   * Search marketplace for products matching query
   * @param query - Search query string
   * @param options - Search options (filters, sorting, etc.)
   * @returns Search results with aggregated statistics
   */
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;

  /**
   * Search for sold prices specifically (convenience method)
   * @param query - Search query string
   * @param options - Search options
   * @returns Price statistics from sold listings
   */
  searchSoldPrices(query: string, options?: SearchOptions): Promise<PriceStatistics | null>;
}

// ============================================================================
// Validation Job System
// ============================================================================

/**
 * Nightly validation job configuration
 */
export interface ValidationJob {
  marketplace: MarketplaceType;

  // Sample a set of known URLs
  sampleUrls: string[];

  // Expected results (ground truth)
  expectedResults: Partial<MarketplaceListing>[];

  // Thresholds for alerts
  thresholds: {
    minAccuracy: number; // % of fields matching expected
    maxFailureRate: number; // % of extractions allowed to fail
    minAverageConfidence: number;
  };

  // Alerting
  onFailure: (report: ValidationReport) => void;
}

/**
 * Validation report
 */
export interface ValidationReport {
  marketplace: MarketplaceType;
  timestamp: string;
  totalSamples: number;
  passedSamples: number;
  failedSamples: number;
  accuracy: number; // 0.0 - 1.0
  averageConfidence: number;
  errors: Array<{
    url: string;
    expected: Partial<MarketplaceListing>;
    actual: Partial<MarketplaceListing> | null;
    diff: string[];
  }>;
}

// ============================================================================
// DataSourceAdapter - Multi-Channel Extension
// ============================================================================

/**
 * Health status for a data source
 */
export interface DataSourceHealth {
  /** Is this source currently available? */
  available: boolean;

  /** When was the last successful extraction? (ISO 8601) */
  lastSuccessfulExtraction?: string;

  /** Failure rate in the recent window (0.0 - 1.0) */
  recentFailureRate: number;

  /** Estimated current reliability based on recent performance */
  estimatedReliability: number;

  /** Human-readable status message */
  statusMessage?: string;
}

/**
 * Extended adapter interface for multi-channel data sources.
 * Adds provenance tracking, health monitoring, and channel classification.
 *
 * Existing adapters can be wrapped to implement this interface
 * without breaking backward compatibility.
 *
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */
export interface DataSourceAdapter extends MarketplaceAdapter {
  /**
   * Which channel does this adapter use?
   */
  readonly channel: DataSourceChannel;

  /**
   * Which tier is this adapter? (1 = most reliable, 4 = fallback)
   */
  readonly tier: DataSourceTier;

  /**
   * Default confidence range for extractions from this source
   */
  readonly confidenceRange: { min: number; max: number };

  /**
   * Does this adapter require user action to initiate?
   * (e.g., browser extension install, manual file upload, etc.)
   */
  readonly requiresUserAction: boolean;

  /**
   * Extract with full provenance tracking.
   * Primary extraction method for DataSourceAdapter.
   *
   * @param content - Raw HTML, JSON, CSV, or other content
   * @param url - Source URL or identifier
   * @param options - Extraction options
   * @returns Listing with provenance or null if extraction failed
   */
  extractWithProvenance(
    content: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null>;

  /**
   * Check if this source is currently available.
   * (e.g., API key valid, browser extension installed, session active)
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get health status of this data source.
   * Used for fallback decisions and monitoring.
   */
  getHealth(): Promise<DataSourceHealth>;
}

/**
 * Options for DataSourceOrchestrator.getData()
 */
export interface OrchestratorGetOptions {
  /** Preferred tiers to try first (default: [1, 2, 3, 4]) */
  preferredTiers?: DataSourceTier[];

  /** Minimum confidence required (default: 0.5) */
  requiredConfidence?: number;

  /** Allow fallback to lower tiers if preferred fails (default: true) */
  allowFallback?: boolean;

  /** Timeout for entire operation in milliseconds */
  timeout?: number;

  /** Specific channels to include (if not specified, all available) */
  includeChannels?: DataSourceChannel[];

  /** Channels to exclude from consideration */
  excludeChannels?: DataSourceChannel[];
}

/**
 * Result from DataSourceOrchestrator.getData()
 */
export interface OrchestratorResult {
  /** The extracted data, or null if all sources failed */
  data: MarketplaceListingWithProvenance | null;

  /** All sources that were attempted, in order */
  attemptedSources: Array<{
    channel: DataSourceChannel;
    tier: DataSourceTier;
    success: boolean;
    error?: string;
    duration: number;
  }>;

  /** Was a fallback source used? */
  fallbackUsed: boolean;

  /** Total time taken across all attempts */
  totalDuration: number;
}

/**
 * Result from DataSourceOrchestrator.getFromAllSources()
 */
export interface MultiSourceResult {
  /** Merged/deduplicated data from all sources */
  mergedData: MarketplaceListingWithProvenance | null;

  /** All successful source extractions */
  sources: Array<{
    provenance: DataProvenance;
    listing: MarketplaceListing;
  }>;

  /** Fields with conflicting values between sources */
  conflicts: Array<{
    field: keyof MarketplaceListing;
    values: Array<{
      source: DataProvenance;
      value: unknown;
    }>;
    resolvedValue?: unknown;
    resolutionMethod?: 'highest_tier' | 'majority' | 'most_recent' | 'manual';
  }>;
}

/**
 * Orchestrates fallback between multiple data sources.
 * Provides unified access to marketplace data regardless of source.
 *
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md
 */
export interface DataSourceOrchestrator {
  /**
   * Register an adapter for a marketplace + channel combination.
   * The same marketplace can have multiple adapters for different channels.
   */
  registerAdapter(
    marketplace: MarketplaceType,
    adapter: DataSourceAdapter
  ): void;

  /**
   * Unregister an adapter
   */
  unregisterAdapter(
    marketplace: MarketplaceType,
    channel: DataSourceChannel
  ): void;

  /**
   * Get data using best available source with automatic fallback.
   * Tries sources in tier order until one succeeds.
   */
  getData(
    marketplace: MarketplaceType,
    identifier: string, // URL, order ID, search query, etc.
    options?: OrchestratorGetOptions
  ): Promise<OrchestratorResult>;

  /**
   * Get from all available sources and merge/deduplicate.
   * Useful when you want maximum confidence through source correlation.
   */
  getFromAllSources(
    marketplace: MarketplaceType,
    identifier: string,
    options?: OrchestratorGetOptions
  ): Promise<MultiSourceResult>;

  /**
   * Configure fallback chain for a marketplace.
   * Overrides the default tier-based ordering.
   */
  setFallbackChain(
    marketplace: MarketplaceType,
    chain: DataSourceChannel[]
  ): void;

  /**
   * Get the current fallback chain for a marketplace
   */
  getFallbackChain(marketplace: MarketplaceType): DataSourceChannel[];

  /**
   * Get health status for all registered adapters
   */
  getHealthReport(): Promise<
    Map<MarketplaceType, Map<DataSourceChannel, DataSourceHealth>>
  >;

  /**
   * Get list of available adapters for a marketplace
   */
  getAvailableAdapters(
    marketplace: MarketplaceType
  ): Array<{ channel: DataSourceChannel; tier: DataSourceTier; available: boolean }>;
}
