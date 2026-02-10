import { describe, it, expect } from 'vitest';
import { DeterministicEmbeddingProvider } from '../ai/embedding-provider';
import { InMemoryVectorStore } from '../ai/vector-store';
import { SemanticSearchService } from '../ai/semantic-search';

describe('SemanticSearchService', () => {
  it('indexes and retrieves similar documents', async () => {
    const embeddings = new DeterministicEmbeddingProvider(32);
    const store = new InMemoryVectorStore();
    const service = new SemanticSearchService(embeddings, store);

    await service.indexDocuments([
      { id: 'doc-1', text: 'Solid state battery breakthroughs from Toyota', metadata: { tags: ['battery'] } },
      { id: 'doc-2', text: 'AI models generate realistic images', metadata: { tags: ['ai'] } },
      { id: 'doc-3', text: 'Advancements in lithium ion batteries', metadata: { tags: ['battery'] } }
    ]);

    const results = await service.search('latest battery technology', { k: 2 });
    expect(results.length).toBe(2);
    expect(results[0].id).toBe('doc-1');
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it('respects metadata filters', async () => {
    const embeddings = new DeterministicEmbeddingProvider(32);
    const store = new InMemoryVectorStore();
    const service = new SemanticSearchService(embeddings, store);

    await service.indexDocuments([
      { id: 'doc-1', text: 'Neural networks for vision', metadata: { tags: ['ai', 'vision'], source: 'news' } },
      { id: 'doc-2', text: 'Transformer models for language', metadata: { tags: ['ai', 'nlp'], source: 'journal' } }
    ]);

    const results = await service.search('language transformers', { filter: { source: 'journal' }, k: 5 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc-2');
  });
});
