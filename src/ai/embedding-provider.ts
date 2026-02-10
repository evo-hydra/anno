export interface EmbeddingDocument {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingProvider {
  embedDocuments(documents: EmbeddingDocument[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/**
 * Deterministic embedding provider for tests and local development.
 * Generates lightweight bag-of-words vectors without external dependencies.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;

  constructor(dimensions = 32) {
    this.dimensions = dimensions;
  }

  async embedDocuments(documents: EmbeddingDocument[]): Promise<number[][]> {
    return documents.map((doc) => this.embedText(doc.text));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedText(text);
  }

  private embedText(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

    for (const token of tokens) {
      const index = this.hashToken(token);
      vector[index] += 1;
    }

    // Normalise vector length to prevent bias towards longer documents
    const norm = Math.hypot(...vector);
    if (norm === 0) {
      return vector;
    }

    return vector.map((value) => value / norm);
  }

  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i += 1) {
      hash = (hash * 31 + token.charCodeAt(i)) % this.dimensions;
    }
    return Math.abs(hash % this.dimensions);
  }
}
