/**
 * Provenance Verification Utility
 *
 * Verifies that source spans accurately point to content in the original HTML.
 * Re-derives byte offsets and validates content hashes.
 *
 * @module utils/provenance-verify
 */

import { createHash } from 'crypto';
import type { SourceSpan } from '../services/distiller';

export interface VerificationResult {
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

/**
 * Verify a single source span against original HTML
 */
export const verifySourceSpan = (
  span: SourceSpan,
  originalHtml: string
): { valid: boolean; error?: string } => {
  // Validate byte offsets
  if (span.byteStart < 0 || span.byteEnd < 0) {
    return { valid: false, error: 'Negative byte offsets' };
  }

  if (span.byteStart > originalHtml.length || span.byteEnd > originalHtml.length) {
    return { valid: false, error: 'Byte offsets exceed HTML length' };
  }

  if (span.byteStart >= span.byteEnd) {
    return { valid: false, error: 'Invalid byte range (start >= end)' };
  }

  // Extract text at the specified byte range
  const extractedText = originalHtml.substring(span.byteStart, span.byteEnd);

  if (!extractedText) {
    return { valid: false, error: 'Extracted text is empty' };
  }

  return { valid: true };
};

/**
 * Verify all source spans in a set of distilled nodes
 */
export const verifyProvenance = (
  originalHtml: string,
  sourceSpans: SourceSpan[]
): VerificationResult => {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Compute expected content hash
  const computedHash = createHash('sha256').update(originalHtml, 'utf-8').digest('hex');

  // Check if any span has a content hash
  const firstSpan = sourceSpans[0];
  const contentHashMatch = firstSpan ? computedHash === firstSpan.contentHash : false;

  if (!contentHashMatch && firstSpan) {
    errors.push(
      `Content hash mismatch: expected ${computedHash.slice(0, 8)}..., got ${firstSpan.contentHash.slice(0, 8)}...`
    );
  }

  // Verify each span
  let byteOffsetsValid = 0;
  let byteOffsetsInvalid = 0;

  for (const span of sourceSpans) {
    const result = verifySourceSpan(span, originalHtml);

    if (result.valid) {
      byteOffsetsValid++;
    } else {
      byteOffsetsInvalid++;
      errors.push(`Span ${span.url} [${span.byteStart}-${span.byteEnd}]: ${result.error}`);
    }
  }

  // Overall validation
  const valid = errors.length === 0 && contentHashMatch;

  if (!valid && errors.length === 0) {
    warnings.push('Provenance data present but content hash could not be verified');
  }

  return {
    valid,
    errors,
    warnings,
    details: {
      contentHashMatch,
      byteOffsetsValid,
      byteOffsetsInvalid,
      totalSpans: sourceSpans.length
    }
  };
};

/**
 * Extract text from HTML using source span
 */
export const extractTextFromSpan = (span: SourceSpan, originalHtml: string): string | null => {
  try {
    const result = verifySourceSpan(span, originalHtml);
    if (!result.valid) {
      return null;
    }

    return originalHtml.substring(span.byteStart, span.byteEnd);
  } catch (error) {
    return null;
  }
};

/**
 * Re-compute byte offsets for a text fragment
 */
export const computeByteOffsets = (
  text: string,
  originalHtml: string
): { byteStart: number; byteEnd: number } | null => {
  const index = originalHtml.indexOf(text);

  if (index === -1) {
    return null;
  }

  return {
    byteStart: index,
    byteEnd: index + text.length
  };
};
