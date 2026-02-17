# Anno

**Web content extraction for AI agents. 93% fewer tokens than raw HTML.**

Anno fetches web pages, runs an ensemble of extraction methods with confidence scoring, and returns clean structured text — so your AI agent spends tokens on content, not markup. Available via HTTP API, CLI, and MCP.

## Benchmark (N=20)

Tested across news sites, documentation, Wikipedia, Stack Overflow, blogs, and data-heavy pages:

| Page Type | Example | Raw HTML | Anno | Reduction |
|-----------|---------|----------|------|-----------|
| News | bbc.com/news | 86,399 tok | 806 tok | 99.1% |
| Docs | developer.mozilla.org | 54,682 tok | 1,925 tok | 96.5% |
| Wiki | en.wikipedia.org/wiki/AI | 303,453 tok | 2,806 tok | 99.1% |
| Forum | stackoverflow.com | 287,846 tok | 1,661 tok | 99.4% |
| Blog | martinfowler.com | 21,510 tok | 2,647 tok | 87.7% |
| Tables | wikipedia.org (browser comparison) | 291,843 tok | 792 tok | 99.7% |
| Minimal | sqlite.org | 5,306 tok | 2,890 tok | 45.5% |

**Average: 92.7% reduction. Overall: 98.2% (1.56M → 28.5K tokens across 20 pages)**

Reproduce it yourself: `npx tsx bench/run.ts`

## Quick Start

```bash
npm install --legacy-peer-deps
npm run build
npm start
# Server running at http://localhost:5213
```

### Fetch a page

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://en.wikipedia.org/wiki/TypeScript"}'
```

### Fetch with JavaScript rendering

For SPAs and dynamic sites, enable Playwright:

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "options": {"render": true}}'
```

### Batch fetch

```bash
curl -X POST http://localhost:5213/v1/content/batch-fetch \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com", "https://news.ycombinator.com"]}'
```

## How It Works

```
URL → Fetch → Ensemble Extraction → Confidence Scoring → Structured Output
              ├─ Readability
              ├─ Ollama LLM (optional)
              └─ DOM heuristic
```

Anno runs multiple extraction methods in parallel, scores each result for quality, and returns the best one. This ensemble approach handles everything from clean blog posts to messy e-commerce pages.

## MCP Integration (Claude Code, Cursor, etc.)

Anno exposes itself as an [MCP](https://modelcontextprotocol.io/) server. Any AI tool that supports MCP can use Anno natively.

### Setup

1. Start Anno: `npm start`
2. Add to `~/.claude/.mcp.json` (global) or `.mcp.json` (per-project):

```json
{
  "mcpServers": {
    "anno": {
      "command": "node",
      "args": ["/path/to/anno/dist/mcp/server.js"],
      "env": {
        "ANNO_BASE_URL": "http://localhost:5213"
      }
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `anno_fetch` | Extract content from a single URL |
| `anno_batch_fetch` | Parallel extraction from multiple URLs (up to 10) |
| `anno_crawl` | Crawl a website with depth/page limits |
| `anno_health` | Check server status |

## CLI

```bash
npx anno start --port 5213
npx anno fetch https://example.com
npx anno crawl https://example.com --depth 2 --max-pages 10
npx anno health
```

## Docker

```bash
docker build -t anno .
docker run -p 5213:5213 anno
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/content/fetch` | Extract content from a URL |
| `POST` | `/v1/content/batch-fetch` | Batch extract from multiple URLs |
| `POST` | `/v1/crawl` | Start a crawl job |
| `GET` | `/v1/crawl/:id` | Check crawl job status |
| `GET` | `/v1/crawl/:id/results` | Get crawl results |
| `GET` | `/health` | Server health check |
| `GET` | `/metrics` | Prometheus metrics |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5213` | Server port |
| `RENDERING_ENABLED` | `true` | Playwright browser rendering |
| `REDIS_ENABLED` | `false` | Redis caching (LRU fallback when off) |
| `AI_LLM_PROVIDER` | `none` | LLM provider for AI-assisted extraction |
| `RESPECT_ROBOTS` | `true` | Respect robots.txt |
| `RENDER_STEALTH` | `true` | Stealth mode for browser rendering |

## When NOT to Use Anno

- **Static text files** — If the source is already clean text or JSON, Anno adds overhead for no gain (see SQLite at 45.5% — already minimal HTML)
- **Authenticated pages** — Anno doesn't handle login flows (yet). Use a session cookie or authenticated proxy
- **Real-time streaming** — Anno extracts on-demand, not as a live stream

## Development

```bash
npm run dev      # Hot-reload
npm run lint     # ESLint
npm run build    # Compile TypeScript
npm test         # Lint + Vitest (1,958 tests)
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for system design.

## License

[MIT](LICENSE) — Evolving Intelligence AI
