# Changelog

All notable changes to Anno will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-10-20

### Added
- AI-native web content extraction with ensemble method selection (Readability, Ollama LLM, DOM heuristic)
- Confidence scoring across extraction methods with automatic best-result selection
- Headless rendering via Playwright with stealth mode for JavaScript-heavy pages
- Redis caching with LRU in-memory fallback
- Robots.txt compliance with crawl-delay support
- Per-domain rate limiting with configurable delays
- Policy engine with domain-aware distillation rules (YAML-based, 5 built-in presets)
- Provenance tracking with SHA-256 content hashing and byte-offset source spans
- eBay marketplace adapter with search, sold-price lookup, and dual-selector compatibility
- Crawler with depth control, URL filtering, and job persistence (Redis-backed with in-memory fallback)
- MCP server with 4 tools: `anno_fetch`, `anno_batch_fetch`, `anno_crawl`, `anno_health`
- CLI interface via Commander for standalone usage
- API key authentication with per-tenant rate limiting and audit logging
- Per-tenant sliding-window rate limiting on crawl job creation
- SSRF protection via URL validation (41+ test cases)
- Retry with exponential backoff and circuit breakers for external calls
- Graceful shutdown with connection draining, Redis cleanup, and 30s force-exit
- Server timeouts: 2min request, 65s keepAlive, 70s headers

### Changed
- Error responses sanitized in production (5xx messages hidden)
- Dockerfile sets `NODE_ENV=production`

### Fixed
- Resolved all 29 npm audit vulnerabilities (zero remaining)
- Zero TypeScript errors, zero ESLint problems
- Removed unused `@langchain/community` and `cohere-ai` dependencies

### Testing
- 1,958 tests across 72 test files
- 78.96% line coverage, 66.49% branch coverage, 79.88% function coverage
- CI-enforced coverage thresholds (74% lines, 60% branches, 75% functions)

### Infrastructure
- GitHub Actions CI pipeline: lint, typecheck, test, build
- ESLint flat config with TypeScript strict mode
- Vitest test runner with `@vitest/coverage-v8`
