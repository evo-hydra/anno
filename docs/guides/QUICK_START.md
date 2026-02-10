# Anno Quick Start

Get from clone to first semantic API call in under five minutes.

## 1. Prerequisites
- Node.js 18+
- npm 10+
- Optional: Docker (for containers)
- Environment variables for AI configuration (defaults provided)

## 2. Clone & Install
```bash
git clone https://github.com/your-org/anno.git
cd anno
npm install
```

## 3. Configure Environment
Create `.env.local` (or export directly) with AI defaults:
```
AI_EMBEDDING_PROVIDER=deterministic
AI_LLM_PROVIDER=none
AI_VECTOR_STORE=memory
AI_SUMMARIZER=heuristic
AI_DEFAULT_K=3
```

> Set `AI_SUMMARIZER=llm` only after installing LangChain + provider SDKs (see `docs/guides/LANGCHAIN_INTEGRATION.md`).

## 4. Start the Service
```bash
npm run dev
```

### Using Docker Compose
```bash
docker compose up --build
```
The service listens on `http://localhost:5213`. Edit `.env.local` to adjust AI settings before starting the container.

## 5. Seed the Semantic Index
```bash
curl -X POST http://localhost:5213/v1/semantic/index \
  -H 'Content-Type: application/json' \
  -d '{
        "documents": [
          {"id":"doc-1","text":"Solid state batteries promise safer energy storage.","metadata":{"url":"https://example.com/battery"}},
          {"id":"doc-2","text":"Lithium ion batteries dominate consumer devices.","metadata":{"url":"https://example.com/lithium"}}
        ]
      }'
```

## 6. Run Semantic Search
```bash
curl -X POST http://localhost:5213/v1/semantic/search \
  -H 'Content-Type: application/json' \
  -d '{
        "query": "battery technology",
        "k": 2
      }'
```

## 7. Try the RAG Endpoint
```bash
curl -X POST http://localhost:5213/v1/semantic/rag \
  -H 'Content-Type: application/json' \
  -d '{
        "query": "Summarize battery trends",
        "sessionId": "demo-session",
        "k": 2,
        "summaryLevels": ["headline","paragraph"]
      }'
```

## 8. Inspect Session Memory
```bash
curl http://localhost:5213/v1/memory/demo-session
```

## 9. Next Steps
- Explore detailed docs in `docs/api/ENDPOINTS.md`
- Run tests: `npm run lint && npm run test:unit`
- Check `examples/` for scripted demos
- Follow `docs/guides/RAG_SETUP.md` for multi-query pipelines

> When network access becomes available, swap the deterministic providers with LangChain integrations using the same configuration knobs.
