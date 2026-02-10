# Provenance & Source-Span Tracking

## Overview

Anno v0.2.0 introduces **cryptographically traceable provenance** for all extracted content. Every piece of text includes metadata proving its origin and enabling verification.

---

## Core Concepts

### Source Span

A **source span** traces extracted text back to the original HTML:

```typescript
interface SourceSpan {
  url: string;           // Source URL
  timestamp: number;     // Fetch timestamp (Unix ms)
  contentHash: string;   // SHA-256 of original HTML
  byteStart: number;     // Byte offset in HTML (start)
  byteEnd: number;       // Byte offset in HTML (end)
  selector?: string;     // CSS selector path (optional)
}
```

### Content Hash

SHA-256 hash of the **original HTML** before any processing:

```typescript
contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

Enables:
- ✅ **Tampering detection** - Verify HTML unchanged
- ✅ **Deduplication** - Identify identical content
- ✅ **Caching** - Cache key for deterministic retrieval

---

## Response Format

Every distillation includes provenance:

```json
{
  "title": "Example Article",
  "contentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "nodes": [
    {
      "id": "node-0",
      "order": 0,
      "type": "paragraph",
      "text": "This is the article content...",
      "sourceSpans": [
        {
          "url": "https://example.com/article",
          "timestamp": 1733512800000,
          "contentHash": "e3b0c44...",
          "byteStart": 1234,
          "byteEnd": 1289
        }
      ]
    }
  ]
}
```

### Multiple Spans

Nodes may have multiple spans if text comes from different locations:

```json
{
  "text": "Content from header and footer",
  "sourceSpans": [
    { "byteStart": 100, "byteEnd": 125 },  // Header
    { "byteStart": 5000, "byteEnd": 5025 } // Footer
  ]
}
```

---

## Verification

### Programmatic Verification

Use the built-in verification utility:

```typescript
import { verifyProvenance, verifySourceSpan } from './src/utils/provenance-verify';

// Verify all spans in a result
const result = verifyProvenance(
  originalHtml,
  distillationResult.nodes.flatMap(n => n.sourceSpans || [])
);

console.log(result.valid);              // true/false
console.log(result.details.contentHashMatch);  // Hash verification
console.log(result.details.byteOffsetsValid);  // Valid offsets count
console.log(result.errors);             // Detailed errors
```

### Manual Verification

Extract text using byte offsets:

```typescript
import { extractTextFromSpan } from './src/utils/provenance-verify';

const span = node.sourceSpans[0];
const extractedText = extractTextFromSpan(span, originalHtml);

console.log(extractedText === node.text);  // Should be true
```

### Content Hash Verification

Recompute hash and compare:

```typescript
import { createHash } from 'crypto';

const computedHash = createHash('sha256')
  .update(originalHtml, 'utf-8')
  .digest('hex');

console.log(computedHash === distillationResult.contentHash);  // true
```

---

## Use Cases

### 1. Audit Trails

Track content modifications over time:

```typescript
const auditLog = {
  fetchedAt: span.timestamp,
  source: span.url,
  contentHash: span.contentHash,
  extractedText: node.text,
  verified: verifySourceSpan(span, originalHtml).valid
};
```

### 2. Legal Compliance

Prove content origin for copyright/attribution:

```typescript
// Generate citation
const citation = {
  source: span.url,
  retrieved: new Date(span.timestamp).toISOString(),
  contentFingerprint: span.contentHash.slice(0, 16),
  byteRange: `${span.byteStart}-${span.byteEnd}`
};
```

### 3. Content Integrity

Detect tampering or modifications:

```typescript
if (!result.details.contentHashMatch) {
  console.warn('Content has been modified since extraction');
}
```

### 4. Debugging Extractions

Locate extracted text in source HTML:

```typescript
const snippet = originalHtml.substring(
  span.byteStart - 50,  // 50 chars before
  span.byteEnd + 50     // 50 chars after
);

console.log('Context:', snippet);
```

---

## Performance Impact

### Overhead

- **Hash computation:** ~2-5ms per request
- **Byte offset calculation:** ~1-3ms per node
- **Total:** ~5-10ms for typical article (10-20 nodes)

### Optimization

Provenance is computed **once** during distillation:

1. ✅ Hash original HTML (single SHA-256)
2. ✅ Compute byte offsets during node creation
3. ✅ No additional network requests

---

## Limitations

### Byte Offset Accuracy

**Scenarios where byte offsets may be approximate:**

1. **Text normalization** - Whitespace collapsed
2. **Extracted from multiple locations** - Multiple spans
3. **Transformed content** - Policies applied before extraction

**Mitigation:**
- Verify using `verifySourceSpan()`
- Check `result.valid` before trusting offsets

### Content Hash Scope

Hash covers **original HTML only**, not:
- ❌ Rendered DOM (after JavaScript execution)
- ❌ Policy-transformed HTML
- ❌ Extracted text

**For policy-transformed content:**
```typescript
// Hash is of ORIGINAL HTML, before policy processing
const originalHash = distillationResult.contentHash;

// To verify policy-transformed HTML:
const policyHash = createHash('sha256').update(transformedHtml).digest('hex');
```

---

## Security Considerations

### Preventing Forgery

1. **Content hash is cryptographically secure** (SHA-256)
2. **Byte offsets can be independently verified**
3. **Timestamps are server-controlled**

### Privacy

**No sensitive data in provenance:**
- ✅ URLs are public
- ✅ Hashes are one-way
- ✅ Byte offsets reveal no content

**For private URLs:**
```typescript
// Redact sensitive URLs in logs
const redactedUrl = span.url.replace(/api_key=.+/, 'api_key=[REDACTED]');
```

---

## Advanced Usage

### Custom Span Creation

Create spans for custom content:

```typescript
import { computeByteOffsets } from './src/utils/provenance-verify';

const offsets = computeByteOffsets(extractedText, originalHtml);

const customSpan: SourceSpan = {
  url: sourceUrl,
  timestamp: Date.now(),
  contentHash: computedHash,
  byteStart: offsets.byteStart,
  byteEnd: offsets.byteEnd,
  selector: '.custom-element'  // Optional
};
```

### Batch Verification

Verify large sets efficiently:

```typescript
const allSpans = results.flatMap(r =>
  r.nodes.flatMap(n => n.sourceSpans || [])
);

const batchResult = verifyProvenance(originalHtml, allSpans);

console.log(`${batchResult.details.byteOffsetsValid}/${allSpans.length} valid`);
```

### Provenance Chains

Link multiple extractions:

```typescript
const chain = {
  original: {
    url: span.url,
    hash: span.contentHash,
    timestamp: span.timestamp
  },
  distilled: {
    method: result.extractionMethod,
    confidence: result.extractionConfidence,
    policyApplied: result.policyMetadata?.policyApplied
  },
  verified: verifyProvenance(html, spans).valid
};
```

---

## Metrics

Track provenance coverage:

### Prometheus Metrics

```promql
# Percentage of nodes with provenance
anno_provenance_coverage_ratio

# Provenance verification failures
anno_provenance_verification_failures_total
```

### Health Check

```bash
GET /health
```

```json
{
  "provenance": {
    "enabled": true,
    "hashAlgorithm": "sha256",
    "avgSpansPerNode": 1.2,
    "verificationSuccessRate": 0.98
  }
}
```

---

## Troubleshooting

### Missing Source Spans

**Possible causes:**
1. Fallback extraction used (no provenance)
2. Node created before v0.2.0
3. Policy dropped content

**Check:**
```typescript
if (!node.sourceSpans || node.sourceSpans.length === 0) {
  console.warn('No provenance for node:', node.id);
}
```

### Verification Failures

**Common issues:**

1. **Hash mismatch:**
   - HTML modified since extraction
   - Different encoding (UTF-8 vs. other)

2. **Invalid byte offsets:**
   - Text transformed during extraction
   - Whitespace normalization

3. **Negative offsets:**
   - Text not found in HTML
   - Policy removed original location

**Debug:**
```typescript
const result = verifySourceSpan(span, html);
if (!result.valid) {
  console.error('Verification failed:', result.error);
}
```

---

## Best Practices

1. ✅ **Always include contentHash** in API responses
2. ✅ **Verify provenance** for critical use cases (legal, compliance)
3. ✅ **Store original HTML** if verification needed later
4. ✅ **Log verification failures** for debugging
5. ✅ **Redact sensitive URLs** in logs
6. ✅ **Monitor provenance coverage** metrics

---

## API Reference

### Verification Result

```typescript
interface VerificationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  details: {
    contentHashMatch: boolean;
    byteOffsetsValid: number;
    byteOffsetsInvalid: number;
    totalSpans: number;
  };
}
```

### Utility Functions

```typescript
// Verify all spans
verifyProvenance(html: string, spans: SourceSpan[]): VerificationResult

// Verify single span
verifySourceSpan(span: SourceSpan, html: string): { valid: boolean; error?: string }

// Extract text from span
extractTextFromSpan(span: SourceSpan, html: string): string | null

// Compute byte offsets
computeByteOffsets(text: string, html: string): { byteStart: number; byteEnd: number } | null
```

---

## Resources

- **Source Code:** `src/utils/provenance-verify.ts`
- **Types:** `src/services/distiller.ts` (SourceSpan interface)
- **Tests:** `src/__tests__/provenance.test.ts` (coming soon)

---

**Last Updated:** 2025-10-06
**Version:** 0.2.0
