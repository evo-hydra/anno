# Anno Architecture

## Overview

Anno is a web content extraction service for AI agents. It fetches web pages, runs an ensemble of extraction methods with confidence scoring, and returns clean structured text via NDJSON streams — reducing token usage 93% vs raw HTML. Available via HTTP API, CLI, and MCP.

## System Diagram

```
                         ┌──────────────┐
                         │  MCP Server   │  ← Claude Code / AI assistants
                         │  (stdio)      │
                         └──────┬───────┘
                                │
┌──────────┐   ┌────────────────▼────────────────┐   ┌──────────┐
│  CLI      │──▶│         Express Server          │◀──│  Docker   │
│ (Commander)│  │         (port 5213)              │   │          │
└──────────┘   └──┬─────┬──────┬──────┬──────┬───┘   └──────────┘
                  │     │      │      │      │
              /fetch /batch /crawl /interact /workflow
                  │     │      │      │      │
                  ▼     ▼      ▼      ▼      ▼
            ┌─────────────────────────────────────┐
            │            Core Pipeline             │
            │  (async generator → NDJSON stream)   │
            └──────────────┬──────────────────────┘
                           │
              ┌────────────▼────────────┐
              │        Fetcher          │
              │  HTTP client + Playwright│
              │  (stealth, SSRF guard)  │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │       Distiller         │
              │  Multi-extractor ensemble│
              └────────────┬────────────┘
                           │
          ┌────────┬───────┼───────┬──────────┐
          ▼        ▼       ▼       ▼          ▼
     Readability  DOM   Trafilatura eBay    Ollama
                Heuristic          Adapters  (LLM)
          │        │       │       │          │
          └────────┴───────┴───────┴──────────┘
                           │
              ┌────────────▼────────────┐
              │   Extraction Ensemble    │
              │  Score → Select → Merge  │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   Confidence Scorer     │
              │  Bayesian 5-dimension   │
              └────────────┬────────────┘
                           │
                     NDJSON stream
                    (metadata + nodes)
```

## Core Components

### Entry Points

| Entry | File | Description |
|-------|------|-------------|
| HTTP Server | `src/server.ts` | Express 5.1.0, port 5213 |
| CLI | `src/cli/index.ts` | Commander-based CLI (`npx anno`) |
| MCP Server | `src/mcp/server.ts` | Model Context Protocol for AI assistants (`npx anno-mcp`) |

### Pipeline (`src/core/pipeline.ts`)

The pipeline is an async generator that yields NDJSON events:

```
metadata → node → node → ... → done
```

Each event is a self-contained JSON object. Consumers process the stream incrementally. The pipeline orchestrates fetching, distillation, and confidence scoring into a single streaming response.

### Fetcher (`src/services/fetcher.ts`)

Two fetch modes:
- **HTTP mode**: Direct HTTP fetch via `src/core/http-client.ts` with SSRF protection, retry logic, and circuit breakers
- **Rendered mode**: Playwright with stealth plugin for JavaScript-heavy sites (`src/services/renderer.ts`)

URL validation (`src/core/url-validator.ts`) blocks private IPs, link-local addresses, and DNS rebinding attacks.

### Distiller (`src/services/distiller.ts`)

Runs content through multiple extractors and selects the best result:

1. **Readability** (`@mozilla/readability`) — Mozilla's reader-mode extractor
2. **DOM Heuristic** (`src/services/extractors/dom-heuristic.ts`) — Custom structural analysis
3. **Trafilatura** (`src/services/extractors/trafilatura.ts`) — Python library (optional, graceful fallback)
4. **eBay Adapters** (`src/services/extractors/ebay-adapter.ts`, `ebay-search-adapter.ts`) — Marketplace-specific extraction
5. **Ollama LLM** (`src/services/ollama-extractor.ts`) — Local LLM extraction (optional)

### Extraction Ensemble (`src/core/extraction-ensemble.ts`)

Scores each extractor's output across 5 weighted dimensions:
- Content length (optimal range scoring)
- Structure quality (paragraph/heading ratio)
- Metadata completeness (title, author, date)
- Semantic coherence
- Extractor confidence

Selects the highest-scoring candidate with explanation.

### Confidence Scorer (`src/core/confidence-scorer.ts`)

Bayesian confidence scoring across 5 dimensions:
- Extraction confidence
- Content quality
- Source reliability
- Structural clarity
- Cross-validation

Produces a single `[0,1]` confidence score with per-dimension breakdown.

### Cache (`src/services/cache.ts`)

Two-tier caching:
- **LRU in-memory** (`lru-cache`) — Fast, default
- **Redis** (`redis`) — Persistent, opt-in via `REDIS_ENABLED=true`

Content-addressed by URL + options hash.

### Crawler (`src/services/crawler.ts`)

BFS/DFS site crawler with:
- Configurable depth and page limits
- robots.txt compliance
- Concurrent page fetching
- Progress events and job tracking
- AbortController cancellation

### Policy Engine (`src/services/policy-engine.ts`)

YAML-configurable content policies per domain. Controls extraction behavior, node filtering, and content rules.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/metrics` | Prometheus-compatible metrics |
| `POST` | `/v1/content/fetch` | Fetch and extract content (NDJSON stream) |
| `POST` | `/v1/content/batch-fetch` | Parallel multi-URL fetch (NDJSON stream) |
| `POST` | `/v1/crawl` | Start background crawl job |
| `GET` | `/v1/crawl/:jobId` | Poll crawl job status |
| `GET` | `/v1/crawl/:jobId/results` | Get crawl results |
| `DELETE` | `/v1/crawl/:jobId` | Cancel running crawl |
| `POST` | `/v1/interact` | Browser interaction (click, type, etc.) |
| `POST` | `/v1/workflow` | Multi-step browser workflows |
| `POST` | `/v1/semantic/index` | Index content for semantic search |
| `POST` | `/v1/semantic/search` | Semantic search |
| `POST` | `/v1/semantic/rag` | RAG query |

## MCP Integration

Anno exposes itself as an MCP (Model Context Protocol) server so AI assistants like Claude Code can use it as a native tool.

**Tools exposed:**
- `anno_fetch` — Fetch and extract content from a URL
- `anno_batch_fetch` — Parallel multi-URL extraction
- `anno_crawl` — Crawl a website with depth/page limits
- `anno_health` — Check server status

See [README.md](README.md#mcp-integration) for setup instructions.

## Directory Structure

```
src/
  server.ts                 # Express server entry point
  mcp/
    server.ts               # MCP server (stdio transport)
  cli/
    index.ts                # CLI entry point
    commands/               # CLI subcommands
  core/
    pipeline.ts             # NDJSON streaming pipeline
    extraction-ensemble.ts  # Multi-extractor scoring
    confidence-scorer.ts    # Bayesian confidence
    http-client.ts          # HTTP client with SSRF protection
    url-validator.ts        # URL/IP validation
    robots-parser.ts        # robots.txt compliance
  services/
    fetcher.ts              # HTTP + rendered fetch
    distiller.ts            # Content distillation orchestrator
    renderer.ts             # Playwright browser rendering
    crawler.ts              # Site crawler
    cache.ts                # LRU + Redis cache
    policy-engine.ts        # Domain-specific content policies
    ollama-extractor.ts     # Local LLM extraction
    extractors/             # Marketplace & format adapters
  middleware/
    auth.ts                 # API key authentication
    error-handler.ts        # Centralized error handling
    rate-limit.ts           # Rate limiting
    security.ts             # Helmet, CORS
  api/routes/               # Express route handlers
  ai/                       # LangChain integration, RAG
  config/
    env.ts                  # Environment configuration
    domain-config.ts        # Per-domain settings
  utils/
    logger.ts               # Pino structured logging
    retry.ts                # Retry with exponential backoff
    circuit-breaker.ts      # Circuit breaker pattern
```

## Design Principles

1. **Streaming-first** — All extraction produces NDJSON streams via async generators. No buffering entire pages in memory.
2. **Graceful degradation** — Every extractor, cache backend, and optional service (Ollama, Trafilatura, Redis) fails gracefully with fallbacks.
3. **Token efficiency** — Output is optimized for LLM consumption. 80%+ reduction vs raw HTML.
4. **Provenance** — Content carries source spans, extraction method, and confidence scores for citation tracking.
5. **Zero silent failures** — All errors are logged, surfaced in responses, and tracked via structured telemetry.
