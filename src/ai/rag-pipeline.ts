import type { MemoryStore } from './memory';
import type { SemanticSearchService } from './semantic-search';
import type { Summarizer, SummaryLevel } from './summarizer';
import { analyzePromptSafety, type PromptSafetyResult, type PromptThreat } from './prompt-safety';

export interface RAGRequest {
  query: string;
  sessionId?: string;
  topK?: number;
  summaryLevels?: SummaryLevel[];
  minScore?: number;

  /** Whether to include safety guardrail checks (default: true) */
  enableSafety?: boolean;
}

export interface RAGCitation {
  id: string;
  score: number;
  url?: string;
  excerpt?: string;
}

export interface SafetyGuardrail {
  /** Query safety analysis */
  querySafety: PromptSafetyResult;

  /** Safety analysis for each retrieved document */
  contentSafety: Array<{
    documentId: string;
    threats: PromptThreat[];
    safe: boolean;
  }>;

  /** Overall safety verdict */
  overallSafe: boolean;

  /** Warning message if threats detected */
  warning?: string;
}

export interface RAGResponse {
  answer: string;
  citations: RAGCitation[];
  summaries: Record<SummaryLevel, string>;

  /** Safety guardrail metadata */
  safety?: SafetyGuardrail;
}

export class RAGPipeline {
  constructor(
    private readonly search: SemanticSearchService,
    private readonly summarizer: Summarizer,
    private readonly memory: MemoryStore
  ) {}

  async run(request: RAGRequest): Promise<RAGResponse> {
    const { query, topK = 3, summaryLevels = ['headline', 'paragraph'], minScore, enableSafety = true } = request;

    // Step 1: Analyze query safety
    let safety: SafetyGuardrail | undefined;
    let safeQuery = query;

    if (enableSafety) {
      const querySafety = analyzePromptSafety(query);
      safeQuery = querySafety.sanitized; // Use sanitized version for search

      // Initialize safety metadata
      safety = {
        querySafety,
        contentSafety: [],
        overallSafe: querySafety.safe,
        warning: undefined
      };

      // If query has high-risk threats, add warning
      if (!querySafety.safe) {
        safety.warning = `Query contains potential prompt injection (Risk: ${querySafety.riskLevel})`;
      }
    }

    // Step 2: Perform semantic search
    const results = await this.search.search(safeQuery, { k: topK, minScore });

    // Step 3: Analyze content safety
    const safeResults = results.map((result) => {
      if (!enableSafety || !result.content) {
        return { result, safety: null };
      }

      const contentSafety = analyzePromptSafety(result.content);

      // Track threats in safety metadata
      safety!.contentSafety.push({
        documentId: result.id,
        threats: contentSafety.threats,
        safe: contentSafety.safe
      });

      // If content unsafe, update overall verdict
      if (!contentSafety.safe) {
        safety!.overallSafe = false;
        if (!safety!.warning) {
          safety!.warning = 'Retrieved content contains potential threats';
        } else {
          safety!.warning += '; Retrieved content contains potential threats';
        }
      }

      // Return result with sanitized content
      return {
        result: {
          ...result,
          content: contentSafety.sanitized
        },
        safety: contentSafety
      };
    });

    // Step 4: Build context from sanitized content
    const contextText = safeResults
      .map(({ result }, index) => `Source ${index + 1}: ${result.content ?? ''}`)
      .join('\n');

    // Step 5: Generate summaries and answer
    const summaries = await this.generateSummaries(summaryLevels, contextText);
    const answer = this.generateAnswer(query, contextText, summaries.paragraph ?? summaries.headline ?? '');
    const citations = safeResults.map(({ result }) => ({
      id: result.id,
      score: result.score,
      url: typeof result.metadata?.url === 'string' ? (result.metadata.url as string) : undefined,
      excerpt: (result.content ?? '').slice(0, 200)
    }));

    // Step 6: Save to memory
    if (request.sessionId) {
      await this.memory.addEntry({
        sessionId: request.sessionId,
        type: 'summary',
        content: answer,
        metadata: { query, citations, safety },
        createdAt: Date.now()
      });
    }

    return {
      answer,
      citations,
      summaries,
      safety: enableSafety ? safety : undefined
    };
  }

  private async generateSummaries(levels: SummaryLevel[], context: string): Promise<Record<SummaryLevel, string>> {
    if (levels.length === 0) {
      return {} as Record<SummaryLevel, string>;
    }
    const requests = levels.map((level) => ({ level, content: context }));
    const responses = await this.summarizer.generateSummaries(requests);
    return responses.reduce<Record<SummaryLevel, string>>((acc, summary) => {
      acc[summary.level] = summary.text;
      return acc;
    }, {} as Record<SummaryLevel, string>);
  }

  private generateAnswer(query: string, context: string, summary: string): string {
    if (!context.trim()) {
      return `No relevant context found for: ${query}`;
    }
    const trimmedSummary = summary.trim() || context.slice(0, 200);
    return `${trimmedSummary}\n\nBased on the retrieved context, Anno identified ${this.countSentences(
      trimmedSummary
    )} key sentence(s) related to "${query}".`;
  }

  private countSentences(text: string): number {
    return text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0).length;
  }
}
