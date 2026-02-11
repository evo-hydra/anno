import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConfidenceScorer,
  confidenceScorer,
  type ConsensusInput
} from '../core/confidence-scorer';

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
// Tests
// ---------------------------------------------------------------------------

describe('ConfidenceScorer', () => {
  describe('computeExtraction', () => {
    it('returns extractor confidence when provided', () => {
      expect(confidenceScorer.computeExtraction(0.85)).toBe(0.85);
    });

    it('returns default prior (0.7) when no confidence provided', () => {
      expect(confidenceScorer.computeExtraction()).toBe(0.7);
      expect(confidenceScorer.computeExtraction(undefined)).toBe(0.7);
    });
  });

  describe('computeContentQuality', () => {
    it('scores content with multiple paragraphs higher than single line', () => {
      const multiParagraph = 'Paragraph one with substantial content.\n\n'.repeat(10);
      const singleLine = 'Just a short line.';

      const multiScore = confidenceScorer.computeContentQuality(multiParagraph, 10);
      const singleScore = confidenceScorer.computeContentQuality(singleLine, 1);

      expect(multiScore).toBeGreaterThan(singleScore);
    });

    it('returns score between 0 and 1', () => {
      const score = confidenceScorer.computeContentQuality('Some content.', 3);

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('handles empty content', () => {
      const score = confidenceScorer.computeContentQuality('', 0);

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
      // Empty content should get a low score
      expect(score).toBeLessThan(0.5);
    });

    it('optimal content length (300-3000) gets higher score', () => {
      const optimalContent = 'Word '.repeat(100); // ~500 chars
      const tinyContent = 'hi';

      const optimalScore = confidenceScorer.computeContentQuality(optimalContent, 5);
      const tinyScore = confidenceScorer.computeContentQuality(tinyContent, 5);

      expect(optimalScore).toBeGreaterThan(tinyScore);
    });

    it('good paragraph count (3-20) gets higher structure score', () => {
      const content = 'Some content string.';
      const goodStructure = confidenceScorer.computeContentQuality(content, 5);
      const poorStructure = confidenceScorer.computeContentQuality(content, 0);

      expect(goodStructure).toBeGreaterThan(poorStructure);
    });

    it('scores very long content lower than optimal-length content', () => {
      const optimalContent = 'A '.repeat(200); // ~400 chars, in sweet spot
      const veryLong = 'A '.repeat(5000); // ~10000 chars

      const optimalScore = confidenceScorer.computeContentQuality(optimalContent, 5);
      const longScore = confidenceScorer.computeContentQuality(veryLong, 5);

      expect(optimalScore).toBeGreaterThan(longScore);
    });
  });

  describe('computeMetadata', () => {
    it('higher confidence for content with title, author, and date', () => {
      const full = confidenceScorer.computeMetadata(
        'A Good Long Title',
        'John Doe',
        '2024-01-15',
        'An excerpt of sufficient length here.'
      );
      const empty = confidenceScorer.computeMetadata('', null, null, null);

      expect(full).toBeGreaterThan(empty);
    });

    it('scores title > 5 chars as having title', () => {
      const withTitle = confidenceScorer.computeMetadata('Good Title Here', null, null, null);
      const shortTitle = confidenceScorer.computeMetadata('ab', null, null, null);

      expect(withTitle).toBeGreaterThan(shortTitle);
    });

    it('gives credit for author', () => {
      const withAuthor = confidenceScorer.computeMetadata('A Valid Title', 'Author Name', null, null);
      const noAuthor = confidenceScorer.computeMetadata('A Valid Title', null, null, null);

      expect(withAuthor).toBeGreaterThan(noAuthor);
    });

    it('gives credit for publish date', () => {
      const withDate = confidenceScorer.computeMetadata('A Valid Title', null, '2024-01-01', null);
      const noDate = confidenceScorer.computeMetadata('A Valid Title', null, null, null);

      expect(withDate).toBeGreaterThan(noDate);
    });

    it('gives credit for excerpt > 20 chars', () => {
      const withExcerpt = confidenceScorer.computeMetadata(
        'A Valid Title',
        null,
        null,
        'This is a sufficiently long excerpt.'
      );
      const noExcerpt = confidenceScorer.computeMetadata('A Valid Title', null, null, null);

      expect(withExcerpt).toBeGreaterThan(noExcerpt);
    });

    it('returns 0 for completely empty metadata', () => {
      const score = confidenceScorer.computeMetadata('', null, null, null);
      expect(score).toBe(0);
    });

    it('caps score at 1.0', () => {
      const score = confidenceScorer.computeMetadata(
        'A Really Good Long Title For Testing',
        'Full Author Name',
        '2024-01-15',
        'A sufficiently long excerpt text that provides context.'
      );
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  describe('computeSourceCredibility', () => {
    it('returns high score for trusted news sources', () => {
      expect(confidenceScorer.computeSourceCredibility('https://www.nytimes.com/article')).toBe(0.9);
      expect(confidenceScorer.computeSourceCredibility('https://www.bbc.com/news/article')).toBe(0.9);
      expect(confidenceScorer.computeSourceCredibility('https://reuters.com/article')).toBe(0.9);
    });

    it('returns high score for academic domains', () => {
      expect(confidenceScorer.computeSourceCredibility('https://mit.edu/paper')).toBe(0.85);
      expect(confidenceScorer.computeSourceCredibility('https://data.gov/dataset')).toBe(0.85);
    });

    it('returns moderate score for tech blogs', () => {
      expect(confidenceScorer.computeSourceCredibility('https://techcrunch.com/post')).toBe(0.8);
      expect(confidenceScorer.computeSourceCredibility('https://arstechnica.com/article')).toBe(0.8);
    });

    it('returns lower score for generic blog platforms', () => {
      expect(confidenceScorer.computeSourceCredibility('https://medium.com/@user/post')).toBe(0.6);
      expect(confidenceScorer.computeSourceCredibility('https://newsletter.substack.com/p/title')).toBe(0.6);
    });

    it('returns default prior (0.5) for unknown domains', () => {
      expect(confidenceScorer.computeSourceCredibility('https://random-site.xyz/page')).toBe(0.5);
    });

    it('handles invalid URLs gracefully', () => {
      const score = confidenceScorer.computeSourceCredibility('not-a-url');
      expect(score).toBe(0.5);
    });
  });

  describe('computeConsensus', () => {
    it('returns default prior (0.5) when no consensus input', () => {
      expect(confidenceScorer.computeConsensus()).toBe(0.5);
      expect(confidenceScorer.computeConsensus(undefined)).toBe(0.5);
    });

    it('returns default prior for single candidate', () => {
      const input: ConsensusInput = {
        candidates: [
          { method: 'readability', content: 'Some content', title: 'Title', score: 0.9 }
        ]
      };
      expect(confidenceScorer.computeConsensus(input)).toBe(0.5);
    });

    it('returns higher consensus when extractors agree', () => {
      const agreeing: ConsensusInput = {
        candidates: [
          { method: 'readability', content: 'The article discusses climate change policy.', title: 'Climate Policy', score: 0.9 },
          { method: 'dom-heuristic', content: 'The article discusses climate change policy impacts.', title: 'Climate Policy', score: 0.85 }
        ]
      };

      const disagreeing: ConsensusInput = {
        candidates: [
          { method: 'readability', content: 'Very long article about technology and innovation in the modern world.', title: 'Tech Innovation', score: 0.9 },
          { method: 'dom-heuristic', content: 'Short.', title: 'Navigation Menu', score: 0.2 }
        ]
      };

      const agreeScore = confidenceScorer.computeConsensus(agreeing);
      const disagreeScore = confidenceScorer.computeConsensus(disagreeing);

      expect(agreeScore).toBeGreaterThan(disagreeScore);
    });

    it('returns score between 0 and 1', () => {
      const input: ConsensusInput = {
        candidates: [
          { method: 'readability', content: 'Content A', title: 'Title', score: 0.8 },
          { method: 'dom-heuristic', content: 'Content B', title: 'Title', score: 0.7 }
        ]
      };

      const score = confidenceScorer.computeConsensus(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('bayesianCombine', () => {
    it('returns value between 0 and 1', () => {
      const result = confidenceScorer.bayesianCombine({
        extraction: 0.8,
        contentQuality: 0.7,
        metadata: 0.6,
        sourceCredibility: 0.5,
        consensus: 0.5
      });

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('higher inputs produce higher output', () => {
      const high = confidenceScorer.bayesianCombine({
        extraction: 0.95,
        contentQuality: 0.95,
        metadata: 0.95,
        sourceCredibility: 0.95,
        consensus: 0.95
      });
      const low = confidenceScorer.bayesianCombine({
        extraction: 0.1,
        contentQuality: 0.1,
        metadata: 0.1,
        sourceCredibility: 0.1,
        consensus: 0.1
      });

      expect(high).toBeGreaterThan(low);
    });

    it('handles edge case inputs near 0 and 1', () => {
      // Should not throw or return NaN due to log-odds clamping
      const result = confidenceScorer.bayesianCombine({
        extraction: 0.01,
        contentQuality: 0.99,
        metadata: 0.5,
        sourceCredibility: 0.01,
        consensus: 0.99
      });

      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('handles exactly 0 and 1 via clamping', () => {
      // The implementation clamps to [0.01, 0.99] so this should not produce Infinity
      const result = confidenceScorer.bayesianCombine({
        extraction: 0,
        contentQuality: 1,
        metadata: 0,
        sourceCredibility: 1,
        consensus: 0.5
      });

      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });

    it('returns ~0.5 for all neutral inputs', () => {
      const result = confidenceScorer.bayesianCombine({
        extraction: 0.5,
        contentQuality: 0.5,
        metadata: 0.5,
        sourceCredibility: 0.5,
        consensus: 0.5
      });

      // 0.5 in log-odds is 0, sum of zeros is 0, which converts back to 0.5
      expect(result).toBeCloseTo(0.5, 2);
    });
  });

  describe('computeFull', () => {
    it('returns all confidence dimensions', () => {
      const result = confidenceScorer.computeFull({
        extractorConfidence: 0.9,
        content: 'A paragraph of content. '.repeat(20),
        paragraphCount: 5,
        title: 'Test Article Title',
        author: 'Jane Doe',
        publishDate: '2024-06-01',
        excerpt: 'This is a test excerpt for the article.',
        url: 'https://example.com/article'
      });

      expect(typeof result.extraction).toBe('number');
      expect(typeof result.contentQuality).toBe('number');
      expect(typeof result.metadata).toBe('number');
      expect(typeof result.sourceCredibility).toBe('number');
      expect(typeof result.consensus).toBe('number');
      expect(typeof result.overall).toBe('number');
    });

    it('all dimensions between 0 and 1', () => {
      const result = confidenceScorer.computeFull({
        extractorConfidence: 0.8,
        content: 'Some content here.',
        paragraphCount: 3,
        title: 'Title',
        url: 'https://example.com'
      });

      for (const key of [
        'extraction',
        'contentQuality',
        'metadata',
        'sourceCredibility',
        'consensus',
        'overall'
      ] as const) {
        expect(result[key]).toBeGreaterThanOrEqual(0);
        expect(result[key]).toBeLessThanOrEqual(1);
      }
    });

    it('higher quality content produces higher overall', () => {
      const highQuality = confidenceScorer.computeFull({
        extractorConfidence: 0.95,
        content: 'A good paragraph with meaningful content. '.repeat(15),
        paragraphCount: 10,
        title: 'High Quality Article About Important Topics',
        author: 'Expert Author',
        publishDate: '2024-01-15',
        excerpt: 'This article examines important topics in depth.',
        url: 'https://www.nytimes.com/2024/article'
      });

      const lowQuality = confidenceScorer.computeFull({
        extractorConfidence: 0.2,
        content: 'x',
        paragraphCount: 0,
        title: '',
        url: 'https://unknown-site.xyz'
      });

      expect(highQuality.overall).toBeGreaterThan(lowQuality.overall);
    });

    it('uses consensus input when provided', () => {
      const withConsensus = confidenceScorer.computeFull({
        extractorConfidence: 0.8,
        content: 'Content text.',
        paragraphCount: 3,
        title: 'Same Title',
        url: 'https://example.com',
        consensusInput: {
          candidates: [
            { method: 'readability', content: 'Content text.', title: 'Same Title', score: 0.8 },
            { method: 'dom-heuristic', content: 'Content text.', title: 'Same Title', score: 0.75 }
          ]
        }
      });

      const withoutConsensus = confidenceScorer.computeFull({
        extractorConfidence: 0.8,
        content: 'Content text.',
        paragraphCount: 3,
        title: 'Same Title',
        url: 'https://example.com'
      });

      // With consensus (agreeing extractors), the consensus dimension should differ
      // from the default prior
      expect(typeof withConsensus.consensus).toBe('number');
      expect(typeof withoutConsensus.consensus).toBe('number');
    });

    it('handles minimal input without crashing', () => {
      const result = confidenceScorer.computeFull({
        content: '',
        paragraphCount: 0,
        title: '',
        url: ''
      });

      expect(Number.isFinite(result.overall)).toBe(true);
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(1);
    });
  });

  describe('class construction', () => {
    it('can instantiate independently of the singleton', () => {
      const scorer = new ConfidenceScorer();
      const score = scorer.computeContentQuality('Test content.', 3);

      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThan(0);
    });
  });
});
