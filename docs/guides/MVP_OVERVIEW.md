# Anno MVP Runtime

This document captures the scope of the first runnable Anno prototype. It focuses on delivering the minimum viable experience for semantic-first page consumption.

## Capabilities

- **HTTP Fetch + Caching** – Uses Node's native `fetch()` with a polite user agent and a TTL in-memory cache.
- **Optional Rendered Snapshots** – When `RENDERING_ENABLED=true`, Playwright spins up Chromium at boot, maintains a small context pool (default 2 concurrent pages), and captures DOM after `networkidle` (configurable) to support JS-heavy pages.
- **Readability Distillation** – Converts HTML into paragraph and heading nodes via `@mozilla/readability`, falling back to DOM heuristics when parsing fails.
- **JSONL Streaming API** – `POST /v1/content/fetch` streams metadata (including render mode), confidence, node payloads, provenance, and completion events as NDJSON.
- **Confidence Heuristics** – Lightweight scoring based on content length, byline presence, node count, and fallback usage.

## Running Locally

```bash
npm install
npm run dev
# Service listens on http://localhost:5213 by default
```

To enable rendered snapshots you also need Playwright browsers:

```bash
npx playwright install chromium
export RENDERING_ENABLED=true
# optional tuning
export RENDER_MAX_PAGES=4          # concurrent render contexts
export RENDER_WAIT_UNTIL=networkidle
npm run dev
```

> Rendering mode is optional; if the Chromium binary is missing a fetch will automatically fall back to the HTTP pipeline.

### Environment Flags

- `RENDERING_ENABLED` – Enables Playwright renderer (default: `false`).
- `RENDER_MAX_PAGES` – Maximum concurrent render contexts (default: `2`).
- `RENDER_TIMEOUT_MS` – Navigation timeout for Playwright (default: `20000`).
- `RENDER_WAIT_UNTIL` – Wait condition for page load (`load`, `domcontentloaded`, `networkidle`).
- `RENDER_HEADLESS` – Toggle headless Chromium (default: `true`).
- `METRICS_RESET_ENABLED` – Allow `POST /metrics/reset` (default: `false`).
- `METRICS_RESET_TOKEN` – Optional token required via `X-Metrics-Reset-Token` header or `?token=`.

### Example Request

```bash
curl -s -X POST http://localhost:5213/v1/content/fetch \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "options": {"render": true}}'
```

## Observability

- `GET /health` returns the service status, renderer state (initialized, queue depth), and cumulative fetch metrics (cache hits/misses, render fallbacks, last render error) plus average/p50/p95 render and fallback durations in seconds.
- Metrics are in-memory and reset on process restart; use them to monitor whether render mode succeeds or relies on HTTP fallbacks.
- `GET /metrics` exposes the same counters in Prometheus exposition format (gauge/counter) so you can scrape them directly.
  - Includes `anno_render_duration_seconds` and `anno_render_fallback_seconds` histograms for render latencies and fallback timings.
- `POST /metrics/reset` clears all counters when enabled (see env flags). Provide `X-Metrics-Reset-Token` or `?token=` if a token is configured.

## Limitations & Next Steps

1. **Best-Effort Rendering** – Playwright launch failures fall back to HTTP; future work includes deterministic record/replay and cache reuse across renders.
2. **Single-Page Focus** – Multi-agent orchestration, cross-source verification, and temporal intelligence remain on the roadmap.
3. **In-Memory Cache** – Redis-backed caching and content-addressed hashing are slated for Phase 2 of the prototype.
4. **Minimal Confidence Model** – Current scores are heuristic; future iterations will incorporate model-based calibration and provenance weighting.

Use this MVP as a foothold to validate extraction quality, token savings, and API ergonomics before expanding into full multi-agent semantics.
