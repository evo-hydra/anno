import { describe, it, expect } from 'vitest';
import { HeuristicSummarizer, type SummaryRequest } from '../ai/summarizer';

const summarizer = new HeuristicSummarizer();

// Helper to generate text of a given approximate length
function makeText(charCount: number): string {
  const sentence = 'This is a sample sentence for testing summarization. ';
  const repetitions = Math.ceil(charCount / sentence.length);
  return sentence.repeat(repetitions).slice(0, charCount);
}

describe('HeuristicSummarizer — full branch coverage', () => {
  // -------------------------------------------------------------------
  // headline level
  // -------------------------------------------------------------------

  describe('headline level', () => {
    it('returns first sentence truncated to 120 chars when sentence exists', async () => {
      const content = 'This is the first sentence. This is the second sentence. And a third one.';
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content }]);

      expect(result.level).toBe('headline');
      expect(result.text).toBe('This is the first sentence.');
      expect(result.text.length).toBeLessThanOrEqual(120);
      expect(result.confidence).toBe(0.4);
    });

    it('truncates first sentence at 120 chars when it is very long', async () => {
      const longSentence = 'A'.repeat(200) + '.';
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content: longSentence }]);

      expect(result.text.length).toBe(120);
      expect(result.text).toBe('A'.repeat(120));
    });

    it('falls back to content.slice(0, 120) when no sentences are found', async () => {
      // Content with no sentence-ending punctuation
      const content = 'No sentence ending punctuation here at all just a long run-on text';
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content }]);

      expect(result.level).toBe('headline');
      expect(result.text).toBe(content.slice(0, 120));
    });

    it('falls back to content.slice when content is only whitespace (no valid sentences)', async () => {
      // After splitting, all results are empty (whitespace only)
      const content = '     ';
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content }]);

      // splitSentences filters out empty trims, so sentences[0] is undefined → fallback
      expect(result.level).toBe('headline');
      expect(result.text.length).toBeLessThanOrEqual(120);
    });

    it('handles empty string content', async () => {
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content: '' }]);

      expect(result.level).toBe('headline');
      expect(result.text).toBe('');
    });
  });

  // -------------------------------------------------------------------
  // paragraph level
  // -------------------------------------------------------------------

  describe('paragraph level', () => {
    it('returns up to 3 sentences joined', async () => {
      const content = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      expect(result.level).toBe('paragraph');
      // Should have first 3 sentences
      expect(result.text).toContain('First sentence.');
      expect(result.text).toContain('Second sentence.');
      expect(result.text).toContain('Third sentence.');
      expect(result.text).not.toContain('Fourth sentence.');
    });

    it('returns all sentences when fewer than 3 exist', async () => {
      const content = 'Only one sentence.';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      expect(result.level).toBe('paragraph');
      expect(result.text).toBe('Only one sentence.');
    });

    it('handles content with no sentence boundaries', async () => {
      const content = 'No punctuation ending';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      expect(result.level).toBe('paragraph');
      expect(result.text).toBe('No punctuation ending');
    });
  });

  // -------------------------------------------------------------------
  // detailed level
  // -------------------------------------------------------------------

  describe('detailed level', () => {
    it('returns full content when under 800 chars', async () => {
      const content = 'Short detailed content. Multiple sentences. Under the threshold.';
      const [result] = await summarizer.generateSummaries([{ level: 'detailed', content }]);

      expect(result.level).toBe('detailed');
      expect(result.text).toBe(content);
    });

    it('truncates content at 800 chars with ellipsis when over 800', async () => {
      const content = makeText(1200);
      const [result] = await summarizer.generateSummaries([{ level: 'detailed', content }]);

      expect(result.level).toBe('detailed');
      expect(result.text.length).toBe(801); // 800 chars + '…'
      expect(result.text.endsWith('…')).toBe(true);
      expect(result.text.slice(0, 800)).toBe(content.slice(0, 800));
    });

    it('returns exactly 800 chars content without truncation', async () => {
      const content = 'X'.repeat(800);
      const [result] = await summarizer.generateSummaries([{ level: 'detailed', content }]);

      expect(result.level).toBe('detailed');
      expect(result.text).toBe(content);
    });

    it('truncates at 801 chars of content', async () => {
      const content = 'Y'.repeat(801);
      const [result] = await summarizer.generateSummaries([{ level: 'detailed', content }]);

      expect(result.text).toBe('Y'.repeat(800) + '…');
    });
  });

  // -------------------------------------------------------------------
  // Multiple requests in a single batch
  // -------------------------------------------------------------------

  describe('batch processing', () => {
    it('processes multiple requests and returns matching results', async () => {
      const requests: SummaryRequest[] = [
        { level: 'headline', content: 'Headline content. More text.' },
        { level: 'paragraph', content: 'Para one. Para two. Para three. Para four.' },
        { level: 'detailed', content: makeText(1000) },
      ];

      const results = await summarizer.generateSummaries(requests);

      expect(results.length).toBe(3);
      expect(results[0].level).toBe('headline');
      expect(results[1].level).toBe('paragraph');
      expect(results[2].level).toBe('detailed');

      // All should have confidence 0.4
      for (const r of results) {
        expect(r.confidence).toBe(0.4);
      }
    });

    it('handles empty request array', async () => {
      const results = await summarizer.generateSummaries([]);
      expect(results).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // Whitespace normalization in splitSentences
  // -------------------------------------------------------------------

  describe('sentence splitting', () => {
    it('normalizes multiple whitespace to single spaces', async () => {
      const content = 'First   sentence.   Second    sentence.   Third.';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      // Whitespace should be collapsed
      expect(result.text).not.toContain('  ');
      expect(result.text).toContain('First sentence.');
    });

    it('handles newlines and tabs in content', async () => {
      const content = 'First sentence.\n\nSecond sentence.\tThird sentence.';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      expect(result.text).toContain('First sentence.');
      expect(result.text).toContain('Second sentence.');
    });

    it('splits on exclamation marks', async () => {
      const content = 'Wow! Amazing! Incredible! Unbelievable!';
      const [result] = await summarizer.generateSummaries([{ level: 'paragraph', content }]);

      // Should take first 3
      expect(result.text).toContain('Wow!');
      expect(result.text).toContain('Amazing!');
      expect(result.text).toContain('Incredible!');
      expect(result.text).not.toContain('Unbelievable!');
    });

    it('splits on question marks', async () => {
      const content = 'Is this good? Does it work? Are we done? Almost?';
      const [result] = await summarizer.generateSummaries([{ level: 'headline', content }]);

      expect(result.text).toBe('Is this good?');
    });
  });

  // -------------------------------------------------------------------
  // metadata parameter (ignored by heuristic but should not crash)
  // -------------------------------------------------------------------

  describe('metadata passthrough', () => {
    it('accepts metadata without crashing', async () => {
      const [result] = await summarizer.generateSummaries([{
        level: 'headline',
        content: 'Some content. With sentences.',
        metadata: { source: 'test', importance: 5 },
      }]);

      expect(result.level).toBe('headline');
      expect(result.text.length).toBeGreaterThan(0);
    });
  });
});
