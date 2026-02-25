# Anno — Lincoln Labs Demo Script

**Duration:** 5-7 minutes (2 min pitch + 3 min live demo + 2 min discussion)
**Date:** Week of Feb 24, 2026
**Presenter:** Nic

---

## Setup Checklist (Before the Meeting)

- [ ] Anno running at `https://anno.evolvingintelligence.ai`
- [ ] Landing page live at `https://evolvingintelligence.ai`
- [ ] Terminal open with pre-staged curl commands (below)
- [ ] Browser tabs ready: landing page, Claude Code with Anno MCP
- [ ] Pre-test all demo URLs to confirm they work

---

## The Pitch (2 minutes)

### Opening (30 seconds)

> "Every AI agent that reads the web — whether it's customer support, research automation, content monitoring — has the same problem: **95% of what it downloads is garbage.** HTML tags, JavaScript bundles, cookie banners, ad trackers. The LLM never needed any of it, but you're paying for every token."

### The Problem, Quantified (30 seconds)

> "A single page from CNN is about 15,000 tokens. The actual news content? About 600 tokens. That's a **96% waste rate.** Multiply that by thousands of agent calls per day, and you're looking at real money — companies are spending 10-20x what they should on API costs just because no one solved the extraction problem properly."

### The Solution (30 seconds)

> "Anno is an API that takes any URL and returns clean, structured content. No HTML. No scripts. No ads. Just the text your AI actually needs. It handles JavaScript-rendered pages, paywalls, anti-bot protection — all the hard stuff."

### The Business (30 seconds)

> "Anno is running in production today. It has API key authentication, rate limiting, Redis caching, Prometheus metrics, health checks, Docker deployment — it's not a prototype, it's infrastructure. The margins are 95%+ because a $15/month server handles thousands of requests. Free tier gets developers hooked, Pro at $29/month for teams, Business at $99 for scale."

---

## Live Demo (3 minutes)

### Demo 1: The Before/After (60 seconds)

**Terminal — Raw HTML token count:**
```bash
# Show how many tokens raw HTML costs
curl -s https://www.cnn.com | wc -c
# Result: ~500,000+ characters = ~125,000 tokens
```

**Terminal — Anno extraction:**
```bash
# Now extract with Anno
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.cnn.com", "render": false}' | head -20
```

> "Same page. Same information. 95% fewer tokens. That's money back in your pocket on every single API call."

### Demo 2: JavaScript-Rendered Content (60 seconds)

```bash
# A React SPA that returns nothing without JS rendering
curl -s -X POST https://anno.evolvingintelligence.ai/v1/content/fetch \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com", "render": true}'
```

> "This page is JavaScript-rendered. A normal fetch gets you an empty shell. Anno fires up a headless browser with stealth mode, waits for content to load, then extracts. Your agent gets the content without managing any browser infrastructure."

### Demo 3: MCP Integration (60 seconds)

**Switch to Claude Code or show the landing page "Try It" section.**

> "Anno also works as an MCP tool. This means Claude Code, or any MCP-compatible agent, can use it natively. Watch — I ask Claude to summarize this article, and it uses Anno to fetch clean content instead of raw HTML."

Show Claude Code using `anno_fetch` in real-time.

---

## The Ask (1 minute)

> "I built this. I also built Sentinel, which is persistent project intelligence for AI-assisted development — it learns your codebase patterns and helps AI write better code. Both products are production-ready."

> "What I'm looking for is a partner on the business side. I can build the technology all day — I need someone to help with go-to-market, sales, and scaling. The market is every company using AI agents, and that market is growing exponentially."

---

## Pre-Staged URLs for Demo

These are tested to produce dramatic, clean results:

| URL | Why It's Good |
|-----|---------------|
| `https://www.cnn.com` | Massive HTML, tiny content — best before/after |
| `https://news.ycombinator.com` | JS-rendered, shows render capability |
| `https://en.wikipedia.org/wiki/Artificial_intelligence` | Long-form content, clean structured extraction |
| `https://techcrunch.com` | News site with heavy ads/tracking |
| `https://arxiv.org/abs/2301.00234` | Academic paper, shows domain-specific extraction |

---

## Handling Questions

**"How is this different from Beautiful Soup / Readability?"**
> Anno uses ensemble extraction — multiple algorithms vote on what's content vs noise, with confidence scoring. It handles JS rendering, anti-bot detection, and streams NDJSON. It's not a parser, it's infrastructure.

**"What about scale?"**
> A single $15 Hetzner box handles hundreds of concurrent requests with Redis caching. The architecture is stateless — you scale horizontally by adding boxes behind a load balancer. The enterprise config already supports multi-instance deployment.

**"Who's the customer?"**
> Any company running AI agents that read the web. That's customer support automation, research tools, content monitoring, competitive intelligence, SEO tools — and the market is growing fast as agents become mainstream.

**"What's the competitive landscape?"**
> Jina Reader does URL-to-markdown but it's a simple HTTP redirect, no auth, no caching, no metrics, no SPA support. Firecrawl is closest but positioned as a scraping tool, not an AI infrastructure layer. Anno is built specifically for the AI agent use case.

**"Revenue today?"**
> Pre-revenue. The product is production-ready, the infrastructure works. What I need is help going from product to business — pricing validation, sales channels, and the first 100 paying customers.
