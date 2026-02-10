# Anno Quick Start Guide

> Get Anno running in 5 minutes

## Prerequisites

- Node.js 18+
- Ollama (for local LLM) - optional but recommended
- Redis (optional - will use in-memory cache if not available)

## Installation

```bash
# 1. Clone the repository
git clone https://github.com/evo-hydra/anno.git
cd anno

# 2. Install dependencies
npm install

# 3. Create .env file (optional - for OpenAI integration)
cat > .env << EOF
# Optional: Add OpenAI API key for cloud AI features
# OPENAI_API_KEY=sk-your-key-here
EOF

# 4. Build the project
npm run build

# 5. Start the server
npm start
```

The server will start on **http://localhost:5213**

## Verify It's Working

```bash
# Check health
curl http://localhost:5213/health

# Fetch a web page
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

## What You Get

Anno is now running with:
- ✅ **82% token reduction** for AI web browsing
- ✅ **Semantic content extraction**
- ✅ **Query result caching** (100x faster repeated queries)
- ✅ **Health monitoring** at `/health`
- ✅ **Prometheus metrics** at `/metrics`

## Next Steps

1. **Try the demo**: `./demo-laptop-search.sh`
2. **Read the API docs**: `docs/openapi.yaml`
3. **Index some documents**: See examples below

## Basic Examples

### Fetch and extract content from a URL

```bash
curl -X POST http://localhost:5213/v1/content/fetch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://en.wikipedia.org/wiki/Artificial_intelligence",
    "options": {
      "useCache": true,
      "maxNodes": 20
    }
  }'
```

Returns JSONL stream with semantic nodes.

### Semantic search (requires indexing first)

```bash
# 1. Index documents
curl -X POST http://localhost:5213/v1/semantic/index \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "id": "doc1",
        "text": "Machine learning is a subset of AI",
        "metadata": {"source": "textbook"}
      },
      {
        "id": "doc2",
        "text": "Neural networks are inspired by the brain",
        "metadata": {"source": "research"}
      }
    ]
  }'

# 2. Search
curl -X POST http://localhost:5213/v1/semantic/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is AI?",
    "k": 5
  }'
```

### RAG (Retrieval-Augmented Generation)

```bash
curl -X POST http://localhost:5213/v1/semantic/rag \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Explain machine learning in simple terms",
    "k": 3
  }'
```

Returns an AI-generated answer with citations.

## Configuration

Anno uses environment variables for configuration:

```bash
# Server
PORT=5213

# AI Providers
AI_EMBEDDING_PROVIDER=deterministic  # or "openai"
AI_SUMMARIZER=heuristic              # or "llm"
OLLAMA_ENABLED=true
OPENAI_API_KEY=sk-...                # optional

# Rendering
RENDERING_ENABLED=false              # set true for JavaScript-heavy sites
RENDER_STEALTH=false

# Cache
REDIS_URL=redis://localhost:6379    # optional
```

## Running with Docker (Optional)

```bash
# Build
docker build -t anno .

# Run
docker run -p 5213:5213 anno
```

## Troubleshooting

### Server won't start
- Check if port 5213 is already in use: `lsof -i :5213`
- Check logs for errors

### Ollama not working
- Install Ollama: `curl https://ollama.ai/install.sh | sh`
- Pull a model: `ollama pull llama3.2:3b-instruct-q8_0`

### Redis connection errors
- Redis is optional - Anno will use in-memory cache
- To use Redis: `docker run -d -p 6379:6379 redis`

## Performance Tips

1. **Enable caching**: Repeated queries are ~100x faster
2. **Use local Ollama**: Faster and free compared to OpenAI
3. **Enable Redis**: Share cache across restarts
4. **Adjust maxNodes**: Lower for faster processing

## Support

- Documentation: `docs/`
- API Spec: `docs/openapi.yaml`
- Issues: https://github.com/evo-hydra/anno/issues

---

**That's it!** You now have Anno running. Start fetching and processing web content with 82% token reduction. 🚀
