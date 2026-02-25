/**
 * Edge-case tests for structured extraction pipeline.
 * Covers real-world HTML patterns from major sites that could
 * appear during a live demo (news articles, Wikipedia, e-commerce).
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { structuredMetadataExtractor } from '../services/extractors/structured-metadata-extractor';
import { tableExtractor } from '../services/extractors/table-extractor';
import { crossValidate } from '../services/extractors/structured-data-enrichment';
import type { MarketplaceListing } from '../services/extractors/marketplace-adapter';

const parseDoc = (html: string): Document => new JSDOM(html).window.document;

// =========================================================================
// Real-world JSON-LD patterns
// =========================================================================

describe('Real-world JSON-LD patterns', () => {
  it('handles Google/Schema.org @graph pattern (common on news sites)', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {"@type": "WebSite", "name": "Example News"},
          {"@type": "Article", "headline": "Breaking News Story", "author": {"@type": "Person", "name": "Jane Doe"}}
        ]
      }
      </script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    // @graph is on the parent object which has @context, so the parent is collected
    expect(result.jsonLd.length).toBeGreaterThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('handles Amazon-style Product JSON-LD with nested offers array', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Echo Dot (5th Gen)",
        "image": "https://images-na.ssl-images-amazon.com/images/I/echo-dot.jpg",
        "offers": [
          {"@type": "Offer", "price": 49.99, "priceCurrency": "USD", "availability": "https://schema.org/InStock"},
          {"@type": "Offer", "price": 44.99, "priceCurrency": "USD", "availability": "https://schema.org/InStock", "seller": {"@type": "Organization", "name": "Amazon.com"}}
        ]
      }
      </script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.jsonLd).toHaveLength(1);
    expect(result.jsonLd[0]['@type']).toBe('Product');

    // Cross-validate with a listing
    const listing: MarketplaceListing = {
      id: 'B09B8V1LZ3',
      marketplace: 'amazon',
      url: 'https://amazon.com/dp/B09B8V1LZ3',
      title: 'Echo Dot (5th Gen)',
      price: { amount: 49.99, currency: 'USD' },
      availability: 'in_stock',
      seller: { name: 'Amazon.com' },
      images: [],
      extractedAt: new Date().toISOString(),
      extractionMethod: 'test',
      confidence: 0.7,
      extractorVersion: '1.0.0',
    };
    const enrichment = crossValidate(listing, result);
    expect(enrichment.validatedFields).toContain('title');
    expect(enrichment.validatedFields).toContain('price');
    expect(enrichment.confidenceAdjustment).toBeGreaterThan(0);
  });

  it('handles JSON-LD with HTML entities and unicode in strings', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Beyonc\\u00e9 Concert T-Shirt \\u2014 Limited Edition",
        "offers": {"@type": "Offer", "price": "39.99"}
      }
      </script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.jsonLd).toHaveLength(1);
    expect(result.jsonLd[0]['name']).toContain('Beyonc');
  });

  it('handles multiple JSON-LD blocks (BreadcrumbList + Product)', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": []}
      </script>
      <script type="application/ld+json">
        {"@context": "https://schema.org", "@type": "Product", "name": "Widget Pro"}
      </script>
      <script type="application/ld+json">
        {"@context": "https://schema.org", "@type": "Organization", "name": "Acme Corp"}
      </script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.jsonLd).toHaveLength(3);
  });

  it('survives completely broken JSON-LD mixed with valid ones', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">NOT JSON AT ALL {{{</script>
      <script type="application/ld+json">
        {"@type": "Article", "headline": "Valid Article"}
      </script>
      <script type="application/ld+json"></script>
      <script type="application/ld+json">null</script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.jsonLd).toHaveLength(1);
    expect(result.jsonLd[0]['headline']).toBe('Valid Article');
  });

  it('handles eBay-style JSON-LD with price as string', () => {
    const doc = parseDoc(`<html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Nintendo Switch OLED",
        "offers": {
          "@type": "Offer",
          "price": "299.99",
          "priceCurrency": "USD"
        }
      }
      </script>
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    const listing: MarketplaceListing = {
      id: '123', marketplace: 'ebay', url: 'https://ebay.com/itm/123',
      title: 'Nintendo Switch OLED', price: { amount: 299.99, currency: 'USD' },
      availability: 'sold', seller: { name: null }, images: [],
      extractedAt: new Date().toISOString(), extractionMethod: 'test',
      confidence: 0.7, extractorVersion: '1.0.0',
    };
    const enrichment = crossValidate(listing, result);
    expect(enrichment.validatedFields).toContain('price');
  });
});

// =========================================================================
// Real-world table patterns
// =========================================================================

describe('Real-world table patterns', () => {
  it('extracts Wikipedia infobox-style table', () => {
    const doc = parseDoc(`<html><body>
      <table class="infobox">
        <caption>Country Facts</caption>
        <tr><th>Capital</th><td>Washington, D.C.</td></tr>
        <tr><th>Population</th><td>331,449,281</td></tr>
        <tr><th>GDP</th><td>$25.46 trillion</td></tr>
        <tr><th>Currency</th><td>US Dollar (USD)</td></tr>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe('Country Facts');
    expect(result[0].rowCount).toBeGreaterThanOrEqual(3);
  });

  it('extracts Wikipedia data table with proper headers', () => {
    const doc = parseDoc(`<html><body>
      <table class="wikitable sortable">
        <thead>
          <tr><th>Year</th><th>Revenue (USD)</th><th>Employees</th></tr>
        </thead>
        <tbody>
          <tr><td>2020</td><td>$274.5 billion</td><td>1,298,000</td></tr>
          <tr><td>2021</td><td>$469.8 billion</td><td>1,608,000</td></tr>
          <tr><td>2022</td><td>$514.0 billion</td><td>1,541,000</td></tr>
          <tr><td>2023</td><td>$574.8 billion</td><td>1,525,000</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Year', 'Revenue (USD)', 'Employees']);
    expect(result[0].rowCount).toBe(4);
    expect(result[0].rows[0]['Year']).toBe('2020');
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('handles table with colspan/rowspan (degrades gracefully)', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Name</th><th>Q1</th><th>Q2</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td colspan="2">On leave</td></tr>
          <tr><td>Bob</td><td>$100k</td><td>$120k</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    // First row has fewer cells due to colspan — should still extract
    expect(result[0].rowCount).toBe(2);
  });

  it('handles empty cells in tables', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Name</th><th>Value</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Item A</td><td>100</td><td></td></tr>
          <tr><td>Item B</td><td></td><td>Pending</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].rowCount).toBe(2);
    expect(result[0].rows[0]['Notes']).toBe('');
    expect(result[0].rows[1]['Value']).toBe('');
  });

  it('skips navigation table but extracts data table on same page', () => {
    const navLinks = Array.from({ length: 15 }, (_, i) =>
      `<tr><td><a href="/p${i}">Page ${i}</a></td><td><a href="/q${i}">Alt ${i}</a></td></tr>`
    ).join('');

    const doc = parseDoc(`<html><body>
      <table id="nav">
        <tr><th>Nav</th><th>Links</th></tr>
        ${navLinks}
      </table>
      <table id="data">
        <thead><tr><th>Metric</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Revenue</td><td>$1M</td></tr>
          <tr><td>Users</td><td>50,000</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Metric', 'Value']);
  });
});

// =========================================================================
// Microdata edge cases (verify scoping fix)
// =========================================================================

describe('Microdata scoping (regression tests)', () => {
  it('nested itemscope props do not leak to parent', () => {
    const doc = parseDoc(`<html><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Widget</span>
        <span itemprop="description">A fine widget</span>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <span itemprop="price">29.99</span>
          <meta itemprop="priceCurrency" content="USD" />
        </div>
        <div itemprop="review" itemscope itemtype="https://schema.org/Review">
          <span itemprop="reviewBody">Great product!</span>
          <div itemprop="author" itemscope itemtype="https://schema.org/Person">
            <span itemprop="name">Jane</span>
          </div>
        </div>
      </div>
    </body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.microdata).toHaveLength(1);

    const product = result.microdata[0];
    expect(product.type).toBe('https://schema.org/Product');

    // Product should have name, description, offers, review — NOT price, priceCurrency, reviewBody, author
    expect(product.properties['name']).toBe('Widget');
    expect(product.properties['description']).toBe('A fine widget');
    expect(product.properties).not.toHaveProperty('price');
    expect(product.properties).not.toHaveProperty('priceCurrency');
    expect(product.properties).not.toHaveProperty('reviewBody');

    // Offers should be a nested object with its own price
    const offers = product.properties['offers'];
    expect(typeof offers).toBe('object');
    expect((offers as any).properties['price']).toBe('29.99');
    expect((offers as any).properties['priceCurrency']).toBe('USD');

    // Review should be nested with its own author
    const review = product.properties['review'];
    expect(typeof review).toBe('object');
    expect((review as any).properties['reviewBody']).toBe('Great product!');

    // Author should be nested inside review
    const author = (review as any).properties['author'];
    expect(typeof author).toBe('object');
    expect((author as any).properties['name']).toBe('Jane');
  });

  it('handles microdata without itemtype', () => {
    const doc = parseDoc(`<html><body>
      <div itemscope>
        <span itemprop="name">Untyped Item</span>
      </div>
    </body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.microdata).toHaveLength(1);
    expect(result.microdata[0].type).toBeNull();
    expect(result.microdata[0].properties['name']).toBe('Untyped Item');
  });

  it('handles sibling itemscopes at top level', () => {
    const doc = parseDoc(`<html><body>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Product A</span>
      </div>
      <div itemscope itemtype="https://schema.org/Product">
        <span itemprop="name">Product B</span>
      </div>
    </body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.microdata).toHaveLength(2);
    expect(result.microdata[0].properties['name']).toBe('Product A');
    expect(result.microdata[1].properties['name']).toBe('Product B');
  });
});

// =========================================================================
// Open Graph edge cases
// =========================================================================

describe('Open Graph edge cases', () => {
  it('handles OG tags with empty content', () => {
    const doc = parseDoc(`<html><head>
      <meta property="og:title" content="Real Title" />
      <meta property="og:description" content="" />
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.openGraph['og:title']).toBe('Real Title');
    // Empty content is not included (empty string is falsy for getAttribute check)
    expect(result.openGraph).not.toHaveProperty('og:description');
  });

  it('handles both OG and Twitter with same info', () => {
    const doc = parseDoc(`<html><head>
      <meta property="og:title" content="Article Title" />
      <meta property="og:image" content="https://img.example.com/hero.jpg" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="Article Title" />
      <meta name="twitter:image" content="https://img.example.com/hero.jpg" />
    </head><body></body></html>`);

    const result = structuredMetadataExtractor.extract(doc);
    expect(result.openGraph['og:title']).toBe('Article Title');
    expect(result.twitterCard['twitter:title']).toBe('Article Title');
  });
});

// =========================================================================
// Cross-validation edge cases
// =========================================================================

describe('Cross-validation edge cases', () => {
  it('handles listing with null price', () => {
    const listing: MarketplaceListing = {
      id: '1', marketplace: 'ebay', url: 'https://ebay.com/itm/1',
      title: 'Test Item', price: null,
      availability: 'sold', seller: { name: null }, images: [],
      extractedAt: new Date().toISOString(), extractionMethod: 'test',
      confidence: 0.5, extractorVersion: '1.0.0',
    };

    const metadata = structuredMetadataExtractor.extract(
      parseDoc(`<html><head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Product", "name": "Test Item", "offers": {"@type": "Offer", "price": 50}}
        </script>
      </head><body></body></html>`)
    );

    const result = crossValidate(listing, metadata);
    // Should validate title but not crash on null price
    expect(result.validatedFields).toContain('title');
    expect(result.conflicts).toHaveLength(0); // null price = no conflict, just no validation
  });

  it('handles case-insensitive title matching', () => {
    const listing: MarketplaceListing = {
      id: '1', marketplace: 'ebay', url: 'https://ebay.com/itm/1',
      title: 'NINTENDO SWITCH OLED CONSOLE', price: null,
      availability: 'sold', seller: { name: null }, images: [],
      extractedAt: new Date().toISOString(), extractionMethod: 'test',
      confidence: 0.5, extractorVersion: '1.0.0',
    };

    const metadata = structuredMetadataExtractor.extract(
      parseDoc(`<html><head>
        <script type="application/ld+json">
          {"@context": "https://schema.org", "@type": "Product", "name": "Nintendo Switch OLED Console"}
        </script>
      </head><body></body></html>`)
    );

    const result = crossValidate(listing, metadata);
    expect(result.validatedFields).toContain('title');
  });
});
