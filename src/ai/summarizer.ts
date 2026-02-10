export type SummaryLevel = 'headline' | 'paragraph' | 'detailed';

export interface SummaryRequest {
  level: SummaryLevel;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SummaryResponse {
  level: SummaryLevel;
  text: string;
  tokensUsed?: number;
  confidence?: number;
}

export interface Summarizer {
  generateSummaries(requests: SummaryRequest[]): Promise<SummaryResponse[]>;
}

/**
 * Placeholder summarizer for development and tests. Produces heuristic summaries
 * derived from the original text without calling an external LLM.
 */
export class HeuristicSummarizer implements Summarizer {
  async generateSummaries(requests: SummaryRequest[]): Promise<SummaryResponse[]> {
    return requests.map(({ level, content }) => ({
      level,
      text: this.generate(level, content),
      confidence: 0.4 // Conservative until LLM integration is wired in
    }));
  }

  private generate(level: SummaryLevel, content: string): string {
    const sentences = this.splitSentences(content);
    switch (level) {
      case 'headline':
        return sentences[0]?.slice(0, 120) ?? content.slice(0, 120);
      case 'paragraph':
        return sentences.slice(0, 3).join(' ');
      case 'detailed':
      default:
        return content.length > 800 ? `${content.slice(0, 800)}…` : content;
    }
  }

  private splitSentences(text: string): string[] {
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.trim().length > 0);
  }
}
