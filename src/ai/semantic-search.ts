import type { EmbeddingDocument, EmbeddingProvider } from './embedding-provider';
import type { SimilarityResult, SimilaritySearchOptions, VectorStore } from './vector-store';

export interface SemanticSearchIndexInput extends EmbeddingDocument {
  content?: string;
}

export type SemanticSearchOptions = SimilaritySearchOptions;

export class SemanticSearchService {
  constructor(private readonly embeddings: EmbeddingProvider, private readonly store: VectorStore) {}

  async indexDocuments(documents: SemanticSearchIndexInput[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    const vectors = await this.embeddings.embedDocuments(documents);
    const entries = documents.map((doc, index) => ({
      id: doc.id,
      metadata: doc.metadata,
      content: doc.content ?? doc.text,
      vector: vectors[index],
      createdAt: Date.now()
    }));

    await this.store.addEntries(entries);
  }

  async search(query: string, options?: SemanticSearchOptions): Promise<SimilarityResult[]> {
    const vector = await this.embeddings.embedQuery(query);
    return this.store.similaritySearch(vector, options);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }

  size(): number {
    return this.store.size();
  }
}
