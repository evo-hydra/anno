import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { getSemanticServices, resetSemanticServices } from '../services/semantic-services';

describe('LangChain Integration Smoke Tests', () => {
  beforeEach(() => {
    resetSemanticServices();
  });

  afterEach(() => {
    resetSemanticServices();
  });

  describe('OpenAI Integration', () => {
    it.skipIf(!process.env.OPENAI_API_KEY)('should use OpenAI embeddings when OPENAI_API_KEY is set and AI_EMBEDDING_PROVIDER=openai', async () => {
      // Set OpenAI as embedding provider
      process.env.AI_EMBEDDING_PROVIDER = 'openai';
      resetSemanticServices();

      const services = getSemanticServices();
      const embeddings = await services.embeddings.embedQuery('test query');

      // OpenAI embeddings should be 1536 dimensions for text-embedding-3-small
      expect(Array.isArray(embeddings)).toBe(true);
      expect(embeddings.length > 1000).toBe(true); // Should be high-dimensional
      expect(typeof embeddings[0] === 'number').toBe(true);
    });

    it.skipIf(!process.env.OPENAI_API_KEY)('should use OpenAI summarizer when OPENAI_API_KEY is set and AI_SUMMARIZER=llm', async () => {
      // Set LLM as summarizer
      process.env.AI_SUMMARIZER = 'llm';
      resetSemanticServices();

      const services = getSemanticServices();
      const summaries = await services.summarizer.generateSummaries([{
        level: 'paragraph',
        content: 'This is a test document that contains some content that should be summarized by the OpenAI API.'
      }]);

      expect(Array.isArray(summaries)).toBe(true);
      expect(summaries.length).toBe(1);
      expect(summaries[0].level).toBe('paragraph');
      expect(typeof summaries[0].text === 'string').toBe(true);
      expect(summaries[0].text.length > 10).toBe(true); // Should have actual content
      expect(typeof summaries[0].confidence === 'number').toBe(true);
      expect(summaries[0].confidence >= 0).toBe(true); // Should have valid confidence (0-1)
    });
  });

  describe('Fallback Behavior', () => {
    it('should fallback to deterministic embeddings when no API key is set', async () => {
      // Ensure no OpenAI key is set for this test
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      process.env.AI_EMBEDDING_PROVIDER = 'deterministic';
      resetSemanticServices();

      try {
        const services = getSemanticServices();
        const embeddings = await services.embeddings.embedQuery('test query');

        // Deterministic embeddings should be 64 dimensions
        expect(Array.isArray(embeddings)).toBe(true);
        expect(embeddings.length).toBe(64);
        expect(typeof embeddings[0] === 'number').toBe(true);

        // Same input should produce same output (deterministic)
        const embeddings2 = await services.embeddings.embedQuery('test query');
        expect(embeddings).toEqual(embeddings2);
      } finally {
        // Restore original key
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        }
      }
    });

    it('should fallback to heuristic summarizer when AI_SUMMARIZER=heuristic', async () => {
      process.env.AI_SUMMARIZER = 'heuristic';
      resetSemanticServices();

      const services = getSemanticServices();
      const summaries = await services.summarizer.generateSummaries([{
        level: 'paragraph',
        content: 'This is a test document that contains some content that should be summarized using heuristic methods.'
      }]);

      expect(Array.isArray(summaries)).toBe(true);
      expect(summaries.length).toBe(1);
      expect(summaries[0].level).toBe('paragraph');
      expect(typeof summaries[0].text === 'string').toBe(true);
      expect(typeof summaries[0].confidence === 'number').toBe(true);
    });

    it('should fallback to heuristic summarizer when AI_SUMMARIZER=llm but no API keys available', async () => {
      // Ensure no API keys are set
      const originalOpenAIKey = process.env.OPENAI_API_KEY;
      const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OLLAMA_ENABLED = 'false';
      process.env.AI_SUMMARIZER = 'llm';
      resetSemanticServices();

      try {
        const services = getSemanticServices();
        const summaries = await services.summarizer.generateSummaries([{
          level: 'paragraph',
          content: 'This is a test document that should fallback to heuristic summarization.'
        }]);

        expect(Array.isArray(summaries)).toBe(true);
        expect(summaries.length).toBe(1);
        expect(summaries[0].level).toBe('paragraph');
        expect(typeof summaries[0].text === 'string').toBe(true);
        expect(typeof summaries[0].confidence === 'number').toBe(true);
      } finally {
        // Restore original keys
        if (originalOpenAIKey) {
          process.env.OPENAI_API_KEY = originalOpenAIKey;
        }
        if (originalAnthropicKey) {
          process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
        }
      }
    });
  });

  describe('Service Integration', () => {
    it('should create all services without errors', () => {
      const services = getSemanticServices();

      expect(services.embeddings !== undefined).toBe(true);
      expect(services.vectorStore !== undefined).toBe(true);
      expect(services.searchService !== undefined).toBe(true);
      expect(services.memoryStore !== undefined).toBe(true);
      expect(services.summarizer !== undefined).toBe(true);
      expect(services.ragPipeline !== undefined).toBe(true);
    });

    it('should use the same service instance on subsequent calls', () => {
      const services1 = getSemanticServices();
      const services2 = getSemanticServices();

      expect(services1).toBe(services2);
    });

    it('should create new instances after reset', () => {
      const services1 = getSemanticServices();
      resetSemanticServices();
      const services2 = getSemanticServices();

      expect(services1).not.toBe(services2);
    });
  });
});
