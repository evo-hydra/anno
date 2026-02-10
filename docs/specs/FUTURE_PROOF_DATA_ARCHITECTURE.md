# Anno Future-Proof Data Source Architecture

> **Status**: ✅ IMPLEMENTED
> **Author**: Claude (Research Session - January 2026)
> **Last Updated**: 2026-01-27
> **Implementation Completed**: 2026-01-27

## Executive Summary

This document captures deep research on marketplace data extraction strategies and proposes a multi-channel, future-proof architecture for Anno. The goal is to build a system that gracefully degrades when one data source becomes unavailable, rather than catastrophically failing.

### Implementation Summary

All 5 phases have been implemented. Here's what was built:

| Component | File | Tests |
|-----------|------|-------|
| DataSourceAdapter interface | `src/services/extractors/marketplace-adapter.ts` | ✅ |
| Amazon CSV Export Adapter | `src/services/extractors/amazon-data-export-adapter.ts` | 30 tests |
| eBay CSV Export Adapter | `src/services/extractors/ebay-data-export-adapter.ts` | 27 tests |
| Browser Extension | `browser-extension/` | N/A (JS) |
| Extension Bridge Server | `src/services/extension-bridge-server.ts` | 47 tests |
| BrowserExtensionAdapter | `src/services/extractors/browser-extension-adapter.ts` | (included above) |
| DataSourceOrchestrator | `src/services/extractors/data-source-orchestrator.ts` | 27 tests |
| LLM Extraction Adapter | `src/services/extractors/llm-extraction-adapter.ts` | 20 tests |
| Email Parsing Adapter | `src/services/extractors/email-parsing-adapter.ts` | 20 tests |

**Total: 218+ tests across all new components**

#### Quick Start

```typescript
import {
  getOrchestrator,
  AmazonDataExportAdapter,
  createBrowserExtensionAdapter,
  createEmailAdapter,
  createClaudeAdapter,
} from './services/extractors';

// Create orchestrator
const orchestrator = getOrchestrator();

// Register adapters for Amazon
orchestrator.registerAdapter('amazon', new AmazonDataExportAdapter());
orchestrator.registerAdapter('amazon', createBrowserExtensionAdapter());
orchestrator.registerAdapter('amazon', createEmailAdapter());
orchestrator.registerAdapter('amazon', createClaudeAdapter());

// Get data with automatic fallback
const result = await orchestrator.getData('amazon', 'order-123', {
  preferredTiers: [1, 2], // Try official APIs and user-consented first
  requiredConfidence: 0.8,
  allowFallback: true,
});

// Result includes provenance and fallback info
console.log(result.data?.provenance.channel); // e.g., 'data_export'
console.log(result.fallbackUsed); // true if primary source failed
```

---

## Table of Contents

1. [Landscape Analysis](#landscape-analysis)
2. [Current Anno Infrastructure](#current-anno-infrastructure)
3. [Tiered Data Source Architecture](#tiered-data-source-architecture)
4. [Extended Adapter Interface](#extended-adapter-interface)
5. [Anti-Patterns & Gotchas](#anti-patterns--gotchas)
6. [Implementation Roadmap](#implementation-roadmap)
7. [Research Sources](#research-sources)

---

## Landscape Analysis

### What Others Are Doing (January 2026)

| Approach | Examples | Maintenance | Longevity |
|----------|----------|-------------|-----------|
| **Pure Scraping (Selenium/Playwright)** | [amazon-orders](https://github.com/alexdlaird/amazon-orders), [amzscraper](https://github.com/tobiasmcnulty/amzscraper) | High - constant selector updates | 6-18 months before major breakage |
| **Cookie-Based Session Reuse** | [Amazon-Scraper (Chrisso)](https://github.com/Chrisso/Amazon-Scraper) | Medium - manual cookie refresh | Works until session expires |
| **Official Data Export Parsing** | Amazon Privacy Central, eBay CSV exports | Low - format rarely changes | 5+ years (GDPR mandated) |
| **Financial Aggregators** | [Plaid](https://plaid.com/products/transactions/), [Finicity](https://www.finicity.com/manage/transactions/) | Very Low - maintained APIs | Indefinite |
| **Browser Extensions** | OrderPro Analytics, Keepa | Low - runs in user context | Years (avoids anti-bot) |
| **OCR + AI Extraction** | Amazon Textract, GPT-4o | Medium - model updates | Adapts to format changes |

### Anti-Bot Measures by Platform

| Platform | Detection Method | Difficulty | Session Duration |
|----------|------------------|------------|------------------|
| **eBay** | Rate limiting, fingerprinting | Medium | Hours |
| **Amazon** | PerimeterX/HUMAN, puzzle CAPTCHAs, device fingerprinting | Very High | Minutes without warming |
| **Walmart** | PerimeterX, aggressive rate limits | High | Variable |
| **Etsy** | Cloudflare, rate limiting | Medium | Hours |

### Key Finding: Amazon Is Different

Amazon is fundamentally harder than eBay for scraping because:

1. **Interactive CAPTCHAs** - Puzzle-based challenges require JavaScript execution; cannot be auto-solved
2. **Device Fingerprinting** - Canvas, WebGL, fonts, timezone, screen resolution
3. **Session Invalidation** - Any suspicious pattern triggers immediate re-auth
4. **2FA Challenges** - OTP via SMS, Authenticator app, or email during automation
5. **Terms of Service** - Explicit prohibition on automated access with active enforcement

The [amazon-orders Python library](https://github.com/alexdlaird/amazon-orders) documents this limitation:
> *"Interactive Captchas—like Amazon's puzzle-based Captchas—require JavaScript to solve, and will block amazon-orders from being able to login."*

**Recommendation**: Do not rely on scraping as the primary channel for Amazon. Build for multi-channel from day one.

---

## Current Anno Infrastructure

### Existing Components (Solid Foundation)

Anno already has excellent infrastructure in place:

| Component | File | Status |
|-----------|------|--------|
| `MarketplaceAdapter` interface | `src/services/extractors/marketplace-adapter.ts` | Complete |
| `PersistentSessionManager` | `src/services/persistent-session-manager.ts` | Complete |
| `EbayAdapter` | `src/services/extractors/ebay-adapter.ts` | Production |
| `AmazonAdapter` | `src/services/extractors/amazon-adapter.ts` | Product pages only |
| Cookie persistence | `.anno/sessions/{domain}.json` | Complete |
| Session warming | Natural browsing before scraping | Complete |
| CAPTCHA detection | reCAPTCHA, hCAPTCHA, PerimeterX, Cloudflare | Complete |
| Human-like behavior | Random delays, scrolling, viewport jitter | Complete |

### What's Missing

1. **Multi-channel support** - No way to combine scraped + API + user-provided data
2. **Source provenance tracking** - Can't distinguish how data was obtained
3. **Confidence scoring per-source** - Different sources have different reliability
4. **Fallback chain** - No automatic failover between data sources
5. **User-authenticated channels** - No browser extension or manual import

---

## Tiered Data Source Architecture

### Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Anno Data Source Architecture                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    DataSourceOrchestrator                         │  │
│  │  - Manages fallback chains per marketplace                        │  │
│  │  - Routes requests to appropriate channel                         │  │
│  │  - Aggregates/deduplicates from multiple sources                  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                              │                                          │
│    ┌─────────────────────────┼─────────────────────────┐               │
│    │                         │                         │               │
│    ▼                         ▼                         ▼               │
│  ┌────────────┐    ┌────────────────┐    ┌─────────────────┐          │
│  │  Tier 1:   │    │    Tier 2:     │    │     Tier 3:     │          │
│  │ Official   │    │  Authenticated │    │    Scraping     │          │
│  │   APIs     │    │  User Context  │    │                 │          │
│  └────────────┘    └────────────────┘    └─────────────────┘          │
│        │                   │                       │                   │
│   ┌────┴────┐        ┌────┴────┐            ┌────┴────┐               │
│   │eBay API │        │Browser  │            │Playwright│               │
│   │Amazon   │        │Extension│            │Adapters  │               │
│   │PA-API   │        │Data     │            │          │               │
│   │Plaid    │        │Export   │            │          │               │
│   │Finicity │        │Parser   │            │          │               │
│   └─────────┘        └─────────┘            └──────────┘               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Tier 4: AI-Assisted                          │  │
│  │  - Screenshot/PDF OCR (Amazon Textract, GPT-4o)                   │  │
│  │  - Email parsing (order confirmations)                            │  │
│  │  - Manual upload with LLM extraction                              │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tier Definitions

#### Tier 1: Official APIs (Preferred - Highest Reliability)

**Characteristics:**
- Stable, documented interfaces
- Rate limits are explicit and contractual
- Data is authoritative
- No anti-bot concerns

**Examples:**
| Marketplace | API | Use Case |
|-------------|-----|----------|
| eBay | Browse API | Product search, sold prices |
| Amazon | Product Advertising API (PA-API) | Product data (not order history) |
| Walmart | Affiliate API | Product listings |
| Plaid | Transactions API | Purchase enrichment |
| Finicity | Transaction Data API | Amazon Store Card data |

**Confidence Score:** 0.95 - 1.0

#### Tier 2: Authenticated User Context (High Reliability)

**Characteristics:**
- Runs in user's authenticated session
- Avoids all anti-bot detection
- User maintains control over credentials
- Requires user action to initiate

**Examples:**
| Channel | How It Works |
|---------|--------------|
| Browser Extension | Content script runs in Amazon order history page |
| Manual Data Export | User downloads from Amazon Privacy Central, Anno parses CSV/ZIP |
| Email Forwarding | User forwards order confirmation emails to Anno |
| Session Cookie Import | User exports cookies via browser devtools |

**Confidence Score:** 0.85 - 0.95

#### Tier 3: Public Scraping (Current Anno Approach)

**Characteristics:**
- Works for public data (product listings, search results)
- Requires session management, anti-detection
- Rate limited, may trigger CAPTCHAs
- Selector changes break extraction

**Examples:**
| Marketplace | Viability | Notes |
|-------------|-----------|-------|
| eBay | Good | Sold prices work reliably |
| Amazon | Product pages only | Order history requires auth |
| Walmart | Medium | Aggressive bot detection |

**Confidence Score:** 0.70 - 0.85

#### Tier 4: AI-Assisted Extraction (Fallback)

**Characteristics:**
- Works on screenshots, PDFs, emails
- Adapts to format changes via LLM
- Requires manual capture step
- Lower accuracy than structured sources

**Examples:**
| Input | Extraction Method |
|-------|-------------------|
| Screenshot of order history | GPT-4o vision + OCR |
| Invoice PDF | Amazon Textract |
| Order confirmation email | LLM structured extraction |

**Confidence Score:** 0.60 - 0.80

---

## Extended Adapter Interface

### New Types for Multi-Channel Support

```typescript
/**
 * Data source channel classification
 */
export type DataSourceChannel =
  | 'official_api'      // Tier 1: Official marketplace APIs
  | 'financial_api'     // Tier 1: Plaid, Finicity, etc.
  | 'browser_extension' // Tier 2: User's authenticated browser context
  | 'data_export'       // Tier 2: User-initiated data download
  | 'email_parsing'     // Tier 2: Order confirmation emails
  | 'cookie_import'     // Tier 2: Manual session import
  | 'scraping'          // Tier 3: Playwright/Puppeteer extraction
  | 'ocr_extraction'    // Tier 4: Screenshot/PDF processing
  | 'llm_extraction';   // Tier 4: LLM-based structure extraction

/**
 * Source provenance - tracks how data was obtained
 */
export interface DataProvenance {
  channel: DataSourceChannel;
  tier: 1 | 2 | 3 | 4;

  // Reliability metrics
  confidence: number;           // 0.0 - 1.0
  freshness: 'realtime' | 'recent' | 'historical';

  // Traceability
  sourceId: string;             // API credential ID, extension version, etc.
  extractedAt: string;          // ISO 8601
  rawDataHash?: string;         // Content-addressed hash for verification

  // Compliance
  userConsented: boolean;       // Did user explicitly authorize?
  termsCompliant: boolean;      // Does this violate marketplace ToS?
}

/**
 * Extended listing with provenance
 */
export interface MarketplaceListingWithProvenance extends MarketplaceListing {
  provenance: DataProvenance;

  // Multi-source correlation
  correlatedSources?: DataProvenance[]; // If same data confirmed by multiple sources
  conflictingData?: {
    field: string;
    values: { source: DataProvenance; value: any }[];
  }[];
}
```

### DataSourceAdapter Interface (Extends MarketplaceAdapter)

```typescript
/**
 * Extended adapter interface for multi-channel data sources
 */
export interface DataSourceAdapter extends MarketplaceAdapter {
  /**
   * Which channel does this adapter use?
   */
  readonly channel: DataSourceChannel;

  /**
   * Which tier is this adapter?
   */
  readonly tier: 1 | 2 | 3 | 4;

  /**
   * Default confidence range for this source
   */
  readonly confidenceRange: { min: number; max: number };

  /**
   * Does this adapter require user action to initiate?
   */
  readonly requiresUserAction: boolean;

  /**
   * Extract with provenance tracking
   */
  extractWithProvenance(
    content: string,
    url: string,
    options?: ExtractionOptions
  ): Promise<MarketplaceListingWithProvenance | null>;

  /**
   * Check if this source is currently available
   * (e.g., API key valid, browser extension installed, session active)
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get health status of this data source
   */
  getHealth(): Promise<{
    available: boolean;
    lastSuccessfulExtraction?: string;
    recentFailureRate: number;
    estimatedReliability: number;
  }>;
}
```

### DataSourceOrchestrator

```typescript
/**
 * Orchestrates fallback between multiple data sources
 */
export interface DataSourceOrchestrator {
  /**
   * Register an adapter for a marketplace + channel combination
   */
  registerAdapter(
    marketplace: MarketplaceType,
    adapter: DataSourceAdapter
  ): void;

  /**
   * Get data using best available source with automatic fallback
   */
  getData(
    marketplace: MarketplaceType,
    identifier: string, // URL, order ID, search query, etc.
    options?: {
      preferredTiers?: (1 | 2 | 3 | 4)[];
      requiredConfidence?: number;
      allowFallback?: boolean;
      timeout?: number;
    }
  ): Promise<{
    data: MarketplaceListingWithProvenance | null;
    attemptedSources: DataProvenance[];
    fallbackUsed: boolean;
  }>;

  /**
   * Get from all available sources and merge/deduplicate
   */
  getFromAllSources(
    marketplace: MarketplaceType,
    identifier: string
  ): Promise<{
    mergedData: MarketplaceListingWithProvenance;
    sources: DataProvenance[];
    conflicts: any[];
  }>;

  /**
   * Configure fallback chain for a marketplace
   */
  setFallbackChain(
    marketplace: MarketplaceType,
    chain: DataSourceChannel[]
  ): void;
}
```

---

## Anti-Patterns & Gotchas

### What NOT to Build

| Anti-Pattern | Why It's Bad | What to Do Instead |
|--------------|--------------|---------------------|
| **Credential Storage** | Security liability, user trust violation, ToS violation | Use browser extension (user's auth context) |
| **CAPTCHA Solving Services** | Arms race, cost per request, ethical concerns | Build for channels that don't trigger CAPTCHAs |
| **Residential Proxy Networks** | Expensive, still detectable, cat-and-mouse | Accept rate limits, use multiple channels |
| **Automated 2FA Bypass** | TOTP secrets are security-sensitive, account lockout risk | Let user handle 2FA manually |
| **Headless-Only Architecture** | Detectable, fragile, selector-dependent | Headless for Tier 3, prefer higher tiers |

### Common Scraping Failures

| Failure Mode | Symptom | Recovery Strategy |
|--------------|---------|-------------------|
| **Selector Change** | Empty/null extractions | Fallback to LLM extraction, alert for manual fix |
| **CAPTCHA Wall** | Puzzle page detected | Cool down, rotate session, fallback to Tier 2 |
| **Rate Limit** | 429 responses, soft blocks | Exponential backoff, reduce concurrency |
| **Session Invalidation** | Redirect to login | Re-warm session, notify user for Tier 2 |
| **Fingerprint Detection** | Immediate blocks | Rotate browser profile, user-agent |

### Per-Marketplace Gotchas

#### eBay
- **Sold prices require JS rendering** - Use Playwright, not fetch
- **Session warm-up essential** - Visit homepage first
- **Location affects results** - May need to set locale

#### Amazon
- **Product pages ≠ Order history** - Very different difficulty levels
- **Order history requires auth** - No public scraping path
- **Interactive CAPTCHAs** - Cannot be auto-solved
- **Privacy Central export** - Takes hours/days but is complete and reliable

#### Walmart
- **PerimeterX aggressive** - Requires stealth mode
- **No order history API** - Receipt data only via email parsing

---

## Implementation Roadmap

> **Implementation Status**: All phases COMPLETE as of January 2026

### Phase 1: Extend Adapter Interface (Foundation) ✅ COMPLETE

**Goal**: Formalize multi-channel support without breaking existing adapters

1. Add `DataSourceChannel` and `DataProvenance` types to `marketplace-adapter.ts`
2. Create `DataSourceAdapter` interface extending `MarketplaceAdapter`
3. Add `extractWithProvenance()` wrapper to existing adapters
4. Update `EbayAdapter` and `AmazonAdapter` to implement new interface

**Deliverables**:
- Extended type definitions
- Backward-compatible adapter updates
- Unit tests for provenance tracking

### Phase 2: Data Export Parsing (Tier 2) ✅ COMPLETE

**Goal**: Support user-initiated data imports with zero anti-bot risk

1. **Amazon Privacy Central Parser**
   - Parse ZIP file containing CSV exports
   - Extract Items, Orders, Shipments, Refunds
   - Map to `MarketplaceListing` schema

2. **eBay CSV Export Parser**
   - Parse seller/buyer CSV exports
   - Handle multiple eBay CSV formats

3. **Generic Import UI**
   - Drag-and-drop file upload
   - Format auto-detection
   - Progress/error reporting

**Deliverables**:
- `AmazonDataExportAdapter` implementing `DataSourceAdapter`
- `EbayDataExportAdapter` implementing `DataSourceAdapter`
- File upload endpoint and CLI command

### Phase 3: Browser Extension Foundation (Tier 2) ✅ COMPLETE

**Goal**: Enable real-time data capture from user's authenticated session

1. **Chrome/Firefox Extension**
   - Content script for Amazon order history
   - Captures order data as user browses
   - Communicates with Anno via native messaging

2. **Anno Extension Bridge**
   - Local server for extension communication
   - Session management
   - Data normalization

**Deliverables**:
- `browser-extension/` directory with manifest
- Content scripts for Amazon, eBay
- Local bridge server
- `BrowserExtensionAdapter` implementing `DataSourceAdapter`

### Phase 4: DataSourceOrchestrator (Unified Access) ✅ COMPLETE

**Goal**: Single entry point for data with automatic fallback

1. **Orchestrator Core**
   - Register adapters per marketplace
   - Execute fallback chain on failure
   - Aggregate from multiple sources

2. **Conflict Resolution**
   - Detect conflicting data between sources
   - Prefer higher-tier sources
   - Flag for manual review

3. **Health Monitoring**
   - Track success/failure rates per source
   - Auto-disable unhealthy sources
   - Alerting on degradation

**Deliverables**:
- `DataSourceOrchestrator` class
- Fallback chain configuration
- Health dashboard

### Phase 5: AI-Assisted Extraction (Tier 4) ✅ COMPLETE

**Goal**: Fallback for when structured sources fail

1. **Screenshot/PDF Processing**
   - Integration with Amazon Textract or local OCR
   - GPT-4o for structure extraction
   - Confidence scoring

2. **Email Parsing**
   - Order confirmation email templates
   - Forwarding endpoint
   - Extraction pipeline

**Deliverables**:
- `OcrExtractionAdapter` implementing `DataSourceAdapter`
- `EmailParsingAdapter` implementing `DataSourceAdapter`
- LLM prompt library for extraction

---

## Research Sources

### GitHub Projects Reviewed

- [amazon-orders (alexdlaird)](https://github.com/alexdlaird/amazon-orders) - Python library with 2FA/CAPTCHA handling
- [Amazon-Order-History (MaX-Lo)](https://github.com/MaX-Lo/Amazon-Order-History) - Selenium-based scraper
- [amzscraper (tobiasmcnulty)](https://github.com/tobiasmcnulty/amzscraper) - Receipt PDF generator
- [Amazon-Scraper (Chrisso)](https://github.com/Chrisso/Amazon-Scraper) - Cookie-based approach

### Anti-Bot Detection Research

- [Avoid Bot Detection with Playwright (ZenRows)](https://www.zenrows.com/blog/avoid-playwright-bot-detection)
- [Playwright Stealth (Brightdata)](https://brightdata.com/blog/how-tos/avoid-bot-detection-with-playwright-stealth)
- [Make Playwright Undetectable (ScrapeOps)](https://scrapeops.io/playwright-web-scraping-playbook/nodejs-playwright-make-playwright-undetectable/)
- [SeleniumBase Stealthy Mode](https://seleniumbase.com/stealthy-playwright-mode-bypass-captchas-and-bot-detection/)

### Official Data Access

- [Amazon Privacy Central Data Request](https://www.amazon.com/hz/privacy-central/data-requests/preview.html)
- [Amazon Textract Invoice/Receipt Extraction](https://docs.aws.amazon.com/textract/latest/dg/invoices-receipts.html)
- [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/)
- [Finicity Transaction Data API](https://www.finicity.com/manage/transactions/)

### Scraping Tools & Services

- [Complete Amazon Scraping Guide (Scrape.do)](https://scrape.do/blog/amazon-scraping/)
- [Octoparse Amazon Scrapers](https://www.octoparse.com/blog/most-useful-tools-to-scrape-data-from-amazon)
- [OrderPro Analytics Extension](https://www.orderproanalytics.com/)

### Receipt/Invoice Extraction APIs

- [Amazon Textract](https://docs.aws.amazon.com/textract/latest/dg/invoices-receipts.html)
- [Best Receipt Parser APIs (Eden AI)](https://www.edenai.co/post/best-receipt-parser-apis)
- [Veryfi Invoice OCR](https://www.veryfi.com/)
- [Unstract LLM Document Extraction](https://unstract.com/blog/unstract-receipt-ocr-scanner-api/)

---

## Appendix A: Existing Marketplace Adapter Interface

The current `MarketplaceAdapter` interface in `src/services/extractors/marketplace-adapter.ts` provides:

- `MarketplaceListing` - Normalized output schema
- `MarketplaceAdapter` - Core extraction interface
- `MarketplaceConfig` - Per-marketplace compliance config
- `ExtractionEvent` - Event pipeline for analytics
- `BackfillJob` - Bulk extraction orchestration
- `MarketplaceSearchAdapter` - Search capability extension

The proposed `DataSourceAdapter` extends this foundation without breaking backward compatibility.

---

## Appendix B: Confidence Score Guidelines

| Source Type | Confidence Range | Rationale |
|-------------|------------------|-----------|
| Official API (product data) | 0.95 - 1.0 | Authoritative source |
| Official API (user data) | 0.90 - 0.98 | May have sync delays |
| Browser Extension | 0.85 - 0.95 | Direct DOM access, user context |
| Data Export (CSV/ZIP) | 0.85 - 0.95 | Official export, may be stale |
| Email Parsing | 0.80 - 0.90 | Structured but variable formats |
| Scraping (with rendering) | 0.70 - 0.85 | Subject to selector changes |
| Scraping (static) | 0.60 - 0.75 | Missing dynamic content |
| OCR Extraction | 0.60 - 0.80 | Quality depends on input |
| LLM Extraction | 0.55 - 0.75 | Hallucination risk |

---

*This document should be updated as new research emerges or implementation progresses.*
