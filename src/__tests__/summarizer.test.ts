import { describe, it, expect } from 'vitest';
import { HeuristicSummarizer } from '../ai/summarizer';

const ARTICLE = `Anno continues to push the boundaries of AI-native browsing. ` +
  `By combining deterministic extraction with language models, the system ` +
  `delivers concise, trustworthy summaries for agents.`;

const summarizer = new HeuristicSummarizer();

describe('HeuristicSummarizer', () => {
  it('produces headline summary', async () => {
    const [summary] = await summarizer.generateSummaries([{ level: 'headline', content: ARTICLE }]);
    expect(summary.level).toBe('headline');
    expect(summary.text.length).toBeGreaterThan(0);
    expect(summary.text.length).toBeLessThanOrEqual(120);
  });

  it('produces paragraph summary with multiple sentences', async () => {
    const [summary] = await summarizer.generateSummaries([{ level: 'paragraph', content: ARTICLE }]);
    expect(summary.level).toBe('paragraph');
    expect(summary.text.split('.').length).toBeGreaterThanOrEqual(2);
  });
});
