import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../config/env', () => ({
  config: {
    ai: {
      embeddingProvider: 'deterministic',
      vectorStoreProvider: 'memory',
      summarizer: 'heuristic',
    },
    redis: {
      enabled: false,
      url: 'redis://localhost:6379',
    },
  },
}));

vi.mock('../ai/langchain-integration', () => ({
  createLangChainSummarizer: vi.fn(),
  createLangChainEmbeddingProvider: vi.fn(),
}));

vi.mock('redis', () => ({
  createClient: vi.fn().mockReturnValue({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../ai/embedding-provider', () => {
  class MockDeterministicEmbeddingProvider {
    private dimensions: number;
    constructor(dimensions = 32) {
      this.dimensions = dimensions;
    }
    async embedDocuments() {
      return [new Array(this.dimensions).fill(0)];
    }
    async embedQuery() {
      return new Array(this.dimensions).fill(0);
    }
  }
  return {
    DeterministicEmbeddingProvider: MockDeterministicEmbeddingProvider,
  };
});

vi.mock('../ai/vector-store', () => {
  class MockInMemoryVectorStore {
    async addEntries() {}
    async similaritySearch() { return []; }
    async clear() {}
    size() { return 0; }
  }
  class MockRedisVectorStore {
    async addEntries() {}
    async similaritySearch() { return []; }
    async clear() {}
    size() { return 0; }
    async initialize() {}
  }
  return {
    InMemoryVectorStore: MockInMemoryVectorStore,
    RedisVectorStore: MockRedisVectorStore,
  };
});

vi.mock('../ai/semantic-search', () => {
  class MockSemanticSearchService {
    constructor() {}
    async indexDocuments() {}
    async search() { return []; }
    async clear() {}
    size() { return 0; }
  }
  return { SemanticSearchService: MockSemanticSearchService };
});

vi.mock('../ai/memory', () => {
  class MockInMemoryMemoryStore {
    async addEntry() {}
    async getSession() { return null; }
    async listSessions() { return []; }
    async clearSession() {}
  }
  return { InMemoryMemoryStore: MockInMemoryMemoryStore };
});

vi.mock('../ai/summarizer', () => {
  class MockHeuristicSummarizer {
    async generateSummaries() { return []; }
  }
  return { HeuristicSummarizer: MockHeuristicSummarizer };
});

vi.mock('../ai/rag-pipeline', () => {
  class MockRAGPipeline {
    constructor() {}
    async query() { return { citations: [], summaries: [] }; }
  }
  return { RAGPipeline: MockRAGPipeline };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { getSemanticServices, resetSemanticServices } from '../services/semantic-services';
import { config } from '../config/env';
import { createLangChainSummarizer, createLangChainEmbeddingProvider } from '../ai/langchain-integration';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSemanticServices();

    // Reset env variables
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OLLAMA_ENABLED;
    delete process.env.OLLAMA_MODEL;
  });

  // =========================================================================
  // getSemanticServices — singleton
  // =========================================================================

  describe('getSemanticServices', () => {
    it('returns a services object with all expected keys', () => {
      const services = getSemanticServices();

      expect(services).toBeDefined();
      expect(services.embeddings).toBeDefined();
      expect(services.vectorStore).toBeDefined();
      expect(services.searchService).toBeDefined();
      expect(services.memoryStore).toBeDefined();
      expect(services.summarizer).toBeDefined();
      expect(services.ragPipeline).toBeDefined();
    });

    it('returns the same instance on subsequent calls (singleton)', () => {
      const first = getSemanticServices();
      const second = getSemanticServices();

      expect(first).toBe(second);
    });

    it('returns a new instance after reset', () => {
      const first = getSemanticServices();
      resetSemanticServices();
      const second = getSemanticServices();

      expect(first).not.toBe(second);
    });
  });

  // =========================================================================
  // resetSemanticServices
  // =========================================================================

  describe('resetSemanticServices', () => {
    it('clears the singleton so next call creates fresh services', () => {
      const first = getSemanticServices();
      resetSemanticServices();
      const second = getSemanticServices();

      // Both should be valid services objects but different references
      expect(first).not.toBe(second);
      expect(second.embeddings).toBeDefined();
    });
  });

  // =========================================================================
  // Embedding provider selection
  // =========================================================================

  describe('embedding provider selection', () => {
    it('uses DeterministicEmbeddingProvider as default', () => {
      const services = getSemanticServices();
      // The default provider should be a DeterministicEmbeddingProvider instance
      expect(services.embeddings).toBeDefined();
      expect(typeof services.embeddings.embedQuery).toBe('function');
      expect(typeof services.embeddings.embedDocuments).toBe('function');
    });

    it('attempts OpenAI when embeddingProvider is "openai" and API key is set', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'openai';
      process.env.OPENAI_API_KEY = 'test-key';

      vi.mocked(createLangChainEmbeddingProvider).mockReturnValueOnce({
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainEmbeddingProvider).toHaveBeenCalledWith('openai');
      expect(services.embeddings).toBeDefined();

      // Reset config
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('falls back to deterministic when OpenAI is requested but key is missing', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'openai';
      delete process.env.OPENAI_API_KEY;

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const services = getSemanticServices();

      expect(createLangChainEmbeddingProvider).not.toHaveBeenCalled();
      expect(services.embeddings).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('falls back to deterministic when OpenAI embedding creation throws', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'openai';
      process.env.OPENAI_API_KEY = 'test-key';

      vi.mocked(createLangChainEmbeddingProvider).mockImplementationOnce(() => {
        throw new Error('OpenAI init failed');
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const services = getSemanticServices();
      expect(services.embeddings).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('attempts Ollama when embeddingProvider is "ollama"', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'ollama';
      // OLLAMA_ENABLED not set to 'false' means it's considered enabled

      vi.mocked(createLangChainEmbeddingProvider).mockReturnValueOnce({
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainEmbeddingProvider).toHaveBeenCalledWith('ollama', 'llama3.2:3b-instruct-q8_0');
      expect(services.embeddings).toBeDefined();

      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('uses custom OLLAMA_MODEL when set', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'ollama';
      process.env.OLLAMA_MODEL = 'custom-model';

      vi.mocked(createLangChainEmbeddingProvider).mockReturnValueOnce({
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      } as never);

      getSemanticServices();

      expect(createLangChainEmbeddingProvider).toHaveBeenCalledWith('ollama', 'custom-model');

      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('falls back to deterministic when Ollama is disabled', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'ollama';
      process.env.OLLAMA_ENABLED = 'false';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const services = getSemanticServices();
      expect(createLangChainEmbeddingProvider).not.toHaveBeenCalled();
      expect(services.embeddings).toBeDefined();

      warnSpy.mockRestore();
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
    });

    it('tries OpenAI in legacy mode when deterministic but key is present', () => {
      (config.ai as { embeddingProvider: string }).embeddingProvider = 'deterministic';
      process.env.OPENAI_API_KEY = 'test-key';

      vi.mocked(createLangChainEmbeddingProvider).mockReturnValueOnce({
        embedDocuments: vi.fn(),
        embedQuery: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainEmbeddingProvider).toHaveBeenCalledWith('openai');
      expect(services.embeddings).toBeDefined();
    });
  });

  // =========================================================================
  // Summarizer selection
  // =========================================================================

  describe('summarizer selection', () => {
    it('uses HeuristicSummarizer as default', () => {
      const services = getSemanticServices();
      expect(services.summarizer).toBeDefined();
      expect(typeof services.summarizer.generateSummaries).toBe('function');
    });

    it('attempts OpenAI summarizer when AI_SUMMARIZER=llm and key present', () => {
      (config.ai as { summarizer: string }).summarizer = 'llm';
      process.env.OPENAI_API_KEY = 'test-key';

      vi.mocked(createLangChainSummarizer).mockReturnValueOnce({
        generateSummaries: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainSummarizer).toHaveBeenCalledWith('openai');
      expect(services.summarizer).toBeDefined();

      (config.ai as { summarizer: string }).summarizer = 'heuristic';
    });

    it('falls through to Anthropic when OpenAI is unavailable', () => {
      (config.ai as { summarizer: string }).summarizer = 'llm';
      delete process.env.OPENAI_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-key';

      vi.mocked(createLangChainSummarizer).mockReturnValueOnce({
        generateSummaries: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainSummarizer).toHaveBeenCalledWith('anthropic');
      expect(services.summarizer).toBeDefined();

      (config.ai as { summarizer: string }).summarizer = 'heuristic';
    });

    it('falls through to Ollama when no cloud providers are available', () => {
      (config.ai as { summarizer: string }).summarizer = 'llm';
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      // OLLAMA_ENABLED not set to 'false'

      vi.mocked(createLangChainSummarizer).mockReturnValueOnce({
        generateSummaries: vi.fn(),
      } as never);

      const services = getSemanticServices();

      expect(createLangChainSummarizer).toHaveBeenCalledWith('ollama', 'llama3.2:3b-instruct-q8_0');
      expect(services.summarizer).toBeDefined();

      (config.ai as { summarizer: string }).summarizer = 'heuristic';
    });

    it('falls back to heuristic when all LLM providers fail', () => {
      (config.ai as { summarizer: string }).summarizer = 'llm';
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OLLAMA_ENABLED = 'false';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const services = getSemanticServices();
      expect(services.summarizer).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
      (config.ai as { summarizer: string }).summarizer = 'heuristic';
    });

    it('uses custom OLLAMA_MODEL for summarizer', () => {
      (config.ai as { summarizer: string }).summarizer = 'llm';
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OLLAMA_MODEL = 'mistral:7b';

      vi.mocked(createLangChainSummarizer).mockReturnValueOnce({
        generateSummaries: vi.fn(),
      } as never);

      getSemanticServices();

      expect(createLangChainSummarizer).toHaveBeenCalledWith('ollama', 'mistral:7b');

      (config.ai as { summarizer: string }).summarizer = 'heuristic';
    });
  });

  // =========================================================================
  // Vector store selection
  // =========================================================================

  describe('vector store selection', () => {
    it('uses InMemoryVectorStore when redis is disabled', () => {
      const services = getSemanticServices();
      expect(services.vectorStore).toBeDefined();
      expect(typeof services.vectorStore.addEntries).toBe('function');
    });
  });
});
