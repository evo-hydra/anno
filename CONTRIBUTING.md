# Contributing to Anno

Thanks for helping build Anno! This doc focuses on the workflow that matches the current code base (Node.js TypeScript service + deterministic semantic stack).

---

## Getting Started
1. **Fork and clone**
   ```bash
   git clone https://github.com/your-username/anno.git
   cd anno
   git remote add upstream https://github.com/original-org/anno.git
   ```
2. **Install dependencies**
   ```bash
   npm install
   ```
3. **Environment variables** – copy `.env.local.example` (or create `.env.local`) and set:
   ```
   PORT=5213
   AI_EMBEDDING_PROVIDER=deterministic
   AI_VECTOR_STORE=memory
   AI_SUMMARIZER=heuristic
   AI_DEFAULT_K=3
   RENDERING_ENABLED=true
   RENDER_STEALTH=true
   ```
   > Toggle these values once LangChain providers are installed; see `docs/guides/LANGCHAIN_INTEGRATION.md`.

---

## Development Workflow
- **Start the service**
  ```bash
  npm run dev          # local hot reload
  # or
  docker compose up --build
  ```
- **Run lint & tests** before pushing:
  ```bash
  npm run lint
  npm run test:unit
  ```
  Unit tests cover content distillation, semantic search, RAG pipeline, memory store, and summarizer.

- **Formatting** – we rely on ESLint + TypeScript strict mode. Avoid large diffs unrelated to your change.

---

## Project Layout Snapshot
```
src/
 ├── api/routes/         # REST endpoints (/v1/content, /v1/semantic, /v1/memory)
 ├── ai/                 # Embeddings, vector store, summarizer, RAG pipeline
 ├── core/               # Fetchers, distillation, rate limiting
 ├── services/           # Semantic service factory, cache, renderer
 └── utils/              # Logging, metrics
examples/                # Runnable demos (news, FlipIQ, batch RAG)
docs/                    # Guides, API reference, architecture notes
project-management/      # Sprint plans & status docs
```

---

## Making Changes
1. **Create a branch** – `git checkout -b feature/semantic-redis`
2. **Write code + tests** – keep functions small and deterministic.
3. **Update docs** – if API contracts or env vars change, update the relevant guide in `docs/`.
4. **Commit** – follow conventional commit style if possible (`feat: ...`, `fix: ...`).
5. **Pull Request** – explain the change, link to docs/tests, call out any follow-up work.

---

## Security Notes
- Do not commit real API keys or proxy credentials. Use `.env.local` and your secret manager.
- If you expose Anno beyond localhost, put it behind an authenticated proxy (API key or mTLS) and enable rate limiting.
- Respect `robots.txt` and eBay’s terms unless you have written clearance.

---

## Need Help?
- Sprint roadmap: `project-management/sprints/SPRINT_03_PLAN.md`
- Current status: `project-management/sprints/SPRINT_03_STATUS.md`
- Health overview: `docs/wiki/PROJECT_HEALTH.md`

Happy hacking!
