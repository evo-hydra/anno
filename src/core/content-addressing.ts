/**
 * Content Addressing System
 *
 * Implements IPFS-style content addressing for deterministic caching.
 * Identical content (semantically) should produce identical hashes.
 *
 * @module content-addressing
 */

import crypto from 'crypto';

/**
 * Metadata included in content hash computation
 */
export interface ContentMetadata {
  url: string;
  contentType?: string;
}

/**
 * Result of content hash generation
 */
export interface ContentHashResult {
  hash: string;              // Format: sha256:hexdigest
  canonical: string;         // Canonicalized content
  metadata: ContentMetadata; // Metadata used
  timestamp: number;         // When hash was generated
}

/**
 * Content Addressing System
 *
 * Provides deterministic content hashing for caching.
 */
export class ContentAddressing {

  /**
   * Canonicalize HTML content for deterministic hashing
   *
   * Rules:
   * 1. Remove HTML comments
   * 2. Normalize whitespace (multiple spaces/newlines → single space)
   * 3. Trim leading/trailing whitespace
   * 4. Lowercase all HTML tag names
   * 5. Remove empty attributes
   *
   * @param html - Raw HTML content
   * @returns Canonicalized HTML
   */
  static canonicalizeHTML(html: string): string {
    let canonical = html;

    // 1. Remove HTML comments (including conditional comments)
    canonical = canonical.replace(/<!--[\s\S]*?-->/g, '');

    // 2. Remove script tags and content (non-deterministic)
    // Replace with space to preserve word boundaries
    canonical = canonical.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');

    // 3. Remove style tags (CSS can vary without affecting content)
    // Replace with space to preserve word boundaries
    canonical = canonical.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

    // 4. Normalize whitespace
    // Replace multiple spaces/tabs/newlines with single space
    canonical = canonical.replace(/\s+/g, ' ');

    // 5. Trim leading/trailing whitespace
    canonical = canonical.trim();

    // 6. Remove whitespace at tag boundaries to stabilize hashes
    canonical = canonical.replace(/>\s+/g, '>');
    canonical = canonical.replace(/\s+>/g, '>');
    canonical = canonical.replace(/\s+</g, '<');

    // 7. Lowercase HTML tags (but preserve content case)
    // Match opening tags: <TAG ...>
    canonical = canonical.replace(/<([A-Z][A-Z0-9]*)\b/g, (match, tag) => `<${tag.toLowerCase()}`);
    // Match closing tags: </TAG>
    canonical = canonical.replace(/<\/([A-Z][A-Z0-9]*)\b/g, (match, tag) => `</${tag.toLowerCase()}`);

    // 8. Sort attributes alphabetically within tags (basic implementation)
    // This is a simplified version - full implementation would use DOM parser
    // For MVP, we'll skip this as it's complex and has diminishing returns

    return canonical;
  }

  /**
   * Generate SHA-256 content hash
   *
   * Hash includes:
   * - Canonicalized content
   * - URL (to differentiate same content from different sources)
   * - Content-Type (to differentiate HTML vs JSON)
   *
   * @param content - Raw content (HTML, JSON, etc.)
   * @param metadata - Content metadata
   * @returns Hash result with canonical content
   */
  static generateHash(content: string, metadata: ContentMetadata): ContentHashResult {
    // Canonicalize content
    const canonical = this.canonicalizeHTML(content);

    // Create stable metadata representation
    const metadataStr = JSON.stringify({
      url: metadata.url,
      contentType: metadata.contentType || 'text/html'
    });

    // Combine canonical content + metadata
    const combined = canonical + '\n---METADATA---\n' + metadataStr;

    // Generate SHA-256 hash
    const hashDigest = crypto
      .createHash('sha256')
      .update(combined, 'utf8')
      .digest('hex');

    const hash = `sha256:${hashDigest}`;

    return {
      hash,
      canonical,
      metadata,
      timestamp: Date.now()
    };
  }

  /**
   * Verify content hash
   *
   * Recomputes hash and checks if it matches expected hash.
   *
   * @param content - Content to verify
   * @param metadata - Content metadata
   * @param expectedHash - Expected hash (format: sha256:hex)
   * @returns True if hash matches
   */
  static verifyHash(
    content: string,
    metadata: ContentMetadata,
    expectedHash: string
  ): boolean {
    const result = this.generateHash(content, metadata);
    return result.hash === expectedHash;
  }

  /**
   * Extract hash digest from hash string
   *
   * @param hash - Hash string (format: sha256:hex)
   * @returns Hex digest or null if invalid format
   */
  static extractDigest(hash: string): string | null {
    const match = hash.match(/^sha256:([a-f0-9]{64})$/);
    return match ? match[1] : null;
  }

  /**
   * Check if hash format is valid
   *
   * @param hash - Hash string to validate
   * @returns True if valid format
   */
  static isValidHash(hash: string): boolean {
    return /^sha256:[a-f0-9]{64}$/.test(hash);
  }

  /**
   * Generate cache key from URL and mode
   *
   * @param url - URL of the content
   * @param mode - Fetch mode (http | rendered)
   * @returns Cache key string
   */
  static generateCacheKey(url: string, mode: 'http' | 'rendered'): string {
    // For now, use URL + mode
    // Later we'll use content hash as cache key
    return `fetch:${mode}:${url}`;
  }

  /**
   * Compare two content hashes
   *
   * @param hash1 - First hash
   * @param hash2 - Second hash
   * @returns True if hashes are identical
   */
  static compareHashes(hash1: string, hash2: string): boolean {
    return hash1 === hash2;
  }
}
