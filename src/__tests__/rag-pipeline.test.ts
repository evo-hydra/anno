import { describe, it, expect } from 'vitest';
import { DeterministicEmbeddingProvider } from '../ai/embedding-provider';
import { InMemoryVectorStore } from '../ai/vector-store';
import { SemanticSearchService } from '../ai/semantic-search';
import { InMemoryMemoryStore } from '../ai/memory';
import { HeuristicSummarizer } from '../ai/summarizer';
import { RAGPipeline } from '../ai/rag-pipeline';

describe('RAGPipeline', () => {
  it('returns answer with citations and summaries', async () => {
    const embeddings = new DeterministicEmbeddingProvider(32);
    const vectorStore = new InMemoryVectorStore();
    const search = new SemanticSearchService(embeddings, vectorStore);
    const memory = new InMemoryMemoryStore();
    const summarizer = new HeuristicSummarizer();
    const pipeline = new RAGPipeline(search, summarizer, memory);

    await search.indexDocuments([
      {
        id: 'doc-1',
        text: 'Solid state batteries promise improved safety and capacity.',
        metadata: { url: 'https://example.com/battery' }
      },
      {
        id: 'doc-2',
        text: 'Lithium ion batteries remain dominant in consumer electronics.',
        metadata: { url: 'https://example.com/lithium' }
      }
    ]);

    const response = await pipeline.run({ query: 'battery technology', sessionId: 'session-1', topK: 2 });

    expect(response.answer).toContain('battery');
    expect(response.citations.length).toBe(2);
    expect(response.summaries.headline?.length).toBeGreaterThan(0);

    const session = await memory.getSession('session-1');
    expect(session?.entries.length).toBe(1);
    expect(session?.entries[0].type).toBe('summary');
  });
});
