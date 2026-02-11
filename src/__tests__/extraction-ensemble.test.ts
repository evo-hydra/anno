import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ExtractionEnsemble,
  extractionEnsemble,
  type ExtractionCandidate,
} from '../core/extraction-ensemble';

// ---------------------------------------------------------------------------
// Prevent any real network calls
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
// Shared fixtures
// ---------------------------------------------------------------------------

const makeCandidate = (overrides: Partial<ExtractionCandidate> = {}): ExtractionCandidate => ({
  method: 'readability',
  title: 'Test Article Title That Is Long Enough',
  content: 'This is a test article with substantial content. '.repeat(20),
  paragraphCount: 5,
  confidence: 0.9,
  metadata: {
    author: 'Test Author',
    publishDate: '2024-01-15',
    excerpt: 'This is a test excerpt'
  },
  ...overrides
});

const shortCandidate = makeCandidate({
  method: 'dom-heuristic',
  content: 'Short.',
  paragraphCount: 1,
  confidence: 0.3,
  metadata: { author: null, publishDate: null, excerpt: null }
});

const emptyCandidate = makeCandidate({
  method: 'dom-heuristic',
  title: '',
  content: '',
  paragraphCount: 0,
  confidence: 0.1,
  metadata: { author: null, publishDate: null, excerpt: null }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExtractionEnsemble', () => {
  describe('scoreCandidate', () => {
    it('returns a score with all required dimensions', () => {
      const candidate = makeCandidate();
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(typeof score.contentLength).toBe('number');
      expect(typeof score.structureQuality).toBe('number');
      expect(typeof score.metadataCompleteness).toBe('number');
      expect(typeof score.textDensity).toBe('number');
      expect(typeof score.extractorConfidence).toBe('number');
      expect(typeof score.compositeScore).toBe('number');
    });

    it('all dimensions are between 0 and 1', () => {
      const candidate = makeCandidate();
      const score = extractionEnsemble.scoreCandidate(candidate);

      for (const key of [
        'contentLength',
        'structureQuality',
        'metadataCompleteness',
        'textDensity',
        'extractorConfidence',
        'compositeScore'
      ] as const) {
        expect(score[key]).toBeGreaterThanOrEqual(0);
        expect(score[key]).toBeLessThanOrEqual(1);
      }
    });

    it('scores high-quality content higher than poor content', () => {
      const good = makeCandidate();
      const bad = makeCandidate({
        content: 'x',
        paragraphCount: 0,
        confidence: 0.1,
        title: 'ab',
        metadata: { author: null, publishDate: null, excerpt: null }
      });

      const goodScore = extractionEnsemble.scoreCandidate(good);
      const badScore = extractionEnsemble.scoreCandidate(bad);

      expect(goodScore.compositeScore).toBeGreaterThan(badScore.compositeScore);
    });

    it('uses default confidence of 0.5 when none provided', () => {
      const candidate = makeCandidate({ confidence: undefined });
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(score.extractorConfidence).toBe(0.5);
    });

    it('scores content in sweet spot (300-3000 chars) as 1.0 for contentLength', () => {
      const candidate = makeCandidate({
        content: 'Word '.repeat(100) // ~500 chars, in sweet spot
      });
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(score.contentLength).toBe(1.0);
    });

    it('penalizes very short content', () => {
      const candidate = makeCandidate({
        content: 'Tiny.'
      });
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(score.contentLength).toBeLessThan(0.5);
    });

    it('scores good paragraph count (3-20) as 1.0 for structureQuality', () => {
      const candidate = makeCandidate({ paragraphCount: 10 });
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(score.structureQuality).toBe(1.0);
    });

    it('penalizes zero paragraph count', () => {
      const candidate = makeCandidate({ paragraphCount: 0 });
      const score = extractionEnsemble.scoreCandidate(candidate);

      expect(score.structureQuality).toBe(0.1);
    });

    it('scores complete metadata higher', () => {
      const withMeta = makeCandidate({
        title: 'A Proper Long Title',
        metadata: { author: 'Alice', publishDate: '2024-01-01', excerpt: 'An excerpt' }
      });
      const withoutMeta = makeCandidate({
        title: 'ab',
        metadata: { author: null, publishDate: null, excerpt: null }
      });

      const scoreWith = extractionEnsemble.scoreCandidate(withMeta);
      const scoreWithout = extractionEnsemble.scoreCandidate(withoutMeta);

      expect(scoreWith.metadataCompleteness).toBeGreaterThan(scoreWithout.metadataCompleteness);
    });
  });

  describe('selectBest', () => {
    it('returns a result for valid candidates', () => {
      const candidates = [makeCandidate()];
      const result = extractionEnsemble.selectBest(candidates);

      expect(result).toBeDefined();
      expect(result.selected).toBe(candidates[0]);
      expect(result.score).toBeDefined();
      expect(typeof result.explanation).toBe('string');
      expect(result.allScores).toHaveLength(1);
    });

    it('selects best extractor based on scoring', () => {
      const good = makeCandidate({
        method: 'readability',
        confidence: 0.95,
        paragraphCount: 10
      });
      const bad = makeCandidate({
        method: 'dom-heuristic',
        content: 'Short content',
        paragraphCount: 1,
        confidence: 0.2,
        title: 'ab',
        metadata: { author: null, publishDate: null, excerpt: null }
      });

      const result = extractionEnsemble.selectBest([good, bad]);

      expect(result.selected.method).toBe('readability');
      expect(result.allScores).toHaveLength(2);
    });

    it('handles empty HTML / zero content candidate', () => {
      const result = extractionEnsemble.selectBest([emptyCandidate]);

      expect(result).toBeDefined();
      expect(result.selected).toBe(emptyCandidate);
      expect(result.score.compositeScore).toBeLessThan(0.5);
    });

    it('handles single candidate with minimal content', () => {
      const result = extractionEnsemble.selectBest([shortCandidate]);

      expect(result).toBeDefined();
      expect(result.selected).toBe(shortCandidate);
      expect(typeof result.explanation).toBe('string');
    });

    it('throws when given empty array', () => {
      expect(() => extractionEnsemble.selectBest([])).toThrow('No candidates to select from');
    });

    it('returns extraction method name in the selection', () => {
      const candidates = [
        makeCandidate({ method: 'readability' }),
        makeCandidate({ method: 'dom-heuristic', confidence: 0.3, content: 'short' })
      ];

      const result = extractionEnsemble.selectBest(candidates);

      expect(['readability', 'dom-heuristic']).toContain(result.selected.method);
      expect(result.explanation).toContain(result.selected.method);
    });

    it('returns confidence in the score', () => {
      const result = extractionEnsemble.selectBest([makeCandidate({ confidence: 0.85 })]);

      expect(result.score.extractorConfidence).toBe(0.85);
    });

    it('allScores includes scores for every candidate', () => {
      const c1 = makeCandidate({ method: 'readability' });
      const c2 = makeCandidate({ method: 'dom-heuristic', confidence: 0.5 });
      const c3 = makeCandidate({ method: 'ollama', confidence: 0.8 });

      const result = extractionEnsemble.selectBest([c1, c2, c3]);

      expect(result.allScores).toHaveLength(3);
      const methods = result.allScores.map((s) => s.method);
      expect(methods).toContain('readability');
      expect(methods).toContain('dom-heuristic');
      expect(methods).toContain('ollama');
    });

    it('selects candidate with better metadata when content is similar', () => {
      const withMeta = makeCandidate({
        method: 'readability',
        confidence: 0.85,
        metadata: { author: 'Alice', publishDate: '2024-01-15', excerpt: 'Good excerpt' }
      });
      const withoutMeta = makeCandidate({
        method: 'dom-heuristic',
        confidence: 0.85,
        metadata: { author: null, publishDate: null, excerpt: null }
      });

      const result = extractionEnsemble.selectBest([withMeta, withoutMeta]);

      // The candidate with metadata should score higher overall
      const readabilityScore = result.allScores.find((s) => s.method === 'readability');
      const domScore = result.allScores.find((s) => s.method === 'dom-heuristic');

      expect(readabilityScore!.score.metadataCompleteness).toBeGreaterThan(
        domScore!.score.metadataCompleteness
      );
    });

    it('explanation mentions "significantly better" for large score gaps', () => {
      const good = makeCandidate({
        method: 'readability',
        confidence: 0.95,
        paragraphCount: 10,
        metadata: { author: 'Author', publishDate: '2024-01-01', excerpt: 'Long excerpt text' }
      });
      const terrible = makeCandidate({
        method: 'dom-heuristic',
        content: 'x',
        paragraphCount: 0,
        confidence: 0.1,
        title: '',
        metadata: { author: null, publishDate: null, excerpt: null }
      });

      const result = extractionEnsemble.selectBest([good, terrible]);

      // The score gap should be large enough to trigger "significantly better"
      const gap =
        result.allScores.find((s) => s.method === 'readability')!.score.compositeScore -
        result.allScores.find((s) => s.method === 'dom-heuristic')!.score.compositeScore;

      if (gap > 0.2) {
        expect(result.explanation).toContain('significantly better');
      }
    });
  });

  describe('ExtractionEnsemble class constructor', () => {
    it('can be instantiated independently of the singleton', () => {
      const instance = new ExtractionEnsemble();
      const score = instance.scoreCandidate(makeCandidate());

      expect(score.compositeScore).toBeGreaterThan(0);
    });
  });
});
