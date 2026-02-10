/**
 * Tests for Content Addressing System
 *
 * @module content-addressing.test
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ContentAddressing, type ContentMetadata } from '../core/content-addressing';

const fixtureDir = path.join(process.cwd(), 'src', '__tests__', '__fixtures__');

describe('ContentAddressing', () => {

  describe('canonicalizeHTML', () => {

    it('should remove HTML comments', () => {
      const html = '<div><!-- comment -->Hello</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello</div>');
    });

    it('should remove conditional comments', () => {
      const html = '<div><!--[if IE]>IE only<![endif]-->Hello</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello</div>');
    });

    it('should normalize multiple spaces to single space', () => {
      const html = '<div>Hello    World</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello World</div>');
    });

    it('should normalize newlines to single space', () => {
      const html = '<div>Hello\n\n\nWorld</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello World</div>');
    });

    it('should trim leading and trailing whitespace', () => {
      const html = '  \n  <div>Hello</div>  \n  ';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello</div>');
    });

    it('should lowercase HTML tags', () => {
      const html = '<DIV><SPAN>Hello</SPAN></DIV>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div><span>Hello</span></div>');
    });

    it('should preserve content case', () => {
      const html = '<div>HELLO World</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>HELLO World</div>');
    });

    it('should remove script tags', () => {
      const html = '<div>Hello<script>alert("test")</script>World</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello World</div>');
    });

    it('should remove style tags', () => {
      const html = '<div>Hello<style>.test{color:red;}</style>World</div>';
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical).toBe('<div>Hello World</div>');
    });

    it('should handle complex HTML', () => {
      const html = `
        <!-- Comment -->
        <DIV class="test">
          <P>
            Hello   World
          </P>
          <SCRIPT>console.log('test')</SCRIPT>
        </DIV>
      `;
      const canonical = ContentAddressing.canonicalizeHTML(html);
      expect(canonical.includes('<div')).toBe(true);
      expect(canonical.includes('<p>')).toBe(true);
      expect(canonical.includes('<!--')).toBe(false);
      expect(canonical.includes('<SCRIPT')).toBe(false);
      expect(canonical.includes('  ')).toBe(false); // No double spaces
    });

  });

  describe('generateHash', () => {

    it('should generate valid SHA-256 hash', () => {
      const content = '<div>Hello World</div>';
      const metadata: ContentMetadata = {
        url: 'https://example.com/test',
        contentType: 'text/html'
      };

      const result = ContentAddressing.generateHash(content, metadata);

      expect(result.hash.startsWith('sha256:')).toBe(true);
      expect(result.hash.length).toBe(71); // "sha256:" + 64 hex chars
      expect(ContentAddressing.isValidHash(result.hash)).toBe(true);
    });

    it('should include canonical content in result', () => {
      const content = '<DIV>  Hello  </DIV>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result = ContentAddressing.generateHash(content, metadata);

      expect(result.canonical).toBe('<div>Hello</div>');
    });

    it('should include metadata in result', () => {
      const content = '<div>Hello</div>';
      const metadata: ContentMetadata = {
        url: 'https://example.com',
        contentType: 'text/html'
      };

      const result = ContentAddressing.generateHash(content, metadata);

      expect(result.metadata.url).toBe(metadata.url);
      expect(result.metadata.contentType).toBe(metadata.contentType);
    });

    it('should include timestamp in result', () => {
      const content = '<div>Hello</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const before = Date.now();
      const result = ContentAddressing.generateHash(content, metadata);
      const after = Date.now();

      expect(result.timestamp >= before).toBe(true);
      expect(result.timestamp <= after).toBe(true);
    });

    it('should produce same hash for semantically identical content', () => {
      const content1 = '<DIV>  Hello  World  </DIV>';
      const content2 = '<div> Hello World </div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result1 = ContentAddressing.generateHash(content1, metadata);
      const result2 = ContentAddressing.generateHash(content2, metadata);

      // Both should canonicalize to the same thing
      expect(result1.canonical).toBe(result2.canonical);
      expect(result1.hash).toBe(result2.hash);
    });

    it('should produce same hash regardless of whitespace differences', () => {
      const content1 = '<div>\n  Hello\n  World\n</div>';
      const content2 = '<div>Hello World</div>';
      const content3 = '<div>  Hello    World  </div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const hash1 = ContentAddressing.generateHash(content1, metadata).hash;
      const hash2 = ContentAddressing.generateHash(content2, metadata).hash;
      const hash3 = ContentAddressing.generateHash(content3, metadata).hash;

      expect(hash1).toBe(hash2);
      expect(hash2).toBe(hash3);
    });

    it('should produce different hash for different content', () => {
      const content1 = '<div>Hello</div>';
      const content2 = '<div>World</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result1 = ContentAddressing.generateHash(content1, metadata);
      const result2 = ContentAddressing.generateHash(content2, metadata);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should produce different hash for different URLs', () => {
      const content = '<div>Hello</div>';
      const metadata1: ContentMetadata = { url: 'https://example.com/page1' };
      const metadata2: ContentMetadata = { url: 'https://example.com/page2' };

      const result1 = ContentAddressing.generateHash(content, metadata1);
      const result2 = ContentAddressing.generateHash(content, metadata2);

      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should normalize attribute whitespace consistently', () => {
      const messy = fs.readFileSync(path.join(fixtureDir, 'attribute-whitespace-messy.html'), 'utf8');
      const clean = fs.readFileSync(path.join(fixtureDir, 'attribute-whitespace-clean.html'), 'utf8');

      const metadata: ContentMetadata = { url: 'https://example.com/attrs' };

      const resultMessy = ContentAddressing.generateHash(messy, metadata);
      const resultClean = ContentAddressing.generateHash(clean, metadata);

      expect(resultMessy.canonical).toBe(resultClean.canonical);
      expect(resultMessy.hash).toBe(resultClean.hash);
    });

    it('should treat nested lists with irregular spacing identically', () => {
      const nestedA = fs.readFileSync(path.join(fixtureDir, 'nested-lists-a.html'), 'utf8');
      const nestedB = fs.readFileSync(path.join(fixtureDir, 'nested-lists-b.html'), 'utf8');

      const metadata: ContentMetadata = { url: 'https://example.com/lists' };

      const resultA = ContentAddressing.generateHash(nestedA, metadata);
      const resultB = ContentAddressing.generateHash(nestedB, metadata);

      expect(resultA.canonical).toBe(resultB.canonical);
      expect(resultA.hash).toBe(resultB.hash);
    });

    it('should default contentType to text/html', () => {
      const content = '<div>Hello</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result = ContentAddressing.generateHash(content, metadata);

      // Hash should be same as if we explicitly set text/html
      const metadataExplicit: ContentMetadata = {
        url: 'https://example.com',
        contentType: 'text/html'
      };
      const resultExplicit = ContentAddressing.generateHash(content, metadataExplicit);

      expect(result.hash).toBe(resultExplicit.hash);
    });

  });

  describe('verifyHash', () => {

    it('should verify correct hash', () => {
      const content = '<div>Hello World</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result = ContentAddressing.generateHash(content, metadata);
      const isValid = ContentAddressing.verifyHash(content, metadata, result.hash);

      expect(isValid).toBe(true);
    });

    it('should reject incorrect hash', () => {
      const content = '<div>Hello World</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const wrongHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
      const isValid = ContentAddressing.verifyHash(content, metadata, wrongHash);

      expect(isValid).toBe(false);
    });

    it('should verify hash with whitespace variations', () => {
      const content1 = '<DIV>  Hello  </DIV>';
      const content2 = '<div> Hello </div>'; // Canonicalized form
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const result = ContentAddressing.generateHash(content1, metadata);
      const isValid = ContentAddressing.verifyHash(content2, metadata, result.hash);

      expect(isValid).toBe(true);
    });

  });

  describe('extractDigest', () => {

    it('should extract valid digest', () => {
      const hash = 'sha256:abc123def456';
      // Note: This is not a valid 64-char hex, just for testing extraction
      const digest = ContentAddressing.extractDigest(hash);
      expect(digest).toBeNull(); // Should be null because not 64 chars
    });

    it('should extract 64-character hex digest', () => {
      const hash = 'sha256:' + 'a'.repeat(64);
      const digest = ContentAddressing.extractDigest(hash);
      expect(digest).toBe('a'.repeat(64));
    });

    it('should return null for invalid format', () => {
      const hash = 'invalid:hash';
      const digest = ContentAddressing.extractDigest(hash);
      expect(digest).toBeNull();
    });

    it('should return null for missing prefix', () => {
      const hash = 'a'.repeat(64);
      const digest = ContentAddressing.extractDigest(hash);
      expect(digest).toBeNull();
    });

  });

  describe('isValidHash', () => {

    it('should validate correct hash format', () => {
      const hash = 'sha256:' + 'a'.repeat(64);
      expect(ContentAddressing.isValidHash(hash)).toBe(true);
    });

    it('should reject hash without prefix', () => {
      const hash = 'a'.repeat(64);
      expect(ContentAddressing.isValidHash(hash)).toBe(false);
    });

    it('should reject hash with wrong prefix', () => {
      const hash = 'sha512:' + 'a'.repeat(64);
      expect(ContentAddressing.isValidHash(hash)).toBe(false);
    });

    it('should reject hash with wrong length', () => {
      const hash = 'sha256:' + 'a'.repeat(32);
      expect(ContentAddressing.isValidHash(hash)).toBe(false);
    });

    it('should reject hash with invalid characters', () => {
      const hash = 'sha256:' + 'g'.repeat(64); // 'g' is not hex
      expect(ContentAddressing.isValidHash(hash)).toBe(false);
    });

    it('should reject hash with uppercase hex', () => {
      const hash = 'sha256:' + 'A'.repeat(64);
      expect(ContentAddressing.isValidHash(hash)).toBe(false);
    });

  });

  describe('compareHashes', () => {

    it('should return true for identical hashes', () => {
      const hash1 = 'sha256:' + 'a'.repeat(64);
      const hash2 = 'sha256:' + 'a'.repeat(64);
      expect(ContentAddressing.compareHashes(hash1, hash2)).toBe(true);
    });

    it('should return false for different hashes', () => {
      const hash1 = 'sha256:' + 'a'.repeat(64);
      const hash2 = 'sha256:' + 'b'.repeat(64);
      expect(ContentAddressing.compareHashes(hash1, hash2)).toBe(false);
    });

  });

  describe('integration tests', () => {

    it('should handle real-world HTML', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Page</title>
          <style>
            body { margin: 0; }
          </style>
        </head>
        <body>
          <!-- Navigation -->
          <nav>
            <a href="/">Home</a>
          </nav>

          <main>
            <h1>Welcome</h1>
            <p>
              This is a test page.
            </p>
          </main>

          <script>
            console.log('tracking');
          </script>
        </body>
        </html>
      `;

      const metadata: ContentMetadata = {
        url: 'https://example.com/test',
        contentType: 'text/html'
      };

      const result = ContentAddressing.generateHash(html, metadata);

      expect(ContentAddressing.isValidHash(result.hash)).toBe(true);
      expect(result.canonical.includes('Welcome')).toBe(true);
      expect(result.canonical.includes('<script')).toBe(false);
      expect(result.canonical.includes('<style')).toBe(false);
      expect(result.canonical.includes('<!--')).toBe(false);
    });

    it('should produce consistent hashes across multiple calls', () => {
      const html = '<div>Consistency Test</div>';
      const metadata: ContentMetadata = { url: 'https://example.com' };

      const hashes = Array.from({ length: 100 }, () =>
        ContentAddressing.generateHash(html, metadata).hash
      );

      const allSame = hashes.every(hash => hash === hashes[0]);
      expect(allSame).toBe(true);
    });

  });

});
