# LangChain Integration Guide

This guide explains how to configure and use LangChain providers in Anno for AI-powered embeddings and summarization.

## Overview

Anno supports multiple AI providers through LangChain integration:

- **OpenAI**: GPT models for summarization and text-embedding models for embeddings
- **Anthropic**: Claude models for summarization (planned)
- **Ollama**: Local LLM models for both summarization and embeddings
- **Deterministic**: Fallback provider that doesn't require API keys

## Environment Variables

### Required Variables

| Variable | Description | Default | Required For |
|----------|-------------|---------|--------------|
| `OPENAI_API_KEY` | OpenAI API key for embeddings and summarization | - | OpenAI provider |
| `AI_EMBEDDING_PROVIDER` | Embedding provider to use | `deterministic` | LangChain embeddings |
| `AI_SUMMARIZER` | Summarization method | `heuristic` | LLM summarization |

### Optional Variables

| Variable | Description | Default | Required For |
|----------|-------------|---------|--------------|
| `ANTHROPIC_API_KEY` | Anthropic API key | - | Anthropic provider (planned) |
| `OLLAMA_ENABLED` | Enable Ollama integration | `true` | Ollama provider |
| `OLLAMA_BASE_URL` | Ollama server URL | `http://127.0.0.1:11434` | Ollama provider |
| `OLLAMA_MODEL` | Ollama model to use | `llama3.2:3b-instruct-q8_0` | Ollama provider |

## Configuration Examples

### OpenAI Configuration

```bash
# Set OpenAI as embedding provider
export AI_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-your-openai-api-key

# Enable LLM summarization with OpenAI
export AI_SUMMARIZER=llm
```

### Ollama Configuration

```bash
# Set Ollama as embedding provider
export AI_EMBEDDING_PROVIDER=ollama
export OLLAMA_ENABLED=true
export OLLAMA_MODEL=llama3.2:3b-instruct-q8_0

# Enable LLM summarization with Ollama
export AI_SUMMARIZER=llm
```

### Hybrid Configuration

```bash
# Use OpenAI for embeddings, Ollama for summarization
export AI_EMBEDDING_PROVIDER=openai
export AI_SUMMARIZER=llm
export OPENAI_API_KEY=sk-your-openai-api-key
export OLLAMA_ENABLED=true
```

### Fallback Configuration

```bash
# Use deterministic embeddings and heuristic summarization
export AI_EMBEDDING_PROVIDER=deterministic
export AI_SUMMARIZER=heuristic
# No API keys required
```

## Provider Behavior

### Embedding Providers

1. **OpenAI** (`AI_EMBEDDING_PROVIDER=openai`):
   - Uses `text-embedding-3-small` model
   - Requires `OPENAI_API_KEY`
   - Produces 1536-dimensional embeddings

2. **Ollama** (`AI_EMBEDDING_PROVIDER=ollama`):
   - Uses `nomic-embed-text` model by default
   - Requires Ollama server running
   - Produces model-specific dimensional embeddings

3. **Deterministic** (default):
   - No API keys required
   - Produces consistent 64-dimensional embeddings
   - Used when no other provider is configured or available

### Summarization Providers

1. **LLM** (`AI_SUMMARIZER=llm`):
   - Tries providers in order: OpenAI → Anthropic → Ollama
   - Falls back to heuristic if no providers available
   - Uses temperature 0.2 for consistent results

2. **Heuristic** (default):
   - No API keys required
   - Uses rule-based summarization
   - Always available as fallback

## Testing

### Running Smoke Tests

The integration includes smoke tests to verify LangChain functionality:

```bash
# Run all tests (OpenAI tests will be skipped if no API key)
npm run test:unit

# Run only LangChain smoke tests
npm run test -- src/__tests__/langchain-smoke.test.ts

# Run with OpenAI API key (enables OpenAI tests)
OPENAI_API_KEY=sk-your-key npm run test -- src/__tests__/langchain-smoke.test.ts
```

### Test Behavior

- Tests marked with `.skip` when `OPENAI_API_KEY` is not set
- Fallback behavior tests always run
- Service integration tests verify proper initialization

## Error Handling

### Configuration Errors

- Missing API keys when provider is explicitly configured
- Invalid provider names
- Unavailable Ollama server

### Fallback Behavior

- Embeddings: Falls back to deterministic provider
- Summarization: Falls back to heuristic summarizer
- Errors are logged as warnings, service continues with fallback

## Development

### Adding New Providers

1. Update `langchain-integration.ts` with new provider logic
2. Add environment variable configuration
3. Update this documentation
4. Add smoke tests for the new provider

### Debugging

Enable debug logging to see provider selection:

```bash
DEBUG=anno:* npm start
```

## Security Notes

- Never commit API keys to version control
- Use environment variables or secure secret management
- API keys are loaded only when providers are used
- Consider rate limiting for production deployments

## Security & Auth Checklist

Before deploying Anno with LangChain integration to production:

- **🔐 Authentication**: Protect the REST API behind an authenticated proxy/API key or mTLS
- **⚡ Rate Limiting**: Enable rate limiting to prevent abuse of LLM endpoints
- **🛡️ Untrusted Content**: Treat retrieved text as untrusted (prompt injection warning)
- **🔑 Secret Management**: Keep API keys in a secret manager, never in environment files
- **📊 Monitoring**: Monitor token usage and costs for cloud LLM providers
- **🚫 Content Filtering**: Consider implementing content filters for LLM inputs/outputs

## Performance Considerations

- OpenAI embeddings are cached by LangChain
- Ollama models are loaded once and reused
- Deterministic embeddings are computed synchronously
- LLM summarization may be slower than heuristic methods