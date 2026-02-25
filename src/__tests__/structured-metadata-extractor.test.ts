import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { structuredMetadataExtractor } from '../services/extractors/structured-metadata-extractor';

const parseDoc = (html: string): Document => {
  return new JSDOM(html).window.document;
};

describe('structuredMetadataExtractor', () => {
  describe('JSON-LD extraction', () => {
    it('extracts valid JSON-LD from script tags', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Article", "headline": "Test Article"}
        </script>
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.jsonLd).toHaveLength(1);
      expect(result.jsonLd[0]['@type']).toBe('Article');
      expect(result.jsonLd[0]['headline']).toBe('Test Article');
    });

    it('handles malformed JSON-LD gracefully', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          { this is not valid json }
        </script>
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.jsonLd).toHaveLength(0);
    });

    it('extracts multiple JSON-LD blocks', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Article", "headline": "First"}
        </script>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Organization", "name": "Test Org"}
        </script>
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.jsonLd).toHaveLength(2);
      expect(result.jsonLd[0]['@type']).toBe('Article');
      expect(result.jsonLd[1]['@type']).toBe('Organization');
    });

    it('handles JSON-LD arrays', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          [
            {"@context": "https://schema.org", "@type": "BreadcrumbList"},
            {"@context": "https://schema.org", "@type": "Article", "headline": "Test"}
          ]
        </script>
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.jsonLd).toHaveLength(2);
    });

    it('skips JSON-LD without @context or @type', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          {"name": "just a random object"}
        </script>
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.jsonLd).toHaveLength(0);
    });
  });

  describe('Open Graph extraction', () => {
    it('extracts full Open Graph metadata', () => {
      const doc = parseDoc(`<html><head>
        <meta property="og:title" content="OG Title" />
        <meta property="og:description" content="OG Description" />
        <meta property="og:image" content="https://example.com/image.jpg" />
        <meta property="og:url" content="https://example.com" />
        <meta property="og:type" content="article" />
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.openGraph['og:title']).toBe('OG Title');
      expect(result.openGraph['og:description']).toBe('OG Description');
      expect(result.openGraph['og:image']).toBe('https://example.com/image.jpg');
      expect(result.openGraph['og:url']).toBe('https://example.com');
      expect(result.openGraph['og:type']).toBe('article');
    });

    it('returns empty object when no OG tags present', () => {
      const doc = parseDoc('<html><head></head><body></body></html>');
      const result = structuredMetadataExtractor.extract(doc);
      expect(result.openGraph).toEqual({});
    });
  });

  describe('Twitter Card extraction', () => {
    it('extracts Twitter Card metadata', () => {
      const doc = parseDoc(`<html><head>
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Twitter Title" />
        <meta name="twitter:description" content="Twitter Desc" />
        <meta name="twitter:image" content="https://example.com/twitter.jpg" />
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.twitterCard['twitter:card']).toBe('summary_large_image');
      expect(result.twitterCard['twitter:title']).toBe('Twitter Title');
    });
  });

  describe('Microdata extraction', () => {
    it('extracts microdata with nested itemscope', () => {
      const doc = parseDoc(`<html><body>
        <div itemscope itemtype="https://schema.org/Product">
          <span itemprop="name">Widget</span>
          <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
            <span itemprop="price">29.99</span>
            <meta itemprop="priceCurrency" content="USD" />
          </div>
        </div>
      </body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.microdata).toHaveLength(1);
      expect(result.microdata[0].type).toBe('https://schema.org/Product');
      expect(result.microdata[0].properties['name']).toBe('Widget');

      const offers = result.microdata[0].properties['offers'];
      expect(typeof offers).toBe('object');
      expect((offers as any).type).toBe('https://schema.org/Offer');
    });

    it('returns empty array when no microdata present', () => {
      const doc = parseDoc('<html><body><p>No microdata here</p></body></html>');
      const result = structuredMetadataExtractor.extract(doc);
      expect(result.microdata).toEqual([]);
    });
  });

  describe('Confidence scoring', () => {
    it('returns high confidence when all metadata types present', () => {
      const doc = parseDoc(`<html><head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Article", "headline": "Test"}
        </script>
        <meta property="og:title" content="Title" />
        <meta property="og:description" content="Desc" />
        <meta property="og:image" content="img.jpg" />
      </head><body>
        <div itemscope itemtype="https://schema.org/Thing">
          <span itemprop="name">Item</span>
        </div>
      </body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.confidence).toBe(1);
    });

    it('returns zero confidence for empty HTML', () => {
      const doc = parseDoc('<html><head></head><body></body></html>');
      const result = structuredMetadataExtractor.extract(doc);
      expect(result.confidence).toBe(0);
      expect(result.jsonLd).toEqual([]);
      expect(result.openGraph).toEqual({});
      expect(result.twitterCard).toEqual({});
      expect(result.microdata).toEqual([]);
    });

    it('returns partial confidence for sparse metadata', () => {
      const doc = parseDoc(`<html><head>
        <meta property="og:title" content="Just a title" />
      </head><body></body></html>`);

      const result = structuredMetadataExtractor.extract(doc);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThan(0.5);
    });
  });
});
