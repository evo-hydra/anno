# FlipIQ eBay Sold Price Workflow

This guide explains how to run Anno as a service for FlipIQ-style pricing analysis. It covers configuration, anti-bot considerations, API usage, and downstream processing for sold listings scraped from eBay.

> **Status:** Uses the deterministic semantic stack delivered in Sprint 3. Swap in LangChain/LLM components when provider dependencies are installed.

---

## 1. Architecture Overview
1. Anno fetches an eBay listing (or search result) with the eBay adapter and stealth rendering enabled.
2. Content is distilled into structured data (price, currency, sold date, condition, seller info).
3. The distilled record is seeded into the semantic index (`/v1/semantic/index`).
4. Semantic search and RAG endpoints power pricing comparisons and summaries.
5. Session memory retains pricing queries for audit trails.

Key modules:
- `src/services/distiller.ts` → eBay adapter logic.
- `src/services/fetcher.ts` → stealth/renderer integration.
- `examples/flipiQ-ebay-pricing.ts` → runnable demo script.

---

## 2. Prerequisites
- **Anno server** running locally (`npm run dev`) or via Docker Compose (`docker compose up --build`).
- **Environment variables** in `.env.local`:
  ```
  AI_EMBEDDING_PROVIDER=deterministic
  AI_VECTOR_STORE=memory
  AI_SUMMARIZER=heuristic
  AI_DEFAULT_K=3
  RENDERING_ENABLED=true
  RENDER_STEALTH=true
  ```
- **Optional:** `PLAYWRIGHT_BROWSERS_PATH=0` and `npx playwright install chromium` if headless rendering is required.

> For production, store credentials and API keys in your secret manager (Vault, AWS Secrets Manager, etc.) rather than committing `.env.local`.

---

## 3. Anti-Bot / Stealth Strategy
- **Headless detection**: Anno’s fetcher enables stealth mode via Playwright when `RENDER_STEALTH=true`. This injects browser evasions (user agent, webdriver flags) to bypass Cloudflare-style checks.
- **Incognito sessions**: Each Playwright context is launched with isolated storage; set `RENDER_HEADLESS=false` in staging if you need to observe the renderer.
- **Polite crawling**: Respect robots.txt by default (`RESPECT_ROBOTS=true`). Override only if you have legal clearance from the client.
- **Rate limiting**: Configure `RENDER_MAX_PAGES` and your orchestrator’s concurrency so you respect eBay’s TOS. Anno’s domain rate-limiter defaults to 1 req/sec.
- **Proxy rotation (optional)**: If you need IP diversity, set `PROXY_URL=socks5://user:pass@proxy:1080` and let Playwright route traffic through it.

---

## 4. Workflow Walkthrough

### 4.1 Index Historical Listings
Use the helper script (`examples/flipiQ-ebay-pricing.ts`) or curl:
```bash
curl -X POST http://localhost:5213/v1/semantic/index \
  -H 'Content-Type: application/json' \
  -d '{
        "documents": [
          {
            "id": "ebay-1",
            "text": "Sold Listing: Canon AE-1 Program camera with 50mm lens sold for $220 on September 10, 2025.",
            "metadata": {
              "listingId": "CANON-AE1-123",
              "price": "$220",
              "soldDate": "2025-09-10",
              "url": "https://www.ebay.com/itm/..."
            }
          }
        ]
      }'
```

### 4.2 Query Similar Sales
```bash
curl -X POST http://localhost:5213/v1/semantic/search \
  -H 'Content-Type: application/json' \
  -d '{
        "query": "Canon AE-1 sold price",
        "k": 3
      }'
```

### 4.3 Generate Pricing Summary (RAG)
```bash
curl -X POST http://localhost:5213/v1/semantic/rag \
  -H 'Content-Type: application/json' \
  -d '{
        "query": "Summarize recent Canon AE-1 sold prices",
        "sessionId": "flipiQ-session",
        "k": 3,
        "summaryLevels": ["headline", "paragraph"]
      }'
```
The response includes `answer`, `citations`, and cached summaries. With `sessionId`, results are stored in `/v1/memory/flipiQ-session`.

### 4.4 Inspect Session Memory
```bash
curl http://localhost:5213/v1/memory/flipiQ-session
```

---

## 5. Integrating with FlipIQ
1. **Anno Service** – run behind your firewall and secure it with API keys or mTLS.
2. **FlipIQ Worker** – posts new listings to `/v1/semantic/index` and calls `/v1/semantic/rag` for pricing guidance.
3. **Database** – store returned summaries, citations, and raw metrics in FlipIQ’s datastore for analytics dashboards.
4. **Alerting** – set thresholds (e.g., price deviation ≥15%) based on RAG outputs and send notifications via your existing channels.

---

## 6. FAQ & Troubleshooting
- **Cloudflare challenge**: ensure `RENDER_STEALTH=true` and verify Chromium dependencies are installed. Rotate proxies if IPs are blocked.
- **Incomplete data**: eBay responsive pages may require full rendering; set `RENDERING_ENABLED=true` and `RENDER_WAIT_UNTIL=networkidle`.
- **Latency**: heuristic summarizer is fast (<1s). Once LangChain is enabled, expect higher latency and token costs; add caching to avoid reprocessing identical listings.
- **Robots.txt blocked**: Anno respects robots by default. If your legal counsel approves, set `RESPECT_ROBOTS=false` (not recommended for production without compliance review).

---

## 7. Next Steps
- Install LangChain and replace the heuristic summarizer with LLM-backed summaries when provider access is available.
- Integrate Redis/Pinecone for persistent semantic storage so pricing history survives restarts.
- Add automated tests using recorded eBay HTML fixtures to prevent regressions.
- Build dashboards or notebooks on top of session memory for FlipIQ analysts.

> Track progress in `project-management/sprints/SPRINT_03_PLAN.md` and `SPRINT_03_STATUS.md`.
