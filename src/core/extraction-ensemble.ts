/**
 * Extraction Ensemble Selector
 *
 * Scores multiple extraction results and selects the best one based on:
 * - Content length (longer is better, to a point)
 * - Structure quality (clean DOM, good paragraph count)
 * - Metadata completeness (has title, author, date)
 * - Text density (text vs markup ratio)
 * - Extractor confidence (from the extractor itself)
 */

export interface ExtractionCandidate {
  method: 'ollama' | 'readability' | 'dom-heuristic' | 'trafilatura' | 'ebay-adapter';
  title: string;
  content: string;
  paragraphCount: number;
  confidence?: number;
  metadata?: {
    author?: string | null;
    publishDate?: string | null;
    excerpt?: string | null;
  };
}

export interface ExtractionScore {
  contentLength: number;        // 0-1: Longer content (300-3000 chars optimal)
  structureQuality: number;     // 0-1: Good paragraph count and structure
  metadataCompleteness: number; // 0-1: Has author, date, title
  textDensity: number;          // 0-1: High text to total ratio
  extractorConfidence: number;  // 0-1: Extractor's own confidence
  compositeScore: number;       // Weighted combination
}

export interface EnsembleSelection {
  selected: ExtractionCandidate;
  score: ExtractionScore;
  explanation: string;
  allScores: Array<{
    method: string;
    score: ExtractionScore;
  }>;
}

/**
 * Weights for composite score calculation
 */
const SCORE_WEIGHTS = {
  // Emphasize structure and metadata to improve quality win rate
  contentLength: 0.20,
  structureQuality: 0.30,
  metadataCompleteness: 0.20,
  textDensity: 0.15,
  extractorConfidence: 0.15
};

export class ExtractionEnsemble {
  /**
   * Score a single extraction candidate
   */
  scoreCandidate(candidate: ExtractionCandidate): ExtractionScore {
    const contentLength = this.scoreContentLength(candidate.content);
    const structureQuality = this.scoreStructureQuality(candidate);
    const metadataCompleteness = this.scoreMetadata(candidate);
    const textDensity = this.scoreTextDensity(candidate.content);
    const extractorConfidence = candidate.confidence ?? 0.5; // Default mid-confidence

    const compositeScore =
      contentLength * SCORE_WEIGHTS.contentLength +
      structureQuality * SCORE_WEIGHTS.structureQuality +
      metadataCompleteness * SCORE_WEIGHTS.metadataCompleteness +
      textDensity * SCORE_WEIGHTS.textDensity +
      extractorConfidence * SCORE_WEIGHTS.extractorConfidence;

    return {
      contentLength,
      structureQuality,
      metadataCompleteness,
      textDensity,
      extractorConfidence,
      compositeScore
    };
  }

  /**
   * Score content length (sweet spot: 300-3000 chars)
   */
  private scoreContentLength(content: string): number {
    const length = content.length;

    // Too short
    if (length < 100) return 0.1;
    if (length < 300) return 0.5;

    // Sweet spot
    if (length >= 300 && length <= 3000) return 1.0;

    // Too long (might include navigation, ads, etc.)
    if (length > 3000 && length <= 5000) return 0.9;
    if (length > 5000 && length <= 10000) return 0.7;

    return 0.5; // Very long content is suspicious
  }

  /**
   * Score structure quality (good paragraph distribution)
   */
  private scoreStructureQuality(candidate: ExtractionCandidate): number {
    const { paragraphCount } = candidate;

    // No paragraphs = bad
    if (paragraphCount === 0) return 0.1;

    // Good paragraph count (3-20 is typical for articles)
    if (paragraphCount >= 3 && paragraphCount <= 20) return 1.0;
    if (paragraphCount >= 2) return 0.8;
    if (paragraphCount >= 1) return 0.5;

    // Too many paragraphs might indicate poor extraction
    if (paragraphCount > 20 && paragraphCount <= 50) return 0.7;
    if (paragraphCount > 50) return 0.4;

    return 0.3;
  }

  /**
   * Score metadata completeness
   */
  private scoreMetadata(candidate: ExtractionCandidate): number {
    let score = 0;

    // Always have title
    if (candidate.title && candidate.title.length > 5) {
      score += 0.4;
    }

    // Optional metadata
    if (candidate.metadata?.author) {
      score += 0.3;
    }

    if (candidate.metadata?.publishDate) {
      score += 0.3;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Score text density (text vs whitespace/markup)
   */
  private scoreTextDensity(content: string): number {
    const totalLength = content.length;
    if (totalLength === 0) return 0;

    // Count words (better metric than characters)
    const words = content.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;

    // Calculate chars per word (higher = less dense, more markup/whitespace)
    const charsPerWord = totalLength / wordCount;

    // Ideal: 5-8 chars per word (includes spaces)
    if (charsPerWord >= 5 && charsPerWord <= 8) return 1.0;
    if (charsPerWord >= 4 && charsPerWord < 5) return 0.9;
    if (charsPerWord > 8 && charsPerWord <= 10) return 0.9;
    if (charsPerWord >= 3 && charsPerWord < 4) return 0.7;
    if (charsPerWord > 10 && charsPerWord <= 15) return 0.6;

    return 0.4; // Too sparse or too dense
  }

  /**
   * Select the best candidate from multiple options
   */
  selectBest(candidates: ExtractionCandidate[]): EnsembleSelection {
    if (candidates.length === 0) {
      throw new Error('No candidates to select from');
    }

    if (candidates.length === 1) {
      const score = this.scoreCandidate(candidates[0]);
      return {
        selected: candidates[0],
        score,
        explanation: `Only one candidate available (${candidates[0].method})`,
        allScores: [{ method: candidates[0].method, score }]
      };
    }

    // Score all candidates
    const scored = candidates.map(candidate => ({
      candidate,
      score: this.scoreCandidate(candidate)
    }));

    // Sort by composite score (highest first)
    scored.sort((a, b) => b.score.compositeScore - a.score.compositeScore);

    const best = scored[0];
    const explanation = this.explainSelection(scored);

    return {
      selected: best.candidate,
      score: best.score,
      explanation,
      allScores: scored.map(s => ({
        method: s.candidate.method,
        score: s.score
      }))
    };
  }

  /**
   * Explain why a particular candidate was selected
   */
  private explainSelection(
    scored: Array<{ candidate: ExtractionCandidate; score: ExtractionScore }>
  ): string {
    const best = scored[0];
    const reasons: string[] = [];

    // Identify strong dimensions
    if (best.score.contentLength >= 0.9) {
      reasons.push('optimal content length');
    }

    if (best.score.structureQuality >= 0.9) {
      reasons.push('excellent structure');
    }

    if (best.score.metadataCompleteness >= 0.8) {
      reasons.push('complete metadata');
    }

    if (best.score.extractorConfidence >= 0.8) {
      reasons.push('high extractor confidence');
    }

    // Compare to second best
    if (scored.length > 1) {
      const secondBest = scored[1];
      const scoreDiff = best.score.compositeScore - secondBest.score.compositeScore;

      if (scoreDiff > 0.2) {
        reasons.push(`significantly better than ${secondBest.candidate.method}`);
      } else if (scoreDiff > 0.1) {
        reasons.push(`moderately better than ${secondBest.candidate.method}`);
      }
    }

    const reasonText = reasons.length > 0
      ? reasons.join(', ')
      : 'highest composite score';

    return `Selected ${best.candidate.method}: ${reasonText} (score: ${best.score.compositeScore.toFixed(3)})`;
  }
}

export const extractionEnsemble = new ExtractionEnsemble();
