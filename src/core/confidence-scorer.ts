/**
 * Multi-Dimensional Confidence Scoring
 *
 * Provides detailed confidence breakdowns for extracted content using
 * Bayesian probability combination across multiple dimensions.
 */

export interface ConfidenceBreakdown {
  extraction: number;       // Extractor's own confidence (0-1)
  contentQuality: number;   // Length + structure quality (0-1)
  metadata: number;         // Completeness of metadata (0-1)
  sourceCredibility: number; // Domain reputation (0-1, future: Phase 2)
  consensus: number;        // Agreement between extractors (0-1)
  overall: number;          // Bayesian combination
}

export interface ConsensusInput {
  candidates: Array<{
    method: string;
    content: string;
    title: string;
    score: number;
  }>;
}

/**
 * Prior probabilities for different confidence dimensions
 */
const PRIORS = {
  extraction: 0.7,       // Default trust in extractors
  contentQuality: 0.6,   // Assume moderate quality
  metadata: 0.5,         // Metadata often missing
  sourceCredibility: 0.5, // Neutral prior
  consensus: 0.5         // No consensus by default
};

/**
 * Weights for Bayesian combination
 */
const BAYESIAN_WEIGHTS = {
  extraction: 0.30,
  contentQuality: 0.25,
  metadata: 0.15,
  sourceCredibility: 0.10,
  consensus: 0.20
};

export class ConfidenceScorer {
  /**
   * Compute extraction confidence
   */
  computeExtraction(extractorConfidence?: number): number {
    return extractorConfidence ?? PRIORS.extraction;
  }

  /**
   * Compute content quality confidence
   */
  computeContentQuality(content: string, paragraphCount: number): number {
    let score = 0;

    // Content length scoring
    const length = content.length;
    if (length >= 300 && length <= 3000) {
      score += 0.5; // Optimal length
    } else if (length >= 100 && length < 300) {
      score += 0.3; // Short but acceptable
    } else if (length > 3000 && length <= 5000) {
      score += 0.4; // Long but ok
    } else if (length > 5000) {
      score += 0.2; // Suspicious length
    } else {
      score += 0.1; // Too short
    }

    // Paragraph structure scoring
    if (paragraphCount >= 3 && paragraphCount <= 20) {
      score += 0.5; // Good structure
    } else if (paragraphCount >= 2) {
      score += 0.3; // Minimal structure
    } else if (paragraphCount >= 1) {
      score += 0.2; // Poor structure
    } else {
      score += 0.1; // No structure
    }

    return Math.min(score, 1.0);
  }

  /**
   * Compute metadata completeness confidence
   */
  computeMetadata(title: string, author?: string | null, publishDate?: string | null, excerpt?: string | null): number {
    let score = 0;

    // Title (required)
    if (title && title.length > 5 && title !== 'Unknown') {
      score += 0.4;
    }

    // Author (optional but valuable)
    if (author && author.length > 0) {
      score += 0.25;
    }

    // Publish date (optional but valuable)
    if (publishDate && publishDate.length > 0) {
      score += 0.25;
    }

    // Excerpt (nice to have)
    if (excerpt && excerpt.length > 20) {
      score += 0.1;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Compute source credibility (placeholder for future)
   */
  computeSourceCredibility(url: string): number {
    // Future: Use domain reputation database
    // For now, use simple heuristics

    try {
      const domain = new URL(url).hostname;

      // Trusted news sources
      if (domain.includes('nytimes.com') || domain.includes('bbc.com') ||
          domain.includes('reuters.com') || domain.includes('apnews.com')) {
        return 0.9;
      }

      // Academic domains
      if (domain.endsWith('.edu') || domain.endsWith('.gov')) {
        return 0.85;
      }

      // Known tech blogs
      if (domain.includes('techcrunch.com') || domain.includes('arstechnica.com') ||
          domain.includes('theverge.com')) {
        return 0.8;
      }

      // Generic blogs/sites
      if (domain.includes('medium.com') || domain.includes('substack.com')) {
        return 0.6;
      }

      // Unknown domains
      return PRIORS.sourceCredibility;
    } catch {
      return PRIORS.sourceCredibility;
    }
  }

  /**
   * Compute consensus among extractors
   */
  computeConsensus(consensusInput?: ConsensusInput): number {
    if (!consensusInput || consensusInput.candidates.length <= 1) {
      return PRIORS.consensus; // No consensus possible
    }

    const candidates = consensusInput.candidates;

    // Calculate title similarity (simple string similarity)
    const titles = candidates.map(c => c.title.toLowerCase());
    const titleSimilarity = this.calculateAverageTextSimilarity(titles);

    // Calculate content length variance
    const lengths = candidates.map(c => c.content.length);
    const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const lengthVariance = lengths.reduce((sum, len) => sum + Math.pow(len - avgLength, 2), 0) / lengths.length;
    const lengthScore = 1 / (1 + lengthVariance / 10000); // Normalize variance

    // Calculate score agreement
    const scores = candidates.map(c => c.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const scoreVariance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length;
    const scoreAgreement = 1 / (1 + scoreVariance);

    // Weighted combination
    const consensus = (
      titleSimilarity * 0.4 +
      lengthScore * 0.3 +
      scoreAgreement * 0.3
    );

    return Math.min(Math.max(consensus, 0), 1);
  }

  /**
   * Calculate average pairwise text similarity (Jaccard-like)
   */
  private calculateAverageTextSimilarity(texts: string[]): number {
    if (texts.length <= 1) return 1.0;

    const wordSets = texts.map(text => {
      const words = text.split(/\s+/).filter(w => w.length > 2);
      return new Set(words);
    });

    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < wordSets.length; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const intersection = new Set([...wordSets[i]].filter(x => wordSets[j].has(x)));
        const union = new Set([...wordSets[i], ...wordSets[j]]);
        const similarity = intersection.size / union.size;
        totalSimilarity += similarity;
        pairCount++;
      }
    }

    return pairCount > 0 ? totalSimilarity / pairCount : 0;
  }

  /**
   * Combine confidences using Bayesian approach
   */
  bayesianCombine(breakdown: Omit<ConfidenceBreakdown, 'overall'>): number {
    // Convert confidences to log-odds
    const toLogOdds = (p: number): number => {
      const clamped = Math.min(Math.max(p, 0.01), 0.99); // Avoid log(0)
      return Math.log(clamped / (1 - clamped));
    };

    // Convert log-odds back to probability
    const fromLogOdds = (logOdds: number): number => {
      const odds = Math.exp(logOdds);
      return odds / (1 + odds);
    };

    // Weighted log-odds combination
    const combinedLogOdds =
      toLogOdds(breakdown.extraction) * BAYESIAN_WEIGHTS.extraction +
      toLogOdds(breakdown.contentQuality) * BAYESIAN_WEIGHTS.contentQuality +
      toLogOdds(breakdown.metadata) * BAYESIAN_WEIGHTS.metadata +
      toLogOdds(breakdown.sourceCredibility) * BAYESIAN_WEIGHTS.sourceCredibility +
      toLogOdds(breakdown.consensus) * BAYESIAN_WEIGHTS.consensus;

    return fromLogOdds(combinedLogOdds);
  }

  /**
   * Compute full confidence breakdown
   */
  computeFull(params: {
    extractorConfidence?: number;
    content: string;
    paragraphCount: number;
    title: string;
    author?: string | null;
    publishDate?: string | null;
    excerpt?: string | null;
    url: string;
    consensusInput?: ConsensusInput;
  }): ConfidenceBreakdown {
    const extraction = this.computeExtraction(params.extractorConfidence);
    const contentQuality = this.computeContentQuality(params.content, params.paragraphCount);
    const metadata = this.computeMetadata(params.title, params.author, params.publishDate, params.excerpt);
    const sourceCredibility = this.computeSourceCredibility(params.url);
    const consensus = this.computeConsensus(params.consensusInput);

    const overall = this.bayesianCombine({
      extraction,
      contentQuality,
      metadata,
      sourceCredibility,
      consensus
    });

    return {
      extraction,
      contentQuality,
      metadata,
      sourceCredibility,
      consensus,
      overall
    };
  }
}

export const confidenceScorer = new ConfidenceScorer();
