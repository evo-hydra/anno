# Policy Engine Documentation

## Overview

Anno's Policy Engine enables **domain-aware content extraction** by applying transformation rules based on URL patterns. Policies define which elements to keep, drop, or transform, improving extraction quality and reducing noise.

---

## Quick Start

### 1. Using Built-in Presets

Anno includes 5 optimized presets:

| Preset | Domain Pattern | Use Case |
|--------|----------------|----------|
| `default` | All domains | Generic web content |
| `news` | `*.news.*`, `*.nytimes.com`, etc. | News articles |
| `docs` | `*.readthedocs.io`, `docs.*` | Technical documentation |
| `ecommerce` | `*.amazon.*`, `*.ebay.*` | Product pages |
| `academic` | `*.arxiv.org`, `*.ieee.org` | Research papers |

Policies are **automatically selected** by domain matching.

### 2. Manual Policy Selection

Specify a policy hint in API requests:

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "options": {
      "policyHint": "news"
    }
  }'
```

---

## Policy File Format

### Basic Structure

```yaml
name: my-policy
version: 1.0.0
preset: default
domain: '*.example.com'  # Glob pattern (optional)

keep:
  - selector: 'article'
  - selector: '.main-content'

drop:
  - selector: '.ad'
  - selector: 'script'
  - regex: 'Advertisement'

fields:
  title:
    required: true
  main:
    required: true
    minLength: 50
```

### Fields

#### `name` (required)
Unique identifier for the policy.

```yaml
name: custom-news
```

#### `version` (optional)
Semantic version for tracking changes.

```yaml
version: 1.2.0
```

#### `preset` (optional)
Base preset to inherit from: `default`, `news`, `docs`, `ecommerce`, `academic`.

```yaml
preset: news
```

#### `domain` (optional)
Glob pattern for automatic domain matching. Use `|` for multiple patterns.

```yaml
domain: '*.example.com|*.example.org'
```

#### `keep` (optional)
Array of rules defining elements to **keep** (all others dropped).

```yaml
keep:
  - selector: 'article'
  - selector: '[role="main"]'
```

#### `drop` (optional)
Array of rules defining elements to **remove**.

```yaml
drop:
  - selector: '.ad'
  - selector: 'nav'
  - regex: 'Sponsored Content'
```

#### `fields` (optional)
Field validation requirements.

```yaml
fields:
  title:
    required: true
    minLength: 10
    maxLength: 200
  author:
    required: false
    pattern: '^[A-Za-z ]+$'
```

---

## Rule Types

### Selector Rules

Use CSS selectors to target elements:

```yaml
drop:
  - selector: '.advertisement'
  - selector: 'script'
  - selector: '[class*="ad-"]'
  - selector: 'div[id^="google-"]'
```

### Regex Rules

Match text content with regular expressions:

```yaml
drop:
  - regex: 'Advertisement'
  - regex: 'Subscribe to our newsletter'
  - regex: '^Sponsored by'
```

---

## Policy Selection Logic

1. **Explicit Hint:** If `policyHint` provided, use that policy
2. **Domain Match:** Check if URL matches any `domain` pattern
3. **Fallback:** Use `default` policy

### Domain Matching

Supports glob patterns:

| Pattern | Matches |
|---------|---------|
| `*.example.com` | `www.example.com`, `blog.example.com` |
| `example.*` | `example.com`, `example.org` |
| `*news*` | `news.example.com`, `example.news` |

---

## Examples

### News Policy

Optimized for article extraction:

```yaml
name: news
domain: '*.nytimes.com|*.washingtonpost.com'
preset: news

keep:
  - selector: 'article'
  - selector: '.article-content'
  - selector: '.byline'

drop:
  - selector: '.ad'
  - selector: '.comments'
  - selector: '.newsletter-signup'
  - regex: 'Sponsored Content'

fields:
  title:
    required: true
    minLength: 10
  author:
    required: true
  main:
    required: true
    minLength: 200
```

### Documentation Policy

Optimized for technical docs:

```yaml
name: docs
domain: '*.readthedocs.io|docs.*'
preset: docs

keep:
  - selector: 'main'
  - selector: '.content'
  - selector: 'pre'
  - selector: 'code'

drop:
  - selector: '.feedback-widget'
  - selector: 'footer'

fields:
  title:
    required: true
  main:
    required: true
    minLength: 100
```

### E-commerce Policy

Optimized for product pages:

```yaml
name: ecommerce
domain: '*.amazon.*|*.ebay.*'
preset: ecommerce

keep:
  - selector: '.product-details'
  - selector: '[itemprop="price"]'
  - selector: '[itemprop="description"]'

drop:
  - selector: '.recommendations'
  - selector: '.reviews'
  - regex: 'Customers also bought'

fields:
  title:
    required: true
  main:
    required: true
    minLength: 50
```

---

## Validation

### Schema Validation

Policies are validated on startup:

- `name` must be present
- Rules must have `selector` or `regex`
- Field requirements must be valid

### Runtime Validation

After extraction, policies validate:

- Required fields present
- Field lengths within bounds
- Field patterns match

Results included in response:

```json
{
  "policyMetadata": {
    "policyApplied": "news",
    "rulesMatched": 12,
    "fieldsValidated": true
  }
}
```

---

## Performance

### Impact

- **Selector-based rules:** ~5-10ms per request
- **Regex-based rules:** ~10-15ms per request
- **Combined:** ~10-20ms typical

### Optimization Tips

1. **Use selectors over regex** when possible (faster)
2. **Limit keep rules** to essential elements
3. **Combine similar selectors** into multi-selectors
4. **Test policies** on representative pages

---

## Troubleshooting

### Policy Not Applied

**Check:**
1. Policy file exists in `POLICY_DIR`
2. YAML syntax is valid
3. Domain pattern matches URL
4. `POLICY_ENABLED=true` in env

**Logs:**
```bash
grep "Policy applied" logs/anno.log
# Should show: policy=news, rulesMatched=12
```

### Low Rules Matched

**Possible causes:**
- Selectors don't match page structure
- Page uses different HTML structure
- Dynamic content not rendered

**Solution:**
- Inspect page HTML
- Update selectors
- Enable rendering mode

### Field Validation Fails

**Check:**
- Field requirements too strict
- Content length expectations realistic
- Pattern regex correct

**Response:**
```json
{
  "policyMetadata": {
    "fieldsValidated": false,
    "validationErrors": [
      "Required field 'author' is missing"
    ]
  }
}
```

---

## Advanced Usage

### Combining Policies

Layer policies for complex scenarios:

```yaml
# Base policy
name: base-news
keep:
  - selector: 'article'

# Derived policy
name: premium-news
preset: base-news
domain: '*.premium-news.com'
drop:
  - selector: '.paywall'
```

### Dynamic Policy Loading

Policies reload automatically on file changes (dev mode).

### Policy Fingerprinting

Track policy versions via fingerprint:

```bash
curl http://localhost:5213/health | jq '.policies.fingerprint'
# "a1b2c3d4"
```

Changes when policies modified.

---

## Best Practices

1. ✅ **Start with presets** - Modify rather than creating from scratch
2. ✅ **Test thoroughly** - Validate on 10+ representative pages
3. ✅ **Version policies** - Track changes with semantic versioning
4. ✅ **Document decisions** - Add comments explaining non-obvious rules
5. ✅ **Monitor metrics** - Track `rulesMatched` and `fieldsValidated`
6. ✅ **Keep simple** - Fewer rules = faster, more maintainable

---

## API Reference

### Policy Metadata in Response

```typescript
interface PolicyMetadata {
  policyApplied: string;      // Policy name used
  rulesMatched: number;        // Number of rules matched
  fieldsValidated: boolean;    // Whether field validation passed
}
```

### Policy Engine Status

```bash
GET /health
```

```json
{
  "policies": {
    "enabled": true,
    "count": 5,
    "fingerprint": "a1b2c3d4",
    "loaded": ["default", "news", "docs", "ecommerce", "academic"]
  }
}
```

---

## Resources

- **Policy Examples:** `/policies/*.yaml`
- **Schema:** `/policies/schema.json` (coming soon)
- **GitHub:** https://github.com/evo-nirvana/anno

---

**Last Updated:** 2025-10-06
**Version:** 0.2.0
