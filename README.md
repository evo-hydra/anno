# Anno

AI-native web content extractor with semantic understanding. Built for AI agents and LLMs.

Anno fetches web pages, extracts meaningful content, and returns clean structured data — reducing token usage by 80%+ compared to raw HTML.

## Quick Start

```bash
npm install
npm run build
npm start
# Server starts on http://localhost:5213
```

### Health check

```bash
curl http://localhost:5213/health
```

### Fetch a page

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Fetch with browser rendering

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "render": true}'
```

## CLI

```bash
# Start server
npx anno start --port 5213

# Check health
npx anno health

# Fetch a URL
npx anno fetch https://example.com

# Crawl a site
npx anno crawl https://example.com --depth 2 --max-pages 10
```

## Docker

```bash
docker build -t anno .
docker run -p 5213:5213 anno
```

Or with docker-compose:

```bash
docker compose up
```

## Configuration

Copy `.env.example` to `.env.local` and modify as needed. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `5213` | Server port |
| `RENDERING_ENABLED` | `true` | Enable Playwright browser rendering |
| `REDIS_ENABLED` | `false` | Enable Redis caching (auto in production) |
| `AI_LLM_PROVIDER` | `none` | LLM provider for AI-assisted extraction |
| `RESPECT_ROBOTS` | `true` | Respect robots.txt |
| `RENDER_STEALTH` | `true` | Use stealth mode for browser rendering |

See `.env.example` for the full list.

## Optional: Python trafilatura

Anno can use Python's [trafilatura](https://github.com/adbar/trafilatura) library for enhanced text extraction. This is optional — Anno gracefully falls back to its built-in extractors when Python isn't available.

```bash
pip install trafilatura
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `GET` | `/metrics` | Prometheus-compatible metrics |
| `POST` | `/v1/content/fetch` | Fetch and extract content from URL |
| `POST` | `/v1/content/batch-fetch` | Batch fetch multiple URLs |
| `POST` | `/v1/crawl` | Crawl a website |
| `POST` | `/v1/interact` | Browser interaction (click, type, etc.) |
| `POST` | `/v1/workflow` | Multi-step browser workflows |
| `POST` | `/v1/semantic/index` | Index content for semantic search |
| `POST` | `/v1/semantic/search` | Semantic search over indexed content |
| `POST` | `/v1/semantic/rag` | RAG query over indexed content |

## Development

```bash
npm run dev      # Start with hot-reload
npm run lint     # Run ESLint
npm run build    # Compile TypeScript
npm test         # Lint + build + run tests
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed system design.

## License

MIT
