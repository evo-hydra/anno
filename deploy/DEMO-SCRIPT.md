# Anno — Lincoln Labs Demo Script

**Duration:** 5-7 minutes (2 min pitch + 4 min live demo + 1 min ask)
**Date:** Feb 25, 2026
**Presenter:** Nic

---

## Setup Checklist (Before the Meeting)

- [ ] Anno running at `https://anno.evolvingintelligence.ai`
- [ ] Health check green: `curl https://anno.evolvingintelligence.ai/health`
- [ ] Landing page live at `https://evolvingintelligence.ai/anno`
- [ ] Terminal open with pre-staged curl commands (copy from below)
- [ ] Browser tab: landing page (shows 4 capability categories)
- [ ] Browser tab: Claude Code with Anno MCP configured
- [ ] Pre-test all 4 demo URLs — they should return data within 2 seconds

**API Key for demo:**
```
CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32
```

---

## The Pitch (2 minutes)

### Opening (30 seconds)

> "Every AI agent that reads the web — whether it's customer support, research automation, content monitoring — has the same problem: **95% of what it downloads is garbage.** HTML tags, JavaScript bundles, cookie banners, ad trackers. The LLM never needed any of it, but you're paying for every token."

### The Problem, Quantified (30 seconds)

> "A single page from CNN is 4.9 megabytes of HTML. The actual content your agent needs? About 18 kilobytes. That's a **99.6% waste rate.** Multiply that by thousands of agent calls per day, and you're burning real money — companies spend 100x what they should on API costs because no one solved the extraction problem properly."

### The Solution (30 seconds)

> "Anno is an API that takes any URL and returns clean, structured content. Not just stripped text — it returns typed JSON: the article's schema.org metadata, Open Graph tags, tables as JSON arrays, confidence scores on every piece of data. It handles JavaScript-rendered SPAs, anti-bot detection, and streams results as NDJSON so agents can process content before the full page is done."

### The Business (30 seconds)

> "Anno is running in production right now. API key auth, per-key rate limiting, Redis caching, Prometheus metrics, Docker on a $15/month Hetzner box handling hundreds of concurrent requests. Margins are 95%+. Free tier at 200 requests/month hooks developers, Pro at $29/month for teams, Business at $99 for scale."

---

## Live Demo (4 minutes)

### Demo 1: The Before/After (45 seconds)

**Terminal — show the waste:**
```bash
# How big is CNN's raw HTML?
curl -s https://www.cnn.com | wc -c
# → 4,943,120 bytes (≈1.2 million tokens at $3/MTok = $3.60 per page view)
```

**Terminal — Anno extraction:**
```bash
# Same page through Anno
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.cnn.com"}' | head -5
```

> "Same page. 4.9 megabytes becomes 18 kilobytes. And look at the third line — Anno also extracted CNN's JSON-LD schema: it knows this is a NewsMediaOrganization, it pulled the publisher name, the social links, the search action URL. Your agent gets structured intelligence, not a wall of HTML."

**What to point at:** The `structured` event in the NDJSON output showing `@type: WebPage`, `publisher.name: CNN`, and the Open Graph metadata.

### Demo 2: Structured Data Extraction (45 seconds)

```bash
# New York Times — rich structured metadata
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.nytimes.com"}' \
  | grep '"type":"structured"' | python3 -m json.tool
```

> "This is new — Anno now extracts all structured metadata from the page. JSON-LD with schema.org types, Open Graph tags, Twitter Card data, and microdata. An agent reading the NYT gets back typed objects: WebSite, NewsMediaOrganization, with names, logos, social links. This is the kind of structured intelligence that separates a real extraction API from a text stripper."

**What to point at:** Two JSON-LD items (`WebSite` + `NewsMediaOrganization`), full OG tags with title/description/image, confidence score of 0.7.

### Demo 3: Table Extraction (45 seconds)

```bash
# Wikipedia — tables become JSON
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)"}' \
  | grep '"type":"tables"' | python3 -c "
import sys, json
d = json.loads(sys.stdin.readline())
tables = d['payload']['tables']
main = [t for t in tables if t['rowCount'] > 10][0]
print(f'Table: {main[\"rowCount\"]} rows')
print(f'Headers: {main[\"headers\"]}')
print(f'Row 1: {json.dumps(main[\"rows\"][0], indent=2)}')
print(f'Row 2: {json.dumps(main[\"rows\"][1], indent=2)}')
"
```

> "Also new — Anno converts HTML tables into structured JSON. This Wikipedia page has a 222-row GDP table with data from the IMF, World Bank, and UN. An agent gets headers and typed rows it can query, filter, compare — no HTML parsing needed. Every table on the page, automatically."

**What to point at:** 222 rows, clean headers (`Country/Territory, IMF(2026), World Bank(2024), United Nations(2024)`), first row showing `United States: $31.8 trillion`.

### Demo 4: JavaScript Rendering (45 seconds)

```bash
# React.dev — a fully client-rendered SPA
# First, show that raw fetch gets nothing useful:
curl -s https://react.dev | grep -c '<div'
# → mostly empty shell, content rendered by JavaScript

# Now with Anno's browser rendering:
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer CHANGE_ME_GENERATE_WITH_openssl_rand_hex_32" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://react.dev", "render": true}' \
  | grep '"type":"node"' | head -3
```

> "React's own website is a client-rendered SPA — there's nothing in the HTML source. Anno spins up a headless Chromium browser with anti-detection stealth mode, renders the JavaScript, waits for content, then extracts. 28 clean content nodes. Your agent doesn't need to manage browser infrastructure — Anno handles it."

**What to point at:** The `rendered: true` in metadata, and the extracted text "The library for web and native user interfaces" — proving JS was executed.

---

## The Ask (1 minute)

> "So that's Anno. Clean extraction, structured metadata, table-to-JSON, JavaScript rendering — all production-ready, all running right now on a $15/month server. The landing page you see shows the full picture: we also have browser automation, page watching, content diffing, crawling, semantic search, and a RAG pipeline. It's a complete web intelligence layer for AI agents."

> "I built this, and I also built Sentinel — persistent project intelligence for AI-assisted development. Both products are production-ready infrastructure."

> "What I'm looking for is a partner on the business side. I can build the technology all day — I need someone to help with go-to-market, sales, and scaling. The market is every company using AI agents, and that market is growing exponentially."

---

## Pre-Staged URLs (Tested Feb 25, 2026)

| URL | Demo | Why It Works |
|-----|------|--------------|
| `https://www.cnn.com` | Before/After | 4.9MB raw → 18KB extracted, rich JSON-LD |
| `https://www.nytimes.com` | Structured Data | 2 JSON-LD items, full OG, confidence 0.7 |
| `https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)` | Tables | 222-row GDP table with 3 sources as clean JSON |
| `https://react.dev` | JS Rendering | Fully client-rendered React SPA, 28 nodes extracted |
| `https://www.bbc.com/news` | Backup | JSON-LD WebPage, OG+Twitter, good fallback for Demo 1 or 2 |

### Backup URLs (if primary fails)
| URL | Replaces | Notes |
|-----|----------|-------|
| `https://techcrunch.com` | CNN | Multiple JSON-LD types (CollectionPage, BreadcrumbList, WebSite) |
| `https://en.wikipedia.org/wiki/Artificial_intelligence` | GDP table | Long-form article extraction, JSON-LD Article type |

---

## Handling Questions

**"How is this different from Beautiful Soup / Readability?"**
> Anno uses ensemble extraction — four algorithms vote on what's content vs noise, each with Bayesian confidence scoring. On top of that, we now extract structured metadata (JSON-LD, Open Graph, microdata) and convert tables to JSON. It handles JS rendering and anti-bot detection. It's not a parser — it's infrastructure.

**"What about Firecrawl / Jina Reader?"**
> Jina Reader does URL-to-markdown but it's a simple HTTP redirect — no auth, no caching, no metrics, no SPA support, no structured data extraction. Firecrawl is closer but positioned as a scraping tool. Anno is built specifically for the AI agent use case: confidence scores, NDJSON streaming, marketplace adapters, cross-validation between scraped data and structured metadata. We're not scraping — we're extracting intelligence.

**"What about scale?"**
> A single $15 Hetzner box handles hundreds of concurrent requests with Redis caching. The architecture is stateless — you scale horizontally by adding boxes behind a load balancer. Docker Compose, health checks, Prometheus metrics — it's production infrastructure, not a side project.

**"Who's the customer?"**
> Any company running AI agents that read the web. Customer support automation, research tools, content monitoring, competitive intelligence, SEO tools, e-commerce price tracking — and the market is growing exponentially as agents become mainstream.

**"What's the structured metadata useful for?"**
> Three things. First, agents can make decisions based on schema types — knowing a page is a Product vs a NewsArticle vs a Recipe changes how you process it. Second, cross-validation — we compare scraped prices against JSON-LD prices to boost confidence scores, so agents know when data is trustworthy. Third, social metadata for content curation — OG images, descriptions, Twitter cards, all as typed JSON instead of regex.

**"Revenue today?"**
> Pre-revenue. The product is production-ready, the infrastructure works. I'm looking for help going from product to business — pricing validation, sales channels, and the first 100 paying customers.

**"Can I try it?"**
> Right now. The landing page has a live demo, or I can give you an API key. There's also an MCP integration so Claude Code or any MCP-compatible agent can use it natively.
