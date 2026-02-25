import { describe, it, expect } from 'vitest';
import { crossValidate } from '../services/extractors/structured-data-enrichment';
import type { StructuredMetadata } from '../services/extractors/structured-metadata-extractor';
import type { MarketplaceListing } from '../services/extractors/marketplace-adapter';

const makeListing = (overrides: Partial<MarketplaceListing> = {}): MarketplaceListing => ({
  id: 'test-123',
  marketplace: 'ebay',
  url: 'https://ebay.com/itm/123',
  title: 'Nintendo Switch OLED Console',
  price: { amount: 299.99, currency: 'USD' },
  availability: 'sold',
  seller: { name: 'testSeller' },
  images: [],
  extractedAt: new Date().toISOString(),
  extractionMethod: 'test',
  confidence: 0.7,
  extractorVersion: '1.0.0',
  ...overrides,
});

const makeMetadata = (overrides: Partial<StructuredMetadata> = {}): StructuredMetadata => ({
  jsonLd: [],
  openGraph: {},
  twitterCard: {},
  microdata: [],
  confidence: 0,
  ...overrides,
});

describe('crossValidate', () => {
  it('boosts confidence when JSON-LD price matches scraped price', () => {
    const listing = makeListing({ price: { amount: 299.99, currency: 'USD' } });
    const metadata = makeMetadata({
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Nintendo Switch OLED Console',
        offers: { '@type': 'Offer', price: 299.99, priceCurrency: 'USD' },
      }],
    });

    const result = crossValidate(listing, metadata);
    expect(result.validatedFields).toContain('price');
    expect(result.validatedFields).toContain('title');
    expect(result.confidenceAdjustment).toBeGreaterThan(0);
    expect(result.source).toBe('json-ld');
  });

  it('reports conflict when prices disagree', () => {
    const listing = makeListing({ price: { amount: 299.99, currency: 'USD' } });
    const metadata = makeMetadata({
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Nintendo Switch OLED Console',
        offers: { '@type': 'Offer', price: 249.99, priceCurrency: 'USD' },
      }],
    });

    const result = crossValidate(listing, metadata);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('price');
    expect(result.conflicts[0].scraped).toBe(299.99);
    expect(result.conflicts[0].structured).toBe(249.99);
  });

  it('validates title via substring match', () => {
    const listing = makeListing({ title: 'Nintendo Switch OLED' });
    const metadata = makeMetadata({
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Nintendo Switch OLED Console - White Edition',
      }],
    });

    const result = crossValidate(listing, metadata);
    expect(result.validatedFields).toContain('title');
  });

  it('falls back to OG title when no JSON-LD product found', () => {
    const listing = makeListing({ title: 'Test Product' });
    const metadata = makeMetadata({
      openGraph: { 'og:title': 'Test Product - Best Seller' },
    });

    const result = crossValidate(listing, metadata);
    expect(result.validatedFields).toContain('title');
    expect(result.source).toBe('open-graph');
  });

  it('returns zero adjustment when no structured data matches', () => {
    const listing = makeListing();
    const metadata = makeMetadata();

    const result = crossValidate(listing, metadata);
    expect(result.confidenceAdjustment).toBe(0);
    expect(result.validatedFields).toHaveLength(0);
    expect(result.source).toBeNull();
  });

  it('caps confidence adjustment at 0.15', () => {
    const listing = makeListing({
      price: { amount: 100, currency: 'USD' },
      seller: { name: 'BigStore' },
    });
    const metadata = makeMetadata({
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: listing.title,
        offers: { '@type': 'Offer', price: 100, priceCurrency: 'USD' },
        seller: { '@type': 'Organization', name: 'BigStore' },
      }],
    });

    const result = crossValidate(listing, metadata);
    expect(result.confidenceAdjustment).toBeLessThanOrEqual(0.15);
  });

  it('handles price within 1% tolerance as matching', () => {
    const listing = makeListing({ price: { amount: 299.99, currency: 'USD' } });
    const metadata = makeMetadata({
      jsonLd: [{
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Test',
        offers: { '@type': 'Offer', price: 300.00, priceCurrency: 'USD' },
      }],
    });

    const result = crossValidate(listing, metadata);
    expect(result.validatedFields).toContain('price');
  });
});
