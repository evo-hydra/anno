# Changelog

All notable changes to Anno will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2025-10-20

### Added - Marketplace Search & Price Intelligence

#### eBay Search Functionality
- **Full eBay search capability** with sold price lookup via `EbaySearchAdapter`
- `search(query, options)` method for comprehensive search results
- `searchSoldPrices(query, options)` convenience method for price statistics only
- `buildSearchUrl(query, options)` for URL generation with filters
- `parseSearchResultsFromHtml(html, query)` for external HTTP client integration
- Price aggregation: low, median, high, average from search results
- Search filters: sold/completed, price range, condition, sorting, max results

#### Playwright Browser Automation
- **Bot detection bypass** with `EbaySearchFetcher` singleton
- Headless Chrome integration via Playwright
- Automatic challenge page detection ("Checking your browser")
- Challenge auto-resolution in ~10-12 seconds
- Retry logic with exponential backoff (3 attempts default)
- Comprehensive error handling and telemetry
- Browser resource cleanup and lifecycle management

#### HTML Selector Compatibility
- **Future-proof dual selector pattern** for eBay layout changes
- Support for `.s-card` (2025 design) and `.s-item` (legacy) class structures
- Automatic fallback between selector patterns
- Robust extraction across eBay's evolving HTML structure
- Compatibility with both horizontal and vertical card layouts

#### Marketplace Adapter Extensions
- `SearchOptions` interface for filter configuration
- `SearchResponse` interface for result aggregation
- `SearchResult` interface for individual results
- `PriceStatistics` interface for price analytics
- `MarketplaceSearchAdapter` interface extending `MarketplaceAdapter`

### Changed
- **eBay Adapter v2.1.0**: Updated from 2.0.0
  - Changed `parsePrice()` from private to protected for search adapter reuse
  - Changed `mapCondition()` from private to protected for search adapter reuse
  - Enhanced to support search result extraction alongside single item extraction

### Performance
- **42x faster** than item-by-item scraping (~0.23s per item vs 10s per item)
- **100% success rate** on tested queries (vs 20% for EbayAmazonScraper)
- **0% crash rate** (vs 80% for EbayAmazonScraper)
- Challenge page auto-resolution adds 10-12s to first request only
- Subsequent searches complete in ~1-2 seconds

### Documentation
- Added `ANNO_SEARCH_IMPLEMENTATION_SUMMARY.md` with:
  - Complete architecture documentation
  - Usage examples and code samples
  - Performance benchmarks and comparison data
  - Production deployment checklist
  - Known limitations and future enhancements

### Dependencies
- Added `playwright-core` 1.55.1 for browser automation

### Testing
- Validated with "macbook pro" query: 60 results, $12.99-$2,599.99 range
- Validated with "JUNIPER MX2008" query: 60 results, $55-$15,999.99 range
- Test coverage includes challenge page detection, selector fallbacks, and price aggregation

---

## [0.2.0] - 2025-10-06

### Added - Competitive Readiness Features

#### Policy Engine
- **Domain-aware distillation policies** with YAML configuration
- 5 built-in presets: default, news, docs, ecommerce, academic
- Automatic policy selection based on URL patterns
- Manual policy hints via API (`policyHint` parameter)
- Policy validation on startup with fingerprint tracking
- Selector and regex-based keep/drop/transform rules
- Field validation (required, minLength, maxLength, pattern)

#### Provenance & Source-Span Tracking
- **Cryptographic provenance** for all extracted content
- SHA-256 content hashing for tamper detection
- Byte-offset tracking for every text node
- Source span verification utilities
- Timestamp and URL tracking for audit trails

#### HTTP Cache Enhancements
- ETag and Last-Modified header extraction
- 304 Not Modified response handling
- Cache validation header storage (partial implementation)
- Protocol detection (HTTP/2 vs HTTP/1.1)

#### Configuration
- 10 new environment variables for fine-grained control
- `POLICY_ENABLED`, `POLICY_DIR`, `DEFAULT_POLICY`
- `CACHE_ENCRYPTION_KEY` for encrypted caching
- `OVERRIDE_ROBOTS` for testing (use responsibly)
- `ENABLE_STAGE_METRICS` for observability
- `DOMAIN_CONFIG_PATH` for rendering rules

#### Documentation
- **MIGRATION.md** - Upgrade guide with all new features
- **POLICIES.md** - Complete policy DSL reference
- **PROVENANCE.md** - Provenance tracking guide
- **KNOWN_LIMITATIONS.md** - Current limitations and roadmap

### Changed
- `distillContent()` now accepts optional `policyHint` parameter
- `DistillationResult` includes `contentHash` and `policyMetadata`
- `DistilledNode` includes `sourceSpans` array
- `HttpClientResponse` includes `etag`, `lastModified`, `wasNotModified`

### Performance
- Policy processing adds ~10-20ms per request (configurable)
- Provenance tracking adds ~5-10ms per request
- No overhead for ETag support (passive extraction)

### Dependencies
- Added `js-yaml` for policy file parsing
- Added `@types/js-yaml` for TypeScript support

### Security
- Policies validated against schema on startup
- Content hash verification prevents tampering
- Robots.txt override requires explicit opt-in
- Audit logging for sensitive operations (coming soon)

---

## [0.1.0] - 2025-09-15

### Added - Initial Release

#### Core Features
- **AI-Native Content Extraction** with ensemble method selection
- **Headless Rendering** via Playwright with stealth mode
- **Semantic Search** with vector embeddings
- **Redis Caching** with LRU fallback
- **Robots.txt Compliance** with crawl-delay support
- **Rate Limiting** per-domain with configurable delays
- **HTTP/2 Support** via native fetch

#### Extraction Methods
- Mozilla Readability integration
- Ollama LLM-powered extraction
- DOM heuristic fallback
- eBay specialized adapter
- Ensemble scoring and selection

#### Observability
- Prometheus metrics endpoint
- Structured JSON logging
- Request ID correlation
- Health check endpoint
- Performance tracing

#### API Endpoints
- `POST /v1/content/fetch` - Single URL distillation
- `POST /v1/content/batch-fetch` - Batch processing
- `GET /health` - Deep health checks
- `GET /metrics` - Prometheus metrics

#### Configuration
- Environment-based configuration
- Rendering toggles and timeouts
- Cache size and TTL controls
- AI provider selection

### Dependencies
- Express 5.x for HTTP server
- Playwright for rendering
- JSDOM for DOM manipulation
- LangChain for AI integrations
- Redis for distributed caching
- Zod for schema validation

---

## Release Notes

### v0.2.0 - Competitive Readiness

This release establishes Anno as **production-ready** with enterprise features:

✅ **Deterministic extraction** via domain-specific policies
✅ **Traceable outputs** with cryptographic provenance
✅ **Cache efficiency** with ETag/Last-Modified support (partial)
✅ **Full observability** with metrics and structured logs
✅ **Comprehensive docs** for migration and operation

**Upgrade:** Fully backward compatible, no breaking changes.

**Next:** v0.2.1 will complete ETag implementation with conditional requests and cache revalidation.

---

## [Unreleased]

### Planned for v0.2.1
- [ ] Complete ETag/Last-Modified conditional request support
- [ ] Cache revalidation with If-None-Match/If-Modified-Since
- [ ] 304 response metrics tracking
- [ ] Cookie/auth support for rendering
- [ ] Domain-specific rendering configuration

### Planned for v0.3.0
- [ ] Policy inheritance and composition
- [ ] Hot-reload configuration API
- [ ] Streaming extraction for large pages
- [ ] Adaptive rate limiting
- [ ] Priority queue for fetches

### Planned for v0.4.0
- [ ] OpenTelemetry integration
- [ ] Async job queue with webhooks
- [ ] Credential vault for auth
- [ ] Redis Cluster support
- [ ] GraphQL API

---

**Repository:** https://github.com/evo-nirvana/anno
**License:** MIT
**Documentation:** https://github.com/evo-nirvana/anno/docs
