# Migration Guide - Anno v0.2.0

## Overview

Version 0.2.0 introduces **Competitive Readiness** features including domain-aware policies, provenance tracking, ETag cache validation, and enhanced observability.

## Breaking Changes

### None - Fully Backward Compatible

All new features are opt-in and use sane defaults. Existing deployments will continue to work without modification.

---

## New Environment Variables

### Policy Engine

```bash
# Enable/disable policy engine (default: true)
POLICY_ENABLED=true

# Path to policy files directory (default: ./policies)
POLICY_DIR=./policies

# Default policy to use (default: default.yaml)
DEFAULT_POLICY=default.yaml

# Validate policies on startup (default: true)
POLICY_VALIDATION_ENABLED=true
```

### Cache Enhancements

```bash
# Optional: Encrypt cached bodies at rest (AES-256)
# If not set, caching works normally without encryption
CACHE_ENCRYPTION_KEY=your-32-char-encryption-key-here
```

### Robots.txt Override

```bash
# Allow fetching disallowed paths (default: false)
# WARNING: Only enable for authorized testing
OVERRIDE_ROBOTS=false
```

### Observability

```bash
# Enable per-stage latency tracking (default: true)
ENABLE_STAGE_METRICS=true
```

### Domain Configuration

```bash
# Path to domain-specific rendering config (default: ./config/domains.yaml)
DOMAIN_CONFIG_PATH=./config/domains.yaml
```

---

## New Features

### 1. Domain-Aware Policies

Automatically apply content extraction policies based on domain patterns.

**Included Presets:**
- `default.yaml` - Generic web content
- `news.yaml` - News articles (NYTimes, CNN, BBC, etc.)
- `docs.yaml` - Technical documentation
- `ecommerce.yaml` - Product pages (Amazon, eBay)
- `academic.yaml` - Research papers (arXiv, IEEE)

**Custom Policies:**

Create `policies/custom.yaml`:

```yaml
name: custom
version: 1.0.0
domain: '*.example.com'
preset: default

keep:
  - selector: 'article'
  - selector: '.main-content'

drop:
  - selector: '.ad'
  - selector: 'nav'
  - regex: 'Advertisement'

fields:
  title:
    required: true
  main:
    required: true
    minLength: 100
```

### 2. Provenance & Source-Spans

Every extracted node now includes traceable source information:

```json
{
  "nodes": [
    {
      "id": "node-1",
      "text": "Article content...",
      "sourceSpans": [
        {
          "url": "https://example.com",
          "timestamp": 1733512800000,
          "contentHash": "sha256:abc123...",
          "byteStart": 1234,
          "byteEnd": 5678
        }
      ]
    }
  ],
  "contentHash": "sha256:abc123..."
}
```

**Verification:**

```typescript
import { verifyProvenance } from './src/utils/provenance-verify';

const result = verifyProvenance(originalHtml, distillationResult.nodes[0].sourceSpans);
console.log(result.valid); // true/false
console.log(result.details); // { contentHashMatch, byteOffsetsValid, ... }
```

### 3. ETag/Last-Modified Support

HTTP client now extracts cache validation headers:

```typescript
// Response includes:
{
  etag: '"abc123"',
  lastModified: 'Wed, 21 Oct 2025 07:28:00 GMT',
  wasNotModified: false // true for 304 responses
}
```

### 4. Enhanced Metrics

New Prometheus metrics:
- `anno_policy_applications_total` - Policy application count by policy name
- `anno_cache_validations_total` - Cache validation attempts (ETag/Last-Modified)
- `anno_304_responses_total` - HTTP 304 Not Modified responses
- `anno_provenance_coverage_ratio` - Percentage of nodes with provenance

---

## Upgrade Steps

### 1. Install Dependencies

```bash
npm install --legacy-peer-deps
```

### 2. Create Policy Directory (Optional)

```bash
mkdir -p policies
# Default policies are included, customize as needed
```

### 3. Update Environment (Optional)

Add any desired configuration to `.env`:

```bash
# Enable all new features (these are defaults)
POLICY_ENABLED=true
POLICY_DIR=./policies
ENABLE_STAGE_METRICS=true
```

### 4. Restart Service

```bash
npm run build
npm start
```

### 5. Verify

```bash
# Check health endpoint for policy version
curl http://localhost:5213/health

# Should include:
{
  "policies": {
    "enabled": true,
    "count": 5,
    "fingerprint": "a1b2c3d4"
  }
}
```

---

## API Changes

### Distillation Response

New fields added to `/v1/content/fetch` response:

```json
{
  "contentHash": "sha256:...",
  "nodes": [...],  // Now include sourceSpans
  "policyMetadata": {
    "policyApplied": "news",
    "rulesMatched": 12,
    "fieldsValidated": true
  }
}
```

### Policy Hints

You can now specify a policy hint in requests:

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://nytimes.com/article",
    "options": {
      "policyHint": "news"
    }
  }'
```

---

## Performance Impact

- **Policy Processing:** +5-15ms per request (HTML transformation)
- **Provenance Tracking:** +2-5ms per request (hash computation, byte offset calculation)
- **ETag Support:** No overhead (passive header extraction)

**Total:** ~10-20ms additional latency, negligible for most use cases.

---

## Rollback

To disable new features:

```bash
# Disable policies
POLICY_ENABLED=false

# Restart
npm start
```

Or revert to v0.1.0:

```bash
git checkout v0.1.0
npm install --legacy-peer-deps
npm run build
npm start
```

---

## Support

- GitHub Issues: https://github.com/evo-nirvana/anno/issues
- Docs: https://github.com/evo-nirvana/anno/docs/

---

**Version:** 0.2.0
**Release Date:** 2025-10-06
**Semantic Versioning:** Minor (backward-compatible features)
