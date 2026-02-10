# Anno API Reference

> **Status:** Updated for Sprint 3 deterministic AI stack. When LangChain/LLM integrations are available this file will gain streaming examples and additional providers.

## Security Note

**⚠️ Production Deployment Required**: Authentication and rate limiting are expected in production deployments. All endpoints are unauthenticated by default. See the [Security & Auth Checklist](../guides/DEPLOYMENT.md#security--auth-checklist) in the deployment guide for essential security considerations.

## Conventions
- Base URL: `http://localhost:5213`
- All requests/response bodies are JSON unless otherwise noted.
- Authentication: Not yet implemented (future work).
- Rate limiting: TBD (document defaults once limiter is extended).

---

## Contents
1. [Content Fetch](#content-fetch)
2. [Semantic Search](#semantic-search)
3. [RAG Pipeline](#rag-pipeline)
4. [Summaries](#summaries)
5. [Session Memory](#session-memory)
6. [Health & Metrics](#health--metrics)

---

## Content Fetch
`POST /v1/content/fetch`
- **Summary:** Existing endpoint for streaming distilled content.
- **Request Body:**
  ```json
  {
    "url": "https://example.com/article",
    "options": { "useCache": true, "maxNodes": 40, "render": false }
  }
  ```
- **Response:** `application/x-ndjson` stream (document event structure documented in `README.md`).
- **Notes:** Reuse from Sprint 2; include reference link when final doc is written.

Example NDJSON sequence (abridged):
```
{"type":"metadata","payload":{"url":"https://example.com/article", ...}}
{"type":"node","payload":{"id":"node-0","text":"Paragraph text"}}
{"type":"done","payload":{"nodes":3,"title":"Example Article"}}
```

## Semantic Search
`POST /v1/semantic/search`
- **Purpose:** Query cached embeddings and return similar documents.
- **Request:**
  ```json
  {
    "query": "latest solid state battery breakthroughs",
    "k": 5,
    "filter": { "tags": ["battery"], "source": "news" },
    "minScore": 0.4
  }
  ```
- **Response:**
  ```json
  {
    "results": [
      {
        "id": "doc-1",
        "score": 0.82,
        "metadata": { "url": "https://example.com/article" },
        "content": "First 200 characters of the stored content..."
      }
    ]
  }
  ```
- **Status Codes:**
  - `200 OK`
  - `400 Bad Request` – payload failed validation

### Index Documents (temporary helper)
`POST /v1/semantic/index`
- Seed the in-memory vector store during development.
- Body: `{ "documents": [{ "id": "doc-1", "text": "Document body", "metadata": { "url": "https://example.com" } }] }`
- Response: `{ "status": "indexed", "count": 1 }`

## RAG Pipeline
`POST /v1/semantic/rag`
- **Purpose:** Retrieval augmented generation using the indexed corpus and deterministic summarizer.
- **Request:**
  ```json
  {
    "query": "Summarize Nvidia's latest AI chip announcements",
    "sessionId": "session-demo",
    "k": 3,
    "summaryLevels": ["headline", "paragraph"]
  }
  ```
- **Response:**
  ```json
  {
    "answer": "Concise synthesis with sentence count metadata...",
    "citations": [
      { "id": "doc-1", "score": 0.81, "url": "https://example.com/article" }
    ],
    "summaries": {
      "headline": "Key finding...",
      "paragraph": "Expanded context..."
    }
  }
  ```
- Session memory is updated automatically when `sessionId` is provided.
- **Status Codes:**
  - `200 OK`
  - `400 Bad Request` – validation failure

> **Note:** Responses currently use heuristic summaries. Flip `AI_SUMMARIZER=llm` once LangChain integration is available to obtain LLM-backed answers.

## Summaries
`POST /v1/semantic/summaries` *(planned)*
- **Purpose:** Produce multi-level summaries ("headline", "paragraph", "detailed").
- **Request:**
  ```json
  {
    "contentHash": "sha256:...",
    "levels": ["headline", "paragraph"]
  }
  ```
- **Response:**
  ```json
  {
    "summaries": {
      "headline": "...",
      "paragraph": "..."
    }
  }
  ```

## Session Memory
`GET /v1/memory/{sessionId}`
- Retrieve persistent memory state for a session.
- Response example:
  ```json
  {
    "sessionId": "session-demo",
    "entries": [
      { "type": "summary", "content": "...", "createdAt": 1735939200 }
    ]
  }
  ```

`POST /v1/memory/{sessionId}/entries`
- Append a new memory entry.
- Body: `{ "content": "Observation text", "type": "note", "metadata": { "source": "rag" } }`
- Response: `{ "status": "queued" }`

`DELETE /v1/memory/{sessionId}`
- Clears all entries for the session. Returns `204 No Content`.

### Status Codes Summary

| Endpoint | Success | Validation | Not Found |
|----------|---------|-----------|-----------|
| `/v1/semantic/index` | 202 | 400 | – |
| `/v1/semantic/search` | 200 | 400 | – |
| `/v1/semantic/rag` | 200 | 400 | – |
| `/v1/memory/{sessionId}` (GET) | 200 | – | 404 |
| `/v1/memory/{sessionId}/entries` | 202 | 400 | – |
| `/v1/memory/{sessionId}` (DELETE) | 204 | – | – |

## Health & Metrics
- `/health` and `/metrics` already documented. Extend with AI subsystem stats (embedding latency, vector store load, RAG success) when available.

---

> TODO: Add rate limiting/authentication details and streaming response guidance when those features land.
- **Error body:** `{ "error": "invalid_request", "details": { ... } }`
- Body: `{ "documents": [{ "id": "doc-1", "text": "Document body", "metadata": { "url": "https://example.com" } }] }`
- Response: `{ "status": "indexed", "count": 1 }`
