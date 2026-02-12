# Contributing to Anno

Thanks for helping build Anno! This guide covers the workflow for contributing to the project.

---

## Getting Started

1. **Fork and clone**
   ```bash
   git clone https://github.com/your-username/anno.git
   cd anno
   git remote add upstream https://github.com/evo-nirvana/anno.git
   ```

2. **Install dependencies**
   ```bash
   npm install --legacy-peer-deps
   ```
   > The `--legacy-peer-deps` flag is required due to LangChain peer dependency conflicts.

3. **Environment variables** — copy `.env.local.example` (or create `.env.local`) and set:
   ```
   PORT=5213
   RENDERING_ENABLED=true
   RENDER_STEALTH=true
   ```

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
  npm test             # runs ESLint + Vitest (all tests)
  npx vitest run       # tests only (no lint)
  ```

- **Formatting** — we use ESLint flat config (`eslint.config.mjs`) with TypeScript strict mode. Avoid large diffs unrelated to your change.

---

## Project Layout

```
src/
 ├── api/routes/         # REST endpoints (/v1/content)
 ├── ai/                 # Embeddings, vector store, summarizer, RAG pipeline
 ├── cli/                # Commander CLI interface
 ├── config/             # Environment config (env.ts), domain config
 ├── core/               # Extraction ensemble, confidence scoring, pipeline
 ├── mcp/                # Model Context Protocol server
 ├── middleware/          # Auth, rate limiting, error handling
 ├── policies/           # Domain-aware distillation policy presets (YAML)
 ├── services/           # Fetcher, distiller, renderer, cache, crawler
 ├── types/              # Shared TypeScript interfaces
 └── utils/              # Logging, metrics, URL validation
```

---

## Making Changes

1. **Create a branch** — `git checkout -b feature/your-feature`
2. **Write code + tests** — keep functions small and deterministic.
3. **Update docs** — if API contracts or env vars change, update the relevant docs.
4. **Commit** — follow conventional commit style (`feat: ...`, `fix: ...`, `test: ...`).
5. **Pull Request** — explain the change, link to docs/tests, call out any follow-up work.

---

## Developer Certificate of Origin (DCO)

All contributions must include a DCO sign-off. This certifies that you have the right to submit the work under the project's MIT license.

Add the `-s` flag when committing:

```bash
git commit -s -m "feat: add new extraction method"
```

This appends a `Signed-off-by` line to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off, you agree to the [DCO](https://developercertificate.org/):

> I certify that this contribution is made under the terms of the MIT License
> and that I have the right to submit it under those terms.

---

## Security Notes

- Do not commit real API keys or credentials. Use `.env.local` and your secret manager.
- If you expose Anno beyond localhost, put it behind an authenticated proxy and enable rate limiting.
- Respect `robots.txt` and site terms of service.

---

## License

This project is licensed under the [MIT License](LICENSE).

Happy hacking!
