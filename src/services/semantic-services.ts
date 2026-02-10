import { DeterministicEmbeddingProvider, type EmbeddingProvider } from '../ai/embedding-provider';
import { InMemoryVectorStore, RedisVectorStore, type VectorStore } from '../ai/vector-store';
import { SemanticSearchService } from '../ai/semantic-search';
import { InMemoryMemoryStore, type MemoryStore } from '../ai/memory';
import { HeuristicSummarizer, type Summarizer } from '../ai/summarizer';
import { RAGPipeline } from '../ai/rag-pipeline';
import { config } from '../config/env';
import { createLangChainSummarizer, createLangChainEmbeddingProvider } from '../ai/langchain-integration';
import { createClient } from 'redis';

interface SemanticServices {
  embeddings: EmbeddingProvider;
  vectorStore: VectorStore;
  searchService: SemanticSearchService;
  memoryStore: MemoryStore;
  summarizer: Summarizer;
  ragPipeline: RAGPipeline;
}

let services: SemanticServices | null = null;

export const getSemanticServices = (): SemanticServices => {
  if (!services) {
    const embeddings = createEmbeddingProvider();
    const vectorStore = createVectorStore();
    const searchService = new SemanticSearchService(embeddings, vectorStore);
    const memoryStore = createMemoryStore();
    const summarizer = createSummarizer();
    const ragPipeline = new RAGPipeline(searchService, summarizer, memoryStore);

    services = {
      embeddings,
      vectorStore,
      searchService,
      memoryStore,
      summarizer,
      ragPipeline
    };
  }
  return services;
};

export const resetSemanticServices = (): void => {
  services = null;
};

const createEmbeddingProvider = (): EmbeddingProvider => {
    // Use config-driven approach when AI_EMBEDDING_PROVIDER is set
    if (config.ai.embeddingProvider === 'openai') {
      if (process.env.OPENAI_API_KEY) {
        try {
          return createLangChainEmbeddingProvider('openai');
        } catch (error) {
          console.warn('OpenAI embeddings unavailable:', error);
        }
      } else {
        console.warn('AI_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY not set');
      }
    }

    if (config.ai.embeddingProvider === 'ollama') {
      if (process.env.OLLAMA_ENABLED !== 'false') {
        try {
          const model = process.env.OLLAMA_MODEL || 'llama3.2:3b-instruct-q8_0';
          return createLangChainEmbeddingProvider('ollama', model);
        } catch (error) {
          console.warn('Ollama embeddings unavailable:', error);
        }
      } else {
        console.warn('AI_EMBEDDING_PROVIDER=ollama but OLLAMA_ENABLED=false');
      }
    }

    // Legacy behavior: try OpenAI first if not explicitly configured
    if (config.ai.embeddingProvider === 'deterministic' && process.env.OPENAI_API_KEY) {
      try {
        return createLangChainEmbeddingProvider('openai');
      } catch (error) {
        console.warn('OpenAI embeddings unavailable:', error);
      }
    }

    // Fallback to deterministic
    return new DeterministicEmbeddingProvider(64);
};

const createVectorStore = (): VectorStore => {
    // Use Redis if enabled and available
    if (config.ai.vectorStoreProvider === 'redis' && config.redis.enabled) {
      try {
        const redis = createClient({
          url: config.redis.url || 'redis://localhost:6379'
        });

        redis.on('error', (err) => {
          console.warn('Redis vector store connection error:', err);
        });

        // Connect and return Redis vector store
        redis.connect().then(() => {
          console.log('Redis vector store connected');
        }).catch((err) => {
          console.warn('Failed to connect Redis vector store:', err);
        });

        const store = new RedisVectorStore(redis, 'anno:vectors:');
        // Initialize size cache
        store.initialize().catch(err => {
          console.warn('Failed to initialize Redis vector store size:', err);
        });
        return store;
      } catch (error) {
        console.warn('Failed to create Redis vector store, using in-memory:', error);
      }
    }

    // Fallback to in-memory
    return new InMemoryVectorStore();
};

const createMemoryStore = (): MemoryStore => {
    return new InMemoryMemoryStore();
};

const createSummarizer = (): Summarizer => {
    // Use config-driven approach when AI_SUMMARIZER=llm
    if (config.ai.summarizer === 'llm') {
      // Try OpenAI first if API key is available
      if (process.env.OPENAI_API_KEY) {
        try {
          return createLangChainSummarizer('openai');
        } catch (error) {
          console.warn('OpenAI summarizer unavailable:', error);
        }
      }

      // Try Anthropic if OpenAI is not available
      if (process.env.ANTHROPIC_API_KEY) {
        try {
          return createLangChainSummarizer('anthropic');
        } catch (error) {
          console.warn('Anthropic summarizer unavailable:', error);
        }
      }

      // Try Ollama if cloud providers are not available
      if (process.env.OLLAMA_ENABLED !== 'false') {
        try {
          const model = process.env.OLLAMA_MODEL || 'llama3.2:3b-instruct-q8_0';
          return createLangChainSummarizer('ollama', model);
        } catch (error) {
          console.warn('Ollama summarizer unavailable:', error);
        }
      }

      console.warn('AI_SUMMARIZER=llm but no LLM providers available, falling back to heuristic');
    }

    // Fallback to heuristic
    return new HeuristicSummarizer();
};
