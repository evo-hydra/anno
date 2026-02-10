# Known Limitations - Anno v0.2.0

## Overview

This document outlines current limitations, workarounds, and planned improvements for Anno.

---

## Content Extraction

### 1. JavaScript-Heavy SPAs

**Limitation:** Sites requiring complex JavaScript execution may have incomplete extraction.

**Affected Sites:**
- React/Vue/Angular SPAs without SSR
- Dynamic content loaded via AJAX
- Infinite scroll content

**Workaround:**
- Enable rendering mode: `"options": { "render": true }`
- Increase timeout: `RENDER_TIMEOUT_MS=30000`
- Use `waitUntil: 'networkidle'`

**Planned:** Domain-specific rendering configs (v0.3.0)

### 2. Paywalled Content

**Limitation:** Cannot extract content behind authentication walls.

**Workaround:**
- Provide cookies in request (v0.2.0+):
  ```json
  {
    "url": "https://example.com",
    "cookies": [{"name": "session", "value": "..."}]
  }
  ```

**Security:** Audit logged, never persisted

### 3. CAPTCHA/Bot Detection

**Limitation:** Sites with aggressive bot detection may block requests.

**Mitigation:**
- Stealth mode enabled by default
- User-agent rotation
- Respect `Crawl-Delay`

**Not Supported:**
- CAPTCHA solving
- Advanced fingerprinting bypass

---

## Policy Engine

### 1. Regex Performance

**Limitation:** Complex regex patterns can slow extraction by 10-20ms.

**Workaround:**
- Use selector-based rules when possible
- Limit regex to essential patterns
- Pre-compile patterns (automatic)

**Benchmark:** 15ms overhead for 10 regex rules

### 2. Policy Inheritance

**Limitation:** Policies cannot inherit from other custom policies (only presets).

**Example:**
```yaml
# NOT SUPPORTED
preset: my-custom-policy

# SUPPORTED
preset: news  # Built-in preset only
```

**Planned:** Full policy inheritance (v0.3.0)

### 3. Dynamic Policy Updates

**Limitation:** Policy changes require restart in production.

**Workaround:** Dev mode auto-reloads on file change

**Planned:** Hot-reload API endpoint (v0.3.0)

---

## Provenance & Source-Spans

### 1. Byte Offset Precision

**Limitation:** Byte offsets may be approximate for transformed content.

**Scenarios:**
- Whitespace normalized
- HTML entities decoded
- Policy transformations applied

**Verification:** Always use `verifySourceSpan()` before trusting offsets

### 2. Multi-Span Nodes

**Limitation:** Nodes with content from multiple locations have multiple spans.

**Example:**
```json
{
  "text": "Combined from header and footer",
  "sourceSpans": [
    {"byteStart": 100, "byteEnd": 125},
    {"byteStart": 5000, "byteEnd": 5025}
  ]
}
```

**Impact:** Verification checks all spans independently

### 3. Hash Algorithm

**Limitation:** SHA-256 only (no configurable algorithms).

**Reasoning:** Balance of security and performance

**Future:** May add BLAKE3 option (faster, equally secure)

---

## Caching

### 1. ETag/Last-Modified Support

**Limitation (v0.2.0):** Partial implementation
- ✅ Extracts headers
- ✅ Handles 304 responses
- ⏳ Conditional requests (in progress)
- ⏳ Cache revalidation (in progress)

**Status:** Full support planned for v0.2.1

### 2. Cache Encryption

**Limitation:** Optional AES-256 encryption adds ~5ms overhead.

**When to use:**
- Storing sensitive content
- Compliance requirements

**When to skip:**
- Public content only
- Performance critical

### 3. Distributed Caching

**Limitation:** Redis supports single-node only (no clustering).

**Workaround:** Use Redis Cluster-aware client (manual setup)

**Planned:** Built-in Redis Cluster support (v0.3.0)

---

## Rendering

### 1. Concurrency Limits

**Limitation:** Max concurrent renders controlled by `RENDER_MAX_PAGES` (default: 2).

**Reason:** Browser memory/CPU limits

**Workaround:**
- Increase limit carefully: `RENDER_MAX_PAGES=5`
- Monitor memory usage
- Use queue for high load

**Recommended:** 2-5 concurrent renders per instance

### 2. Stealth Mode Effectiveness

**Limitation:** Stealth mode reduces but doesn't eliminate bot detection.

**Effectiveness:**
- ✅ Bypasses basic checks (navigator.webdriver)
- ✅ Randomizes viewport/user-agent
- ❌ May fail against advanced fingerprinting

**Best Practice:** Respect `robots.txt` and rate limits

### 3. Cookie Persistence

**Limitation:** Cookies not persisted between requests.

**Design:** Security by default (no credential storage)

**Workaround:** Pass cookies on every request if needed

---

## Performance

### 1. Large Pages

**Limitation:** Pages >10MB may timeout or exhaust memory.

**Symptoms:**
- Timeouts during fetch
- OOM errors during distillation
- Slow policy application

**Workaround:**
- Increase `FETCH_TIMEOUT_MS`
- Use streaming (not yet implemented)
- Apply aggressive drop policies

**Planned:** Streaming extraction (v0.3.0)

### 2. Cold Start

**Limitation:** First request 500-1000ms slower (browser launch).

**Mitigation:**
- Keep-alive connection
- Pre-launch browser on startup

**Workaround:**
```bash
# Pre-initialize renderer
curl http://localhost:5213/health
```

### 3. Memory Usage

**Limitation:** Each rendered page ~100-200MB RAM.

**Calculation:**
- Base process: ~200MB
- Per page: ~100MB
- Max concurrent=5: ~700MB total

**Recommendation:** 2GB RAM per instance minimum

---

## Observability

### 1. Metrics Retention

**Limitation:** In-memory metrics reset on restart.

**Impact:** Lost historical data

**Workaround:**
- Use Prometheus scraper (exports before restart)
- Export to persistent store

**Planned:** Metrics persistence option (v0.3.0)

### 2. Distributed Tracing

**Limitation:** No OpenTelemetry integration yet.

**Current:** Request IDs for correlation only

**Planned:** Full OTEL support (v0.4.0)

### 3. Log Volume

**Limitation:** DEBUG level generates high log volume.

**Recommendation:**
- Production: `LOG_LEVEL=info`
- Development: `LOG_LEVEL=debug`
- Troubleshooting: `LOG_LEVEL=debug` + filtering

---

## API

### 1. Batch Fetching

**Limitation:** No built-in batching (must call `/batch-fetch` endpoint).

**Example:**
```bash
POST /v1/content/batch-fetch
{
  "urls": ["url1", "url2", "url3"],
  "options": { "parallel": 3 }
}
```

**Max:** 10 URLs per batch

### 2. Webhook Callbacks

**Limitation:** No async webhook support.

**Current:** Synchronous requests only

**Planned:** Async job queue with webhooks (v0.3.0)

### 3. Rate Limiting

**Limitation:** Per-domain rate limiting is basic (fixed delay).

**Current:** Simple token bucket

**Planned:**
- Adaptive rate limiting
- Backpressure handling
- Priority queues

---

## Security

### 1. Credential Management

**Limitation:** No built-in credential vault.

**Current:** Cookies passed per-request

**Future:** May add secure credential store (v0.4.0)

### 2. Content Sanitization

**Limitation:** Basic HTML sanitization only.

**Not Protected Against:**
- Advanced XSS vectors
- Polyglot payloads
- Zero-day exploits

**Recommendation:** Run in isolated environment

### 3. Robots.txt Enforcement

**Limitation:** Can be overridden with `OVERRIDE_ROBOTS=true`.

**Risk:** Violates website ToS

**Recommendation:** Only enable for authorized testing

---

## Deployment

### 1. Horizontal Scaling

**Limitation:** No built-in load balancing.

**Workaround:** Use external LB (nginx, HAProxy, AWS ALB)

**Session Affinity:** Not required (stateless)

### 2. Browser Dependencies

**Limitation:** Requires Chromium installation.

**Installation:**
```bash
npx playwright install chromium
```

**Docker:** Must install in container

### 3. Configuration Reloading

**Limitation:** Most config requires restart.

**Exceptions:**
- Policies (dev mode only)

**Planned:** Hot-reload API (v0.3.0)

---

## Roadmap

### v0.2.1 (Planned)
- ✅ Complete ETag/Last-Modified support
- ✅ Conditional request implementation
- ✅ Cache revalidation

### v0.3.0 (Planned)
- ✅ Domain-specific rendering configs
- ✅ Policy inheritance
- ✅ Streaming extraction for large pages
- ✅ Hot-reload API

### v0.4.0 (Planned)
- ✅ OpenTelemetry integration
- ✅ Async job queue with webhooks
- ✅ Credential vault
- ✅ Redis Cluster support

---

## Reporting Issues

Found a limitation not listed here?

**GitHub Issues:** https://github.com/evo-nirvana/anno/issues

**Include:**
1. Version: `0.2.0`
2. Reproduction steps
3. Expected vs. actual behavior
4. Logs (with `LOG_LEVEL=debug`)

---

**Last Updated:** 2025-10-06
**Version:** 0.2.0
