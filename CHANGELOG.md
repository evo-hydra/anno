# Changelog

All notable changes to Anno will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Route integration tests for all 8 API endpoints (content, crawl, interact, jobs, memory, semantic, watch, workflow)
- `anno setup claude-code` CLI command for MCP server configuration
- Supertest-based integration smoke tests for health, metrics, CORS, security headers, and 404 handling
- License audit via `license-checker` (`npm run license:check`)
- Tests for request-context middleware, ebay-url-builder, and provenance-verify utilities

### Changed
- All 19 outdated dependencies upgraded to latest (lru-cache 10→11, commander 13→14, jsdom 22→28, eslint 9→10, @langchain/openai 0.6→1.2, @anthropic-ai/sdk 0.65→0.75, and more)
- Extracted Express app factory (`src/app.ts`) from `src/server.ts` for testability
- ESLint ignores now include `coverage/` directory
- Bumped `@types/node` from v24 to v25
- Raised branch coverage CI threshold from 60% to 65%

### Fixed
- Express 5 `req.params` type narrowing in crawl, jobs, and watch routes (use `String()` wrapper)

### Testing
- 2,290 tests across 86 test files (up from 1,958 across 72)
- 81.42% line coverage, 69.79% branch coverage, 82.4% function coverage
- Extended test coverage for pipeline, crawler, fetcher, distiller core services

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
