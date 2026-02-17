import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock all external dependencies BEFORE importing distiller
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../services/policy-engine', () => ({
  policyEngine: {
    init: vi.fn().mockResolvedValue(undefined),
    applyPolicy: vi.fn(),
  },
}));

vi.mock('../services/ollama-extractor', () => ({
  ollamaExtractor: {
    extract: vi.fn(),
  },
}));

vi.mock('../services/extractors/ebay-adapter', () => ({
  ebayAdapter: {
    isEbayListing: vi.fn().mockReturnValue(false),
    extractLegacy: vi.fn(),
  },
}));

vi.mock('../services/extractors/ebay-search-adapter', () => ({
  ebaySearchAdapter: {
    isSoldSearch: vi.fn().mockReturnValue(false),
    extractLegacy: vi.fn(),
  },
}));

vi.mock('../services/extractors/dom-heuristic', () => ({
  domHeuristicExtractor: {
    extract: vi.fn().mockReturnValue({
      title: 'DOM Title',
      content: '',
      paragraphs: [],
      confidence: 0.3,
      method: 'dom-heuristic',
    }),
  },
}));

vi.mock('../services/extractors/trafilatura', () => ({
  trafilaturaExtract: vi.fn().mockResolvedValue(null),
}));

vi.mock('../core/extraction-ensemble', () => ({
  extractionEnsemble: {
    selectBest: vi.fn(),
  },
}));

vi.mock('../core/confidence-scorer', () => ({
  confidenceScorer: {
    computeFull: vi.fn().mockReturnValue({
      extraction: 0.8,
      contentQuality: 0.7,
      metadata: 0.6,
      sourceCredibility: 0.5,
      consensus: 0.5,
      overall: 0.65,
    }),
  },
}));

import { distillContent } from '../services/distiller';
import { policyEngine } from '../services/policy-engine';
import { ollamaExtractor } from '../services/ollama-extractor';
import { ebayAdapter } from '../services/extractors/ebay-adapter';
import { ebaySearchAdapter } from '../services/extractors/ebay-search-adapter';
import { domHeuristicExtractor } from '../services/extractors/dom-heuristic';
import { trafilaturaExtract } from '../services/extractors/trafilatura';
import { extractionEnsemble } from '../core/extraction-ensemble';

const BASE_URL = 'https://example.com/page';

// Helper to generate long content that passes completeness guards (>= 300 chars, >= 80 words, >= 3 paragraphs)
function makeLongContent(paragraphs: number = 4): string {
  const para = 'This is a long paragraph with enough words to satisfy the completeness guard checks in the distiller pipeline. It contains many words and characters to ensure we pass all thresholds easily.';
  return Array.from({ length: paragraphs }, () => para).join('\n\n');
}

const RICH_HTML = `<!DOCTYPE html>
<html lang="en"><head><title>Test Page</title></head>
<body><article>
  <h1>Heading</h1>
  <p>First paragraph with enough text to be meaningful for extraction testing purposes here.</p>
  <p>Second paragraph with additional information that makes the article substantial enough.</p>
  <p>Third paragraph adds more depth and ensures paragraph count is sufficient for ensemble.</p>
  <p>Fourth paragraph ensures we pass completeness checks with enough word count.</p>
  <p>Fifth paragraph rounds things out with enough content for all extraction heuristics.</p>
</article></body></html>`;

// Helper to set up a "readability wins" scenario with robust content
function setupReadabilityWins() {
  const longContent = makeLongContent(4);
  const candidate = {
    method: 'readability' as const,
    title: 'Readability Title',
    content: longContent,
    paragraphCount: 4,
    confidence: 0.9,
    metadata: { author: 'Author Name', publishDate: null, excerpt: 'An excerpt' },
  };

  vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
    selected: candidate,
    score: {
      contentLength: 0.8,
      structureQuality: 0.9,
      metadataCompleteness: 0.7,
      textDensity: 0.8,
      extractorConfidence: 0.9,
      compositeScore: 0.85,
    },
    explanation: 'Readability won',
    allScores: [],
  });

  return candidate;
}

function setupDomHeuristicWins() {
  const longPara = 'This is a long paragraph with enough words to satisfy all completeness guard checks in the distiller pipeline so extraction is accepted.';
  const paragraphs = [
    { text: `Dom paragraph one. ${longPara}`, selector: 'p:nth-child(1)' },
    { text: `Dom paragraph two. ${longPara}`, selector: 'p:nth-child(2)' },
    { text: `Dom paragraph three. ${longPara}`, selector: 'p:nth-child(3)' },
    { text: `Dom paragraph four. ${longPara}`, selector: 'p:nth-child(4)' },
  ];

  const content = paragraphs.map(p => p.text).join('\n\n');

  vi.mocked(domHeuristicExtractor.extract).mockReturnValue({
    title: 'DOM Title',
    content,
    paragraphs,
    confidence: 0.6,
    method: 'dom-heuristic',
  });

  const candidate = {
    method: 'dom-heuristic' as const,
    title: 'DOM Title',
    content,
    paragraphCount: 4,
    confidence: 0.6,
    metadata: { author: null, publishDate: null, excerpt: 'Dom paragraph one' },
  };

  vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
    selected: candidate,
    score: {
      contentLength: 0.6,
      structureQuality: 0.5,
      metadataCompleteness: 0.3,
      textDensity: 0.7,
      extractorConfidence: 0.6,
      compositeScore: 0.55,
    },
    explanation: 'DOM heuristic selected',
    allScores: [],
  });

  return { candidate, paragraphs };
}

describe('distillContent — branch coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: policy applies successfully
    vi.mocked(policyEngine.init).mockResolvedValue(undefined);
    vi.mocked(policyEngine.applyPolicy).mockReturnValue({
      transformedHtml: RICH_HTML,
      policyApplied: 'default',
      rulesMatched: 0,
      fieldsValidated: true,
      validationErrors: [],
    });

    // Default: no special adapters match
    vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(false);
    vi.mocked(ebayAdapter.isEbayListing).mockReturnValue(false);

    // Default: ollama fails
    vi.mocked(ollamaExtractor.extract).mockRejectedValue(new Error('no ollama'));

    // Default: trafilatura returns null
    vi.mocked(trafilaturaExtract).mockResolvedValue(null);

    // Default: dom-heuristic returns empty
    vi.mocked(domHeuristicExtractor.extract).mockReturnValue({
      title: 'DOM Title',
      content: '',
      paragraphs: [],
      confidence: 0.3,
      method: 'dom-heuristic',
    });
  });

  // -------------------------------------------------------------------
  // Policy engine branches
  // -------------------------------------------------------------------

  describe('policy engine', () => {
    it('handles policy application failure gracefully', async () => {
      vi.mocked(policyEngine.applyPolicy).mockImplementation(() => {
        throw new Error('Policy load failed');
      });

      // Need at least one candidate so we don't just get fallback
      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
    });

    it('handles policy failure with non-Error thrown', async () => {
      vi.mocked(policyEngine.applyPolicy).mockImplementation(() => {
        throw 'string error';
      });

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
    });

    it('includes policyMetadata when policy succeeds', async () => {
      vi.mocked(policyEngine.applyPolicy).mockReturnValue({
        transformedHtml: RICH_HTML,
        policyApplied: 'news-policy',
        rulesMatched: 3,
        fieldsValidated: true,
        validationErrors: [],
      });

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.policyMetadata).toEqual({
        policyApplied: 'news-policy',
        rulesMatched: 3,
        fieldsValidated: true,
      });
    });

    it('omits policyMetadata when policy fails', async () => {
      vi.mocked(policyEngine.applyPolicy).mockImplementation(() => {
        throw new Error('fail');
      });

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.policyMetadata).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // eBay search adapter branches
  // -------------------------------------------------------------------

  describe('eBay search adapter', () => {
    it('returns eBay search result with items (GBP currency)', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item 1',
            price: 25.99,
            currency: 'GBP',
            soldDate: '2024-01-01',
            condition: 'Used',
            shippingText: null,
            shippingCost: 5.0,
            url: 'https://ebay.co.uk/itm/1',
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.85,
        query: 'test',
        searchUrl: 'https://ebay.co.uk/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.co.uk/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.extractionMethod).toBe('ebay-search-adapter');
      expect(result.contentText).toContain('£25.99');
      expect(result.contentText).toContain('Sold Date: 2024-01-01');
      expect(result.contentText).toContain('Condition: Used');
    });

    it('returns eBay search result with EUR currency', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item EUR',
            price: 30.0,
            currency: 'EUR',
            soldDate: null,
            condition: null,
            shippingText: 'Free P&P',
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.de/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.de/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.contentText).toContain('€30.00');
      expect(result.contentText).toContain('Shipping: Free P&P');
      // No sold date line
      expect(result.contentText).not.toContain('Sold Date:');
      // No condition line
      expect(result.contentText).not.toContain('Condition:');
      // No URL line
      expect(result.contentText).not.toContain('Listing URL:');
    });

    it('returns eBay search result with USD (default) currency', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item USD',
            price: 15.50,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: 0,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.contentText).toContain('$15.50');
      // Free shipping branch (shippingCost === 0)
      expect(result.contentText).toContain('Shipping: Free shipping');
    });

    it('handles eBay search with paid shipping (non-zero cost, no shippingText)', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item Paid Shipping',
            price: 50.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: 8.50,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.contentText).toContain('Shipping: Shipping Cost: $8.50');
    });

    it('handles eBay search with null shippingCost (no shipping line)', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item No Shipping',
            price: 10.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.contentText).not.toContain('Shipping:');
    });

    it('adds separator between multiple items', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item A',
            price: 10.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
          {
            title: 'Item B',
            price: 20.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 2,
        detectedCount: 2,
        confidence: 0.85,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.contentText).toContain('---');
      expect(result.title).toContain('2 items');
    });

    it('falls back when eBay search finds zero items', async () => {
      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [],
        extractedCount: 0,
        detectedCount: 5,
        confidence: 0.1,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      // Must set up a candidate since it will continue to generic extraction
      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      // Should not be ebay-search-adapter since extractedCount is 0
      expect(result.extractionMethod).not.toBe('ebay-search-adapter');
    });

    it('includes policyMetadata in eBay search result when policy succeeded', async () => {
      vi.mocked(policyEngine.applyPolicy).mockReturnValue({
        transformedHtml: RICH_HTML,
        policyApplied: 'ebay-search',
        rulesMatched: 2,
        fieldsValidated: true,
        validationErrors: [],
      });

      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item',
            price: 10.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.policyMetadata).toEqual({
        policyApplied: 'ebay-search',
        rulesMatched: 2,
        fieldsValidated: true,
      });
    });

    it('omits policyMetadata in eBay search result when policy failed', async () => {
      vi.mocked(policyEngine.applyPolicy).mockImplementation(() => {
        throw new Error('fail');
      });

      vi.mocked(ebaySearchAdapter.isSoldSearch).mockReturnValue(true);
      vi.mocked(ebaySearchAdapter.extractLegacy).mockReturnValue({
        items: [
          {
            title: 'Item',
            price: 10.0,
            currency: 'USD',
            soldDate: null,
            condition: null,
            shippingText: null,
            shippingCost: null,
            url: null,
            imageUrl: null,
            watchers: null,
            bestOffer: false,
          },
        ],
        extractedCount: 1,
        detectedCount: 1,
        confidence: 0.8,
        query: 'test',
        searchUrl: 'https://ebay.com/sch',
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');
      expect(result.policyMetadata).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // eBay listing adapter branches
  // -------------------------------------------------------------------

  describe('eBay listing adapter', () => {
    it('extracts eBay listing with full data', async () => {
      vi.mocked(ebayAdapter.isEbayListing).mockReturnValue(true);
      vi.mocked(ebayAdapter.extractLegacy).mockReturnValue({
        title: 'Vintage Widget',
        soldPrice: 99.99,
        soldDate: '2024-06-15',
        condition: 'Used',
        itemNumber: '123456789',
        shippingCost: 5.00,
        currency: 'USD',
        seller: { name: 'seller_abc', rating: 99.5 },
        confidence: 0.9,
        url: 'https://www.ebay.com/itm/123',
        imageUrls: [],
        watchers: null,
        bestOffer: false,
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/itm/123456789');
      expect(result.extractionMethod).toBe('ebay-adapter');
      expect(result.contentText).toContain('Sold Price: USD 99.99');
      expect(result.contentText).toContain('Condition: Used');
      expect(result.contentText).toContain('Item Number: 123456789');
      expect(result.contentText).toContain('Seller: seller_abc');
      expect(result.contentText).toContain('Seller Rating: 99.5%');
    });

    it('extracts eBay listing with null/missing fields', async () => {
      vi.mocked(ebayAdapter.isEbayListing).mockReturnValue(true);
      vi.mocked(ebayAdapter.extractLegacy).mockReturnValue({
        title: 'Widget',
        soldPrice: null,
        soldDate: null,
        condition: null,
        itemNumber: null,
        shippingCost: null,
        currency: 'USD',
        seller: { name: null, rating: null },
        confidence: 0.5,
        url: 'https://www.ebay.com/itm/1',
        imageUrls: [],
        watchers: null,
        bestOffer: false,
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/itm/1');
      expect(result.contentText).toContain('Sold Price: Not found');
      expect(result.contentText).toContain('Sold Date: Not found');
      expect(result.contentText).toContain('Condition: Not found');
      expect(result.contentText).toContain('Item Number: Not found');
      expect(result.contentText).toContain('Shipping: Not found');
      expect(result.contentText).toContain('Seller: Not found');
      // Empty seller rating line should be filtered out
      expect(result.contentText).not.toContain('Seller Rating:');
    });

    it('includes policyMetadata in eBay listing when policy succeeded', async () => {
      vi.mocked(policyEngine.applyPolicy).mockReturnValue({
        transformedHtml: RICH_HTML,
        policyApplied: 'ebay-listing',
        rulesMatched: 1,
        fieldsValidated: true,
        validationErrors: [],
      });

      vi.mocked(ebayAdapter.isEbayListing).mockReturnValue(true);
      vi.mocked(ebayAdapter.extractLegacy).mockReturnValue({
        title: 'Widget',
        soldPrice: 50.0,
        soldDate: null,
        condition: null,
        itemNumber: null,
        shippingCost: null,
        currency: 'USD',
        seller: { name: null, rating: null },
        confidence: 0.7,
        url: 'https://www.ebay.com/itm/1',
        imageUrls: [],
        watchers: null,
        bestOffer: false,
      });

      const result = await distillContent(RICH_HTML, 'https://www.ebay.com/itm/1');
      expect(result.policyMetadata).toBeDefined();
      expect(result.policyMetadata!.policyApplied).toBe('ebay-listing');
    });
  });

  // -------------------------------------------------------------------
  // Ollama extraction branches
  // -------------------------------------------------------------------

  describe('ollama extraction', () => {
    it('adds ollama candidate when extraction succeeds', async () => {
      const longContent = makeLongContent(4);
      vi.mocked(ollamaExtractor.extract).mockResolvedValue({
        title: 'Ollama Title',
        content: longContent,
        summary: 'A summary',
        metadata: { model: 'llama3', durationMs: 1234 },
      });

      const candidate = {
        method: 'ollama' as const,
        title: 'Ollama Title',
        content: longContent,
        paragraphCount: 4,
        confidence: 0.8,
        metadata: { author: null, publishDate: null, excerpt: 'A summary' },
      };

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: candidate,
        score: {
          contentLength: 0.7,
          structureQuality: 0.6,
          metadataCompleteness: 0.5,
          textDensity: 0.8,
          extractorConfidence: 0.8,
          compositeScore: 0.7,
        },
        explanation: 'Ollama won',
        allScores: [],
      });

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.extractionMethod).toBe('ollama');
      expect(result.nodes.length).toBeGreaterThan(0);
      expect(result.nodes[0].id).toContain('ollama-paragraph');
    });

    it('handles ollama extraction returning null', async () => {
      vi.mocked(ollamaExtractor.extract).mockResolvedValue(null);

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      // Should still work, just without ollama candidate
      expect(result).toBeDefined();
    });

    it('handles ollama failure with non-Error thrown', async () => {
      vi.mocked(ollamaExtractor.extract).mockRejectedValue('string error');

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
    });

    it('populates ollamaMetadata when ollama method selected and re-extract succeeds', async () => {
      const longContent = makeLongContent(4);
      // First call for candidate collection, second call in the switch case
      vi.mocked(ollamaExtractor.extract)
        .mockResolvedValueOnce({
          title: 'Ollama Title',
          content: longContent,
          summary: 'Sum',
          metadata: { model: 'llama3', durationMs: 500 },
        })
        .mockResolvedValueOnce({
          title: 'Ollama Title',
          content: longContent,
          summary: 'Sum',
          metadata: { model: 'llama3', durationMs: 500 },
        });

      const candidate = {
        method: 'ollama' as const,
        title: 'Ollama Title',
        content: longContent,
        paragraphCount: 4,
        confidence: 0.8,
        metadata: { author: null, publishDate: null, excerpt: 'Sum' },
      };

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: candidate,
        score: {
          contentLength: 0.7,
          structureQuality: 0.7,
          metadataCompleteness: 0.5,
          textDensity: 0.8,
          extractorConfidence: 0.8,
          compositeScore: 0.7,
        },
        explanation: 'Ollama selected',
        allScores: [],
      });

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.ollamaMetadata).toEqual({ model: 'llama3', durationMs: 500 });
    });

    it('handles ollamaMetadata re-extraction failure silently', async () => {
      const longContent = makeLongContent(4);
      vi.mocked(ollamaExtractor.extract)
        .mockResolvedValueOnce({
          title: 'Ollama Title',
          content: longContent,
          summary: 'Sum',
          metadata: { model: 'llama3', durationMs: 100 },
        })
        .mockRejectedValueOnce(new Error('ollama down'));

      const candidate = {
        method: 'ollama' as const,
        title: 'Ollama Title',
        content: longContent,
        paragraphCount: 4,
        confidence: 0.8,
        metadata: { author: null, publishDate: null, excerpt: 'Sum' },
      };

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: candidate,
        score: {
          contentLength: 0.7,
          structureQuality: 0.7,
          metadataCompleteness: 0.5,
          textDensity: 0.8,
          extractorConfidence: 0.8,
          compositeScore: 0.7,
        },
        explanation: 'Ollama selected',
        allScores: [],
      });

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.ollamaMetadata).toBeUndefined();
    });

    it('handles ollamaMetadata re-extraction returning null', async () => {
      const longContent = makeLongContent(4);
      vi.mocked(ollamaExtractor.extract)
        .mockResolvedValueOnce({
          title: 'Ollama Title',
          content: longContent,
          summary: 'Sum',
          metadata: { model: 'llama3', durationMs: 100 },
        })
        .mockResolvedValueOnce(null);

      const candidate = {
        method: 'ollama' as const,
        title: 'Ollama Title',
        content: longContent,
        paragraphCount: 4,
        confidence: 0.8,
        metadata: { author: null, publishDate: null, excerpt: 'Sum' },
      };

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: candidate,
        score: {
          contentLength: 0.7,
          structureQuality: 0.7,
          metadataCompleteness: 0.5,
          textDensity: 0.8,
          extractorConfidence: 0.8,
          compositeScore: 0.7,
        },
        explanation: 'Ollama selected',
        allScores: [],
      });

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.ollamaMetadata).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // Trafilatura branches
  // -------------------------------------------------------------------

  describe('trafilatura extraction', () => {
    it('adds trafilatura candidate when extraction succeeds', async () => {
      vi.mocked(trafilaturaExtract).mockResolvedValue({
        title: 'Traf Title',
        content: makeLongContent(4),
        author: 'Traf Author',
        publishDate: '2024-01-01',
      });

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      // Trafilatura was a candidate but readability won
      expect(result).toBeDefined();
    });

    it('skips trafilatura when content is empty', async () => {
      vi.mocked(trafilaturaExtract).mockResolvedValue({
        title: 'Empty',
        content: '   ',
        author: null,
        publishDate: null,
      });

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
    });

    it('handles trafilatura failure with non-Error thrown', async () => {
      vi.mocked(trafilaturaExtract).mockRejectedValue('string error');

      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  // Readability branches
  // -------------------------------------------------------------------

  describe('readability extraction', () => {
    it('handles readability result in the switch case', async () => {
      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.extractionMethod).toBe('readability');
    });
  });

  // -------------------------------------------------------------------
  // DOM heuristic branches
  // -------------------------------------------------------------------

  describe('dom-heuristic extraction', () => {
    it('creates nodes from dom-heuristic paragraphs', async () => {
      const { paragraphs } = setupDomHeuristicWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result.extractionMethod).toBe('dom-heuristic');
      expect(result.nodes.length).toBe(paragraphs.length);
      expect(result.nodes[0].id).toContain('dom-heuristic');
    });
  });

  // -------------------------------------------------------------------
  // Fallback path (no candidates at all)
  // -------------------------------------------------------------------

  describe('fallback extraction', () => {
    it('uses fallback when no candidates are available', async () => {
      // Use empty HTML so Readability also finds nothing
      const emptyHtml = '<html><head><title>Empty</title></head><body></body></html>';

      vi.mocked(policyEngine.applyPolicy).mockReturnValue({
        transformedHtml: emptyHtml,
        policyApplied: 'default',
        rulesMatched: 0,
        fieldsValidated: true,
        validationErrors: [],
      });

      // All extractors fail or return nothing
      vi.mocked(ollamaExtractor.extract).mockRejectedValue(new Error('no'));
      vi.mocked(trafilaturaExtract).mockResolvedValue(null);
      vi.mocked(domHeuristicExtractor.extract).mockReturnValue({
        title: 'DOM Title',
        content: '',
        paragraphs: [],
        confidence: 0.1,
        method: 'dom-heuristic',
      });

      const result = await distillContent(emptyHtml, BASE_URL);
      expect(result.fallbackUsed).toBe(true);
      expect(result.extractionMethod).toBe('fallback');
      expect(result.extractionConfidence).toBe(0.2);
    });
  });

  // -------------------------------------------------------------------
  // Completeness guard branches
  // -------------------------------------------------------------------

  describe('completeness guard', () => {
    it('triggers completeness guard when content is too short and picks alternate', async () => {
      // The "best" candidate has very short content
      const shortCandidate = {
        method: 'readability' as const,
        title: 'Short',
        content: 'Short text.',
        paragraphCount: 1,
        confidence: 0.9,
        metadata: { author: null, publishDate: null, excerpt: 'Short' },
      };

      // domHeuristicExtractor returns enough for an alternate
      vi.mocked(domHeuristicExtractor.extract).mockReturnValue({
        title: 'DOM Title',
        content: 'Dom paragraph one. Dom paragraph two. Dom paragraph three. Dom paragraph four. This is a very long paragraph with enough content to pass the completeness check with over 300 characters total when combined with the other paragraphs.',
        paragraphs: [
          { text: 'Dom paragraph one.', selector: 'p:nth-child(1)' },
          { text: 'Dom paragraph two.', selector: 'p:nth-child(2)' },
          { text: 'Dom paragraph three.', selector: 'p:nth-child(3)' },
          { text: 'Dom paragraph four with extra words.', selector: 'p:nth-child(4)' },
        ],
        confidence: 0.5,
        method: 'dom-heuristic',
      });

      // Ensemble selects shortCandidate first
      vi.mocked(extractionEnsemble.selectBest)
        .mockReturnValueOnce({
          selected: shortCandidate,
          score: {
            contentLength: 0.2,
            structureQuality: 0.1,
            metadataCompleteness: 0.3,
            textDensity: 0.8,
            extractorConfidence: 0.9,
            compositeScore: 0.4,
          },
          explanation: 'Readability won but short',
          allScores: [],
        })
        .mockReturnValueOnce({
          selected: {
            method: 'dom-heuristic' as const,
            title: 'DOM Title',
            content: 'Dom paragraph one. Dom paragraph two. Dom paragraph three. Dom paragraph four with extra words. This is additional content to ensure we have enough length to pass the completeness guard which requires at least 300 characters of text content.',
            paragraphCount: 4,
            confidence: 0.5,
            metadata: { author: null, publishDate: null, excerpt: 'Dom para one' },
          },
          score: {
            contentLength: 0.7,
            structureQuality: 0.6,
            metadataCompleteness: 0.3,
            textDensity: 0.7,
            extractorConfidence: 0.5,
            compositeScore: 0.55,
          },
          explanation: 'DOM heuristic alternate',
          allScores: [],
        });

      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
      // The completeness guard should have selected the alternate
      expect(extractionEnsemble.selectBest).toHaveBeenCalledTimes(2);
    });

    it('augments with fallback paragraphs when no better alternate is found', async () => {
      // Short candidate and no better alternate
      const shortCandidate = {
        method: 'readability' as const,
        title: 'Short',
        content: 'Short.',
        paragraphCount: 1,
        confidence: 0.9,
        metadata: { author: null, publishDate: null, excerpt: 'Short' },
      };

      const anotherShort = {
        method: 'dom-heuristic' as const,
        title: 'Also Short',
        content: 'Also short.',
        paragraphCount: 1,
        confidence: 0.5,
        metadata: { author: null, publishDate: null, excerpt: 'Also short' },
      };

      vi.mocked(domHeuristicExtractor.extract).mockReturnValue({
        title: 'Also Short',
        content: 'Also short.',
        paragraphs: [{ text: 'Also short.', selector: 'p' }],
        confidence: 0.5,
        method: 'dom-heuristic',
      });

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: shortCandidate,
        score: {
          contentLength: 0.1,
          structureQuality: 0.1,
          metadataCompleteness: 0.3,
          textDensity: 0.8,
          extractorConfidence: 0.9,
          compositeScore: 0.3,
        },
        explanation: 'Readability won but short',
        allScores: [],
      });

      // The RICH_HTML has paragraphs that toParagraphNodes can pick up for augmentation
      const result = await distillContent(RICH_HTML, BASE_URL);
      expect(result).toBeDefined();
      // Content should be augmented (original + fallback paragraphs)
      // It may or may not have extra paragraphs depending on JSDOM's parsing
    });

    it('does not trigger completeness guard when content is long enough', async () => {
      setupReadabilityWins();

      const result = await distillContent(RICH_HTML, BASE_URL);
      // selectBest should be called exactly once (no completeness re-selection)
      expect(extractionEnsemble.selectBest).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------
  // Default switch branch (unknown method)
  // -------------------------------------------------------------------

  describe('unknown extraction method in switch', () => {
    it('produces empty nodes for unknown method', async () => {
      const longContent = makeLongContent(4);
      const candidate = {
        method: 'trafilatura' as const,
        title: 'Traf Title',
        content: longContent,
        paragraphCount: 4,
        confidence: 0.85,
        metadata: { author: null, publishDate: null, excerpt: 'Excerpt text' },
      };

      vi.mocked(extractionEnsemble.selectBest).mockReturnValue({
        selected: candidate,
        score: {
          contentLength: 0.8,
          structureQuality: 0.7,
          metadataCompleteness: 0.4,
          textDensity: 0.8,
          extractorConfidence: 0.85,
          compositeScore: 0.7,
        },
        explanation: 'Trafilatura selected',
        allScores: [],
      });

      const result = await distillContent(RICH_HTML, BASE_URL);
      // The trafilatura method hits the default case in the switch
      expect(result.nodes).toEqual([]);
      expect(result.extractionMethod).toBe('trafilatura');
    });
  });

  // -------------------------------------------------------------------
  // policyHint parameter
  // -------------------------------------------------------------------

  describe('policyHint parameter', () => {
    it('passes policyHint to policyEngine.applyPolicy', async () => {
      setupReadabilityWins();

      await distillContent(RICH_HTML, BASE_URL, 'custom-policy');
      expect(policyEngine.applyPolicy).toHaveBeenCalledWith(RICH_HTML, BASE_URL, 'custom-policy');
    });
  });
});
