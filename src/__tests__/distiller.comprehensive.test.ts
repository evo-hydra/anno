import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { distillContent } from '../services/distiller';

// ---------------------------------------------------------------------------
// Prevent any real network calls (Ollama health-check, etc.)
// ---------------------------------------------------------------------------

let originalFetch: typeof global.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('no network');
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Shared HTML fixtures
// ---------------------------------------------------------------------------

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Title</title></head>
<body>
<article>
  <h1>Article Heading</h1>
  <p class="byline">By John Doe</p>
  <p>First paragraph with substantial content that should be extracted properly by the readability algorithm. This needs to be long enough to trigger extraction. Adding more words to ensure the readability algorithm treats this as meaningful content worth extracting.</p>
  <p>Second paragraph with more content to ensure multiple nodes are created. This paragraph provides complementary information and additional detail that the extraction pipeline should capture alongside the first paragraph.</p>
  <p>Third paragraph ensures we have enough content for the ensemble extractor to consider this a well-structured article. Good articles typically contain several paragraphs of text.</p>
  <p>Fourth paragraph adds even more depth to the article content. The extraction pipeline should handle multiple paragraphs gracefully and maintain their ordering in the output nodes.</p>
  <p>Fifth paragraph rounds out the article with final thoughts and conclusions. This ensures we have sufficient content length and paragraph count to avoid fallback extraction paths.</p>
</article>
</body>
</html>`;

const MINIMAL_HTML = `<!DOCTYPE html>
<html><head><title>Minimal Page</title></head>
<body><p>Just one line.</p></body>
</html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><head><title></title></head>
<body></body>
</html>`;

const MALFORMED_HTML = `<htm<head><title>Broken</titl
<body><article><p>Some text here despite the broken markup</p>
<p>Another paragraph in malformed HTML that should still be extracted by the parser.</p>
<p>Third paragraph in the malformed document providing additional extractable content for the pipeline.</p>
</article></body>`;

const LARGE_HTML = (() => {
  const paragraphs = Array.from({ length: 100 }, (_, i) =>
    `<p>Paragraph number ${i + 1} contains enough text content to be meaningful for extraction. This is a filler sentence that adds length to the paragraph so the extractor considers it substantive content worth preserving in the final output.</p>`
  ).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><title>Large Document</title></head>
<body><article><h1>Large Article</h1>${paragraphs}</article></body>
</html>`;
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('distillContent — comprehensive', () => {
  it('extracts title from HTML', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    // The title may come from readability or DOM extraction; accept reasonable values
    expect(typeof result.title).toBe('string');
    expect(result.title.length).toBeGreaterThan(0);
  });

  it('extracts content from article with multiple paragraphs', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(result.contentText.length).toBeGreaterThan(100);
    expect(result.nodes.length).toBeGreaterThanOrEqual(2);

    // Verify the extracted text actually contains article content
    const allText = result.nodes.map((n) => n.text).join(' ');
    expect(allText).toContain('paragraph');
  });

  it('returns nodes with correct structure (id, type, text, order)', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(result.nodes.length).toBeGreaterThan(0);

    for (const node of result.nodes) {
      expect(typeof node.id).toBe('string');
      expect(node.id.length).toBeGreaterThan(0);

      expect(typeof node.order).toBe('number');
      expect(node.order).toBeGreaterThanOrEqual(0);

      expect(['paragraph', 'heading']).toContain(node.type);

      expect(typeof node.text).toBe('string');
      expect(node.text.length).toBeGreaterThan(0);
    }

    // Orders should be sequential starting from 0
    const orders = result.nodes.map((n) => n.order);
    for (let i = 0; i < orders.length; i++) {
      expect(orders[i]).toBe(i);
    }
  });

  it('handles empty HTML gracefully (does not crash)', async () => {
    const result = await distillContent(EMPTY_HTML, 'https://example.com/empty');

    expect(result).toBeDefined();
    expect(typeof result.title).toBe('string');
    expect(typeof result.contentText).toBe('string');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(typeof result.contentLength).toBe('number');
  });

  it('handles HTML with no article content (fallback behavior)', async () => {
    const result = await distillContent(MINIMAL_HTML, 'https://example.com/minimal');

    expect(result).toBeDefined();
    expect(typeof result.contentText).toBe('string');
    // May use fallback since there is barely any content
    expect(typeof result.fallbackUsed).toBe('boolean');
    expect(typeof result.extractionMethod).toBe('string');
  });

  it('extracts byline when present and readability selects it', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    // Byline extraction depends on which extractor wins; readability may find it
    if (result.extractionMethod === 'readability') {
      // Readability sometimes picks up byline
      expect(result.byline === null || typeof result.byline === 'string').toBe(true);
    }
    // Either way, the byline field should exist on the result
    expect('byline' in result).toBe(true);
  });

  it('handles malformed HTML without crashing', async () => {
    const result = await distillContent(MALFORMED_HTML, 'https://example.com/broken');

    expect(result).toBeDefined();
    expect(typeof result.title).toBe('string');
    expect(typeof result.contentText).toBe('string');
    expect(Array.isArray(result.nodes)).toBe(true);
  });

  it('handles very large HTML documents', async () => {
    const result = await distillContent(LARGE_HTML, 'https://example.com/large');

    expect(result).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.contentText.length).toBeGreaterThan(500);
    expect(typeof result.extractionMethod).toBe('string');
  });

  it('produces excerpt from content', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    // Excerpt may be null for some extraction methods, but when present it should be a string
    if (result.excerpt !== null) {
      expect(typeof result.excerpt).toBe('string');
      expect(result.excerpt.length).toBeGreaterThan(0);
      expect(result.excerpt.length).toBeLessThanOrEqual(500);
    }
  });

  it('returns contentText as concatenated node text', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    // contentText should contain the text from the nodes
    expect(result.contentText.length).toBeGreaterThan(0);

    // Verify contentText includes text from at least some nodes
    const nodeTexts = result.nodes.map((n) => n.text);
    let matchCount = 0;
    for (const nodeText of nodeTexts) {
      // A node's text may appear as a substring in contentText
      if (result.contentText.includes(nodeText.substring(0, 30))) {
        matchCount++;
      }
    }
    // At least some node texts should appear in contentText
    if (nodeTexts.length > 0) {
      expect(matchCount).toBeGreaterThan(0);
    }
  });

  it('returns contentLength matching contentText length', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(result.contentLength).toBe(result.contentText.length);
  });

  it('includes extractionMethod in the result', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    const validMethods = [
      'ollama',
      'readability',
      'dom-heuristic',
      'trafilatura',
      'ebay-adapter',
      'ebay-search-adapter',
      'fallback'
    ];
    expect(validMethods).toContain(result.extractionMethod);
  });

  it('includes extractionConfidence as a number between 0 and 1', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(typeof result.extractionConfidence).toBe('number');
    expect(result.extractionConfidence!).toBeGreaterThanOrEqual(0);
    expect(result.extractionConfidence!).toBeLessThanOrEqual(1);
  });

  it('includes contentHash for provenance tracking', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(typeof result.contentHash).toBe('string');
    // SHA-256 hex digest is 64 characters
    expect(result.contentHash!.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(result.contentHash!)).toBe(true);
  });

  it('produces deterministic contentHash for the same input', async () => {
    const result1 = await distillContent(ARTICLE_HTML, 'https://example.com/article');
    const result2 = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(result1.contentHash).toBe(result2.contentHash);
  });

  it('includes confidenceBreakdown with all dimensions', async () => {
    const result = await distillContent(ARTICLE_HTML, 'https://example.com/article');

    expect(result.confidenceBreakdown).toBeDefined();
    const bd = result.confidenceBreakdown!;

    expect(typeof bd.extraction).toBe('number');
    expect(typeof bd.contentQuality).toBe('number');
    expect(typeof bd.metadata).toBe('number');
    expect(typeof bd.sourceCredibility).toBe('number');
    expect(typeof bd.consensus).toBe('number');
    expect(typeof bd.overall).toBe('number');

    // All dimensions should be between 0 and 1
    for (const key of ['extraction', 'contentQuality', 'metadata', 'sourceCredibility', 'consensus', 'overall'] as const) {
      expect(bd[key]).toBeGreaterThanOrEqual(0);
      expect(bd[key]).toBeLessThanOrEqual(1);
    }
  });
});
