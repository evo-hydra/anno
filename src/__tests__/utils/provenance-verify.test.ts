import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  verifySourceSpan,
  verifyProvenance,
  extractTextFromSpan,
  computeByteOffsets
} from '../../utils/provenance-verify';

describe('verifySourceSpan', () => {
  const originalHtml = '<html><body>Hello World</body></html>';

  it('validates a valid span', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 10,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('rejects negative byteStart', () => {
    const span = {
      url: 'https://example.com',
      byteStart: -5,
      byteEnd: 10,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Negative byte offsets');
  });

  it('rejects negative byteEnd', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: -5,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Negative byte offsets');
  });

  it('rejects byteStart beyond HTML length', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 1000,
      byteEnd: 1010,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Byte offsets exceed HTML length');
  });

  it('rejects byteEnd beyond HTML length', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 1000,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Byte offsets exceed HTML length');
  });

  it('rejects when byteStart equals byteEnd', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 5,
      byteEnd: 5,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid byte range (start >= end)');
  });

  it('rejects when byteStart is greater than byteEnd', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 15,
      byteEnd: 10,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid byte range (start >= end)');
  });

  it('does not reject whitespace text', () => {
    const htmlWithWhitespace = '     ';
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 5,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, htmlWithWhitespace);

    // Whitespace is not empty, so it should be valid
    expect(result.valid).toBe(true);
  });

  it('validates span at end of HTML', () => {
    const span = {
      url: 'https://example.com',
      byteStart: originalHtml.length - 5,
      byteEnd: originalHtml.length,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(true);
  });

  it('validates span at start of HTML', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 5,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(true);
  });

  it('rejects when byteStart is exactly at HTML length', () => {
    const span = {
      url: 'https://example.com',
      byteStart: originalHtml.length,
      byteEnd: originalHtml.length + 1,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, originalHtml);

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Byte offsets exceed HTML length');
  });

  it('handles empty HTML string', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 1,
      contentHash: 'hash123'
    };

    const result = verifySourceSpan(span, '');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Byte offsets exceed HTML length');
  });
});

describe('verifyProvenance', () => {
  const originalHtml = '<html><body>Test content</body></html>';

  it('validates provenance with valid spans and matching hash', () => {
    const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 10,
        contentHash: computedHash
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.details.contentHashMatch).toBe(true);
    expect(result.details.byteOffsetsValid).toBe(1);
    expect(result.details.byteOffsetsInvalid).toBe(0);
    expect(result.details.totalSpans).toBe(1);
  });

  it('fails when content hash does not match', () => {
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 10,
        contentHash: 'different-hash-does-not-match'
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Content hash mismatch');
    expect(result.details.contentHashMatch).toBe(false);
  });

  it('validates multiple valid spans', () => {
    const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 10,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: 10,
        byteEnd: 20,
        contentHash: computedHash
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    expect(result.valid).toBe(true);
    expect(result.details.byteOffsetsValid).toBe(2);
    expect(result.details.byteOffsetsInvalid).toBe(0);
    expect(result.details.totalSpans).toBe(2);
  });

  it('reports invalid spans in details', () => {
    const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 10,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: -5,
        byteEnd: 5,
        contentHash: computedHash
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    expect(result.valid).toBe(false);
    expect(result.details.byteOffsetsValid).toBe(1);
    expect(result.details.byteOffsetsInvalid).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('only checks first span contentHash', () => {
    const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 10,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: 10,
        byteEnd: 20,
        contentHash: 'wrong-hash-but-not-checked'
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    // Only first span's hash is checked, so this should pass
    expect(result.valid).toBe(true);
    expect(result.details.contentHashMatch).toBe(true);
  });

  it('handles empty sourceSpans array', () => {
    const result = verifyProvenance(originalHtml, []);

    expect(result.details.totalSpans).toBe(0);
    expect(result.details.byteOffsetsValid).toBe(0);
    expect(result.details.byteOffsetsInvalid).toBe(0);
    expect(result.details.contentHashMatch).toBe(false);
  });

  it('counts valid and invalid spans separately', () => {
    const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 5,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: -1,
        byteEnd: 5,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: 5,
        byteEnd: 10,
        contentHash: computedHash
      },
      {
        url: 'https://example.com',
        byteStart: 10,
        byteEnd: 9,
        contentHash: computedHash
      }
    ];

    const result = verifyProvenance(originalHtml, sourceSpans);

    expect(result.details.byteOffsetsValid).toBe(2);
    expect(result.details.byteOffsetsInvalid).toBe(2);
    expect(result.details.totalSpans).toBe(4);
  });

  it('handles empty HTML string', () => {
    const sourceSpans = [
      {
        url: 'https://example.com',
        byteStart: 0,
        byteEnd: 1,
        contentHash: 'some-hash'
      }
    ];

    const result = verifyProvenance('', sourceSpans);

    expect(result.valid).toBe(false);
    expect(result.details.byteOffsetsInvalid).toBe(1);
  });
});

describe('extractTextFromSpan', () => {
  const originalHtml = '<html><body>Hello World</body></html>';

  it('extracts text from valid span', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 12,
      byteEnd: 17,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBe('Hello');
  });

  it('returns null for invalid span with negative offset', () => {
    const span = {
      url: 'https://example.com',
      byteStart: -5,
      byteEnd: 10,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBeNull();
  });

  it('returns null for span beyond HTML length', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 1000,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBeNull();
  });

  it('returns null for span with start >= end', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 10,
      byteEnd: 5,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBeNull();
  });

  it('extracts full HTML when span covers entire content', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: originalHtml.length,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBe(originalHtml);
  });

  it('extracts single character', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 1,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBe('<');
  });

  it('handles span at end of HTML', () => {
    const span = {
      url: 'https://example.com',
      byteStart: originalHtml.length - 7,
      byteEnd: originalHtml.length,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBe('</html>');
  });

  it('returns null for empty extraction range', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 5,
      byteEnd: 5,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, originalHtml);

    expect(text).toBeNull();
  });

  it('handles empty HTML string', () => {
    const span = {
      url: 'https://example.com',
      byteStart: 0,
      byteEnd: 1,
      contentHash: 'hash123'
    };

    const text = extractTextFromSpan(span, '');

    expect(text).toBeNull();
  });
});

describe('computeByteOffsets', () => {
  const originalHtml = '<html><body>Hello World</body></html>';

  it('finds text at beginning of HTML', () => {
    const offsets = computeByteOffsets('<html>', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(0);
    expect(offsets?.byteEnd).toBe(6);
  });

  it('finds text in middle of HTML', () => {
    const offsets = computeByteOffsets('Hello', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(12);
    expect(offsets?.byteEnd).toBe(17);
  });

  it('finds text at end of HTML', () => {
    const offsets = computeByteOffsets('</html>', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(30);
    expect(offsets?.byteEnd).toBe(37);
  });

  it('returns null for text not found', () => {
    const offsets = computeByteOffsets('Not Found', originalHtml);

    expect(offsets).toBeNull();
  });

  it('returns offsets for empty search text', () => {
    const offsets = computeByteOffsets('', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(0);
    expect(offsets?.byteEnd).toBe(0);
  });

  it('finds single character', () => {
    const offsets = computeByteOffsets('H', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(12);
    expect(offsets?.byteEnd).toBe(13);
  });

  it('finds entire HTML string', () => {
    const offsets = computeByteOffsets(originalHtml, originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(0);
    expect(offsets?.byteEnd).toBe(originalHtml.length);
  });

  it('finds first occurrence when text appears multiple times', () => {
    const html = '<div>test</div><div>test</div>';
    const offsets = computeByteOffsets('test', html);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(5);
    expect(offsets?.byteEnd).toBe(9);
  });

  it('handles special characters in search text', () => {
    const html = '<div class="special">Content</div>';
    const offsets = computeByteOffsets('class="special"', html);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(5);
    expect(offsets?.byteEnd).toBe(20);
  });

  it('returns null when searching in empty HTML', () => {
    const offsets = computeByteOffsets('test', '');

    expect(offsets).toBeNull();
  });

  it('finds whitespace text', () => {
    const offsets = computeByteOffsets(' ', originalHtml);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBeGreaterThanOrEqual(0);
    expect(offsets?.byteEnd).toBe(offsets!.byteStart + 1);
  });

  it('handles case-sensitive search', () => {
    const offsets = computeByteOffsets('hello', originalHtml);

    // 'hello' with lowercase 'h' should not be found in 'Hello'
    expect(offsets).toBeNull();
  });

  it('finds exact match with correct byte positions', () => {
    const html = '0123456789';
    const offsets = computeByteOffsets('345', html);

    expect(offsets).not.toBeNull();
    expect(offsets?.byteStart).toBe(3);
    expect(offsets?.byteEnd).toBe(6);
  });
});
