# Anno Roadmap — Post-VC Engineering Plan

Generated Feb 25, 2026 from full codebase audit (2800+ tests, 100 source files).

---

## The Goal: "Works 99% of the Time"

Our benchmark showed 22/31 sites extracted successfully (71%). 7 returned empty content, 2 had anomalous raw fetches. To hit 99%, we need to fix **three systemic problems**:

1. **No auto-render detection** — JS-heavy sites return empty HTML but Anno doesn't retry with Playwright unless a wall is detected
2. **Silent extraction failures** — Readability returns null, DOM heuristic scores everything low, ensemble picks "least bad" without flagging degradation
3. **Bot blocks masquerade as 200 OK** — Sites return challenge pages that don't match wall detector patterns

---

## Phase 1: Extraction Reliability (Weeks 1-4)

### 1.1 Auto-Render Detection

**Problem:** Pipeline only triggers rendering when `detectChallengePage()` or `detectAuthWall()` fires. JS-heavy sites (React SPAs, Medium, OpenAI Blog) return empty/minimal HTML that passes wall detection but yields 0 content nodes.

**Fix:** After extraction, if content is suspiciously empty and rendering is available, retry with Playwright.

```
Location: src/core/pipeline.ts (after extraction, before node emission)
Logic:
  if (nodes.length === 0 && contentLength < 200 && !rendered && config.rendering.enabled) {
    // Re-fetch with rendering, re-extract
  }
```

**Acceptance criteria:** Sites that return 0 nodes on HTTP automatically retry with rendering. Benchmark target: 28/31 sites return content.

### 1.2 Expand Wall Detection

**Problem:** `wall-detector.ts` only scans first 4096 bytes. Patterns are simple regexes that miss fragmented text and non-English walls.

**Fixes:**
- Increase scan limit to 8192 bytes
- Add patterns for: Cloudflare challenge pages (look for `cf-browser-verification`, `__cf_chl_jschl_tk__`), DataDome, Akamai Bot Manager (`akam-challenge`), PerimeterX (`_pxhd`)
- Add content-length heuristic: if response is 200 OK but body < 2KB and contains `<script>` but no `<p>`, treat as likely challenge page
- Detect soft bot blocks: 200 OK with "please enable JavaScript" or "browser not supported" outside the first 4KB

**Location:** `src/core/wall-detector.ts`

### 1.3 Fix Empty 200 Response Handling

**Problem:** HTTP fetch returns 200 with empty body. Pipeline yields `empty_body` alert and gives up. No rendering retry.

**Fix:** In pipeline.ts, treat empty body as a render trigger (same as wall detection).

```
Location: src/core/pipeline.ts lines 83-94
Logic:
  if (body is empty && rendering enabled && mode !== 'rendered') {
    retry with rendered mode
  }
```

### 1.4 Fix Readability Silent Failures

**Problem:** `Readability.parse()` returns null on non-article HTML structures. This is logged at DEBUG level only. Ensemble silently falls back to DOM heuristic which often returns garbage.

**Fixes:**
- Log Readability failures at WARN level with URL
- Track a metric: `extraction.readability_failures` counter
- When Readability returns null AND DOM heuristic scores < 0.3, flag extraction as `degraded` in the confidence event
- Add a `degraded: boolean` field to the confidence payload so clients know extraction quality is uncertain

**Location:** `src/core/extraction-ensemble.ts`, `src/services/distiller.ts`

### 1.5 Confidence Score Honesty

**Problem:** Confidence scores don't distinguish "great extraction" from "extracted something but all methods struggled." A page where every extractor returned < 0.3 can still get an overall confidence of 0.5+.

**Fixes:**
- Track `bestCandidateScore` and `methodAgreement` (how many extractors returned similar content)
- If all extractors score below 0.35, cap overall confidence at 0.3 regardless of heuristic bonuses
- Add `extraction.candidates_evaluated` and `extraction.max_candidate_score` to the extraction event payload

**Location:** `src/core/extraction-ensemble.ts`, `src/core/pipeline.ts`

### 1.6 Rendering Retry with Different Wait Strategies

**Problem:** Renderer uses a single wait strategy (networkidle). Some sites load content via lazy loading or infinite scroll that never triggers networkidle.

**Fix:** On rendering failure or empty result, retry with `domcontentloaded` + 3s delay as fallback.

**Location:** `src/services/renderer.ts`

---

## Phase 2: Typed Extraction (Weeks 3-6)

### 2.1 Schema.org Type-Aware Extraction

**Problem:** We extract JSON-LD but don't use it to produce typed fields. An agent still has to parse `{"@type": "Product", "offers": {"price": 29.99}}` manually.

**Fix:** Add a `typedData` field to the pipeline output that normalizes JSON-LD into flat, typed objects:

```typescript
interface TypedData {
  type: 'product' | 'article' | 'recipe' | 'event' | 'organization' | 'person' | 'unknown';
  fields: Record<string, string | number | boolean | null>;
}

// Example output:
{
  type: 'product',
  fields: {
    name: 'Nintendo Switch OLED',
    price: 299.99,
    currency: 'USD',
    availability: 'InStock',
    brand: 'Nintendo',
    image: 'https://...'
  }
}
```

**Source priority:** JSON-LD > microdata > Open Graph > regex heuristics.

Only handle the top 6 Schema.org types that agents actually need: Product, Article, NewsArticle, Recipe, Event, LocalBusiness.

**Location:** New file `src/services/extractors/typed-data-extractor.ts`, wired into `distiller.ts`

### 2.2 Price/Date/Author Extraction Heuristics

**Problem:** Not every page has JSON-LD. Many pages have prices, dates, and authors in plain HTML.

**Fix:** Tier 2 extraction using DOM heuristics + regex patterns:
- **Prices:** `$XX.XX`, `XX,XX €`, elements with `itemprop="price"`, class patterns like `.price`, `.cost`
- **Dates:** `<time>` elements, `datetime` attributes, `itemprop="datePublished"`, common date regex patterns
- **Authors:** `itemprop="author"`, `rel="author"`, `class="author"`, byline patterns

No LLM involved. Pure structural extraction. Only emit when confidence > 0.7.

**Location:** New file `src/services/extractors/typed-primitives-extractor.ts`

### 2.3 Cross-Validate Typed Data Against Scraped Content

**Problem:** `crossValidate()` currently only works for marketplace adapters.

**Fix:** Generalize to all page types. If typed data says price is $29.99 and scraped text contains "$29.99", boost confidence. If they disagree, flag conflict.

**Location:** Extend `src/services/extractors/structured-data-enrichment.ts`

---

## Phase 3: Surface Hidden Features (Weeks 4-8)

### 3.1 Document and Test the Interact Layer

**Problem:** `/v1/interact` routes exist with click, fill, scroll, hover, type, screenshot, evaluate, getPageState — but zero documentation, no landing page mention, and limited guardrails.

**Fixes:**
- Add interact capabilities to the Anno landing page (already done for marketing, but add API docs)
- Add action validation: max 20 actions per request, timeout per action (5s default), block `evaluate` in production unless explicitly enabled
- Add action result in NDJSON stream for workflow chaining

### 3.2 Document and Test the Watch/Diff System

**Problem:** Watch system exists but diffs at the text line level. No typed diffing.

**Fixes:**
- Wire structured extraction into watch snapshots — store typed data alongside raw content
- Diff at the typed field level: "price changed from $29.99 to $34.99" instead of "line 47 changed"
- Add webhook payload that includes both field-level and text-level diffs
- Replace disk-based snapshot storage with Redis (currently filesystem under `data/snapshots/`)

### 3.3 Document and Test the Workflow Engine

**Problem:** Fully functional workflow engine (fetch, interact, extract, wait, screenshot, conditionals, loops, variable interpolation) — completely undocumented.

**Fix:** Add to landing page and API docs. This is a major differentiator — multi-step browser automation as a declarative YAML workflow.

### 3.4 Expose Crawl System Better

**Problem:** Crawler is production-grade (95% complete) with BFS/DFS, sitemap discovery, robots.txt compliance, deduplication, concurrency control. Barely mentioned in marketing.

**Fix:** Feature prominently. "Crawl an entire documentation site and get every page as structured JSON" is a killer use case for agent builders.

---

## Phase 4: Harden for Production (Weeks 6-10)

### 4.1 Session Persistence

**Problem:** Each interact/render request gets a fresh browser context. Agents can't maintain logged-in state.

**Fix:** Cookie jar persistence in Redis. Agent logs in via interact, Anno saves the resulting cookies keyed by session ID. Subsequent requests with that session ID restore cookies.

```typescript
// POST /v1/interact
{ url: "https://example.com/login", actions: [...], session: "my-session" }

// Later:
// POST /v1/content/fetch
{ url: "https://example.com/dashboard", session: "my-session" }
```

No credential storage. No OAuth handling. Just cookie/state persistence.

**Location:** New `src/services/session-store.ts`, updates to renderer and interact routes.

### 4.2 Action Discovery

**Problem:** Agents interacting with pages need to know what's possible (forms, buttons, links, pagination) before deciding what to do.

**Fix:** Add `actions` to extraction output:

```typescript
{
  type: 'actions',
  payload: {
    forms: [{ id: 'search', fields: ['query', 'category'], method: 'GET', action: '/search' }],
    pagination: { next: '/page/2', prev: null, total: 15 },
    links: { count: 47, external: 12, internal: 35 }
  }
}
```

Read-only discovery. Don't execute — let the agent decide.

**Location:** New file `src/services/extractors/action-discovery-extractor.ts`, wired into pipeline.

### 4.3 Interact Guardrails

**Problem:** No limits on actions. `evaluate` can run arbitrary JS. No sandboxing.

**Fixes:**
- Max 20 actions per request
- Per-action timeout (5s default, 15s max)
- `evaluate` disabled by default, enabled via config flag
- Block navigation to non-original domains during action sequences
- Log all actions for audit trail

### 4.4 Rate Limit Intelligence

**Problem:** HTTP client ignores `Retry-After` headers. 429 responses not retried.

**Fix:** Parse `Retry-After`, wait, retry once. Track per-domain rate limit signals in Redis for future requests.

**Location:** `src/core/http-client.ts`

---

## Phase 5: Strategic Capabilities (Months 3-6)

### 5.1 Real Embeddings for Semantic Search

**Problem:** Semantic search uses `DeterministicEmbeddingProvider` (bag-of-words hashing, not ML). Vector similarity is meaningless.

**Fix:** Add OpenAI or Anthropic embedding provider. Keep deterministic as fallback for offline/testing.

**Config:** `EMBEDDING_PROVIDER=openai|anthropic|deterministic`

### 5.2 LLM Backend for RAG

**Problem:** RAG pipeline is architecturally complete but answer generation returns a placeholder. Summarizer assumes mock implementation.

**Fix:** Wire in Anthropic/OpenAI for actual answer generation. Keep it optional — RAG only works if LLM backend is configured.

### 5.3 Amazon Adapter Completion

**Problem:** Amazon adapter exists with extraction methods but is disabled (`enabled: false`). CSS selectors likely incomplete across regions/variants.

**Fix:** Enable, test against 50+ real Amazon product pages, fix selectors. Add proxy rotation config. This is high-value because Amazon product data is the #1 e-commerce agent use case.

### 5.4 Per-URL Content Versioning

**Problem:** Cache stores single snapshot. No history.

**Fix:** Store last N versions per URL in Redis with timestamps. Enable "what changed since my last fetch?" queries. Foundation for entity-level diffing later.

### 5.5 Extraction Quality Dashboard

**Problem:** No visibility into extraction reliability over time. Silent failures are invisible.

**Fix:** Prometheus metrics for extraction method usage, failure rates, confidence distribution, rendering trigger rates. Expose via `/metrics` endpoint for Grafana.

---

## System Maturity Map (Current State)

| System | Maturity | Blocker for 99% |
|--------|----------|-----------------|
| Core Extraction Pipeline | 80% | Auto-render detection, confidence honesty |
| Readability Extractor | 85% | Silent null returns |
| DOM Heuristic Extractor | 70% | Too conservative on link-heavy pages |
| Structured Metadata Extractor | 95% | Just shipped, needs edge case hardening |
| Table Extractor | 95% | Just shipped |
| Renderer (Playwright) | 80% | No auto-trigger, single wait strategy |
| Wall Detector | 60% | 4KB scan limit, missing modern bot patterns |
| HTTP Client | 75% | Ignores Retry-After, no circuit breaker |
| Fetcher | 80% | Empty 200 not retried |
| Policy Engine | 85% | Can strip content silently |
| Caching (Redis + LRU) | 85% | No active invalidation |
| Auth/Quota | 90% | Production-ready |
| Rate Limiting | 90% | Production-ready |
| MCP Integration | 100% | Complete |
| Crawl System | 95% | Production-ready |
| Workflow Engine | 95% | Undocumented |
| Interact Layer | 75% | No guardrails, no session persistence |
| Watch/Diff System | 70% | Text-level only, disk-based storage |
| Semantic Search | 40% | Deterministic embeddings, not ML |
| RAG Pipeline | 30% | LLM backend stubbed |
| Memory System | 30% | In-memory only, no persistence |
| eBay Adapter | 95% | Production-ready |
| Amazon Adapter | 30% | Disabled, selectors incomplete |
| Walmart Adapter | 20% | Stub |
| Marketplace Registry | 90% | Built but no adapters registered |

---

## Priority Order

**Tier 1 — Must-fix for reliability (Phases 1-2):**
1. Auto-render detection on empty extraction
2. Empty 200 response retry
3. Wall detector expansion (Cloudflare, DataDome, Akamai patterns)
4. Readability failure logging and degradation flags
5. Confidence score honesty
6. Typed data extraction from JSON-LD

**Tier 2 — Surface what's built (Phase 3):**
7. Document interact, watch, workflow, crawl
8. Wire structured extraction into watch/diff
9. Update landing page with full API docs

**Tier 3 — Harden for production (Phase 4):**
10. Session persistence (cookie jar)
11. Action discovery
12. Interact guardrails
13. Rate limit intelligence

**Tier 4 — Strategic expansion (Phase 5):**
14. Real embeddings
15. LLM backend for RAG
16. Amazon adapter completion
17. Content versioning
18. Extraction quality dashboard

---

## Benchmark Targets

| Metric | Current | Target (Phase 1) | Target (Phase 2) |
|--------|---------|-------------------|-------------------|
| Sites with content (of 31) | 22 (71%) | 28 (90%) | 30 (97%) |
| Median token reduction | 97% | 97% | 97% |
| Sites with structured metadata | 17/22 | 25/31 | 29/31 |
| Sites with typed data | 0 | 10/31 | 20/31 |
| Extraction confidence accuracy | Unknown | Measurable | > 0.8 correlation |
| Rendering auto-trigger rate | 0% | 100% of empty extractions | 100% |

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/services/extractors/typed-data-extractor.ts` | JSON-LD → flat typed objects |
| `src/services/extractors/typed-primitives-extractor.ts` | Price/date/author from DOM |
| `src/services/extractors/action-discovery-extractor.ts` | Form/pagination/link discovery |
| `src/services/session-store.ts` | Redis-backed cookie jar persistence |

## Files to Modify

| File | Change |
|------|--------|
| `src/core/pipeline.ts` | Auto-render retry on empty extraction, typed data event, action discovery event |
| `src/core/wall-detector.ts` | Expand patterns, increase scan limit, add content-length heuristic |
| `src/core/extraction-ensemble.ts` | Degradation flagging, candidate score tracking |
| `src/services/distiller.ts` | Wire typed extractors, log Readability failures |
| `src/services/renderer.ts` | Fallback wait strategy on empty render |
| `src/core/http-client.ts` | Parse Retry-After, retry 429s |
| `src/services/extractors/structured-data-enrichment.ts` | Generalize beyond marketplace |
| `src/api/routes/watch.ts` | Typed field diffing |
| `src/api/routes/interact.ts` | Guardrails, session support |
