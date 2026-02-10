# Anno Project Health Wiki

## Snapshot
- Last updated: 2025-10-03
- Branch: master (`git rev-parse --abbrev-ref HEAD`)
- Commit: 4ec67f46aaa848d292154868454293b441714c4f
- Runtime: Node.js >= 18 (`package.json`)
- Service entrypoint: `src/server.ts:1`
- Primary API surface: `POST /v1/content/fetch` (`src/api/routes/content.ts:1`), `GET /health`, `GET /metrics`

## Automated Checks & Tooling
| Check | Status | Evidence |
| ----- | ------ | -------- |
| `npm run build` | PASS | TypeScript compile succeeded (2025-10-03)
| `npm run lint` | PASS | Clean run after type/cleanup fixes (`src/services/distiller.ts`, `src/core/rate-limiter.ts`, `src/core/robots-parser.ts`) on 2025-10-03
| `npm run test:unit` | PASS | Content-addressing + fetcher suites green after metric/canonicalization patches (2025-10-03)
| `npm outdated --json` | BLOCKED | Registry lookup denied by sandbox (`EAI_AGAIN`)

## Test Failures
- None. Latest `npm run test:unit` (2025-10-03) covers content addressing, distiller, and fetcher suites.
  - Historical context: whitespace canonicalization drift (`src/core/content-addressing.ts`) and fallback metric over-counting (`src/services/fetcher.ts`, `src/services/metrics.ts`) resolved in this run.

- **Key Components**
- **Fetching pipeline:** `src/core/pipeline.ts:1` orchestrates `fetchPage`, distillation, confidence scoring, and NDJSON streaming.
- **HTTP/Rendered fetcher:** `src/services/fetcher.ts:1` handles cache lookups, renderer fallback, robots compliance, and metrics emission. Rendering defaults to disabled via `config.rendering.enabled` (`src/config/env.ts:53`).
- **Content distillation:** `src/services/distiller.ts:1` delegates to Ollama, Readability, DOM heuristics, and an eBay adapter for structured output. A DOM fallback path now activates when heuristic extraction yields zero nodes.
- **Caching & rate limiting:** `src/services/cache.ts`, `src/core/rate-limiter.ts:1`, and `src/core/robots-parser.ts:1` provide in-memory cache, per-domain token bucket, and robots.txt enforcement.
- **Observability:** Metrics aggregation (`src/services/metrics.ts:1`) exposes Prometheus counters/histograms. Express health endpoint consolidates cache, renderer, robots, and latency stats (`src/server.ts:12`).
- **AI scaffolding:** `src/ai/embedding-provider.ts`, `src/ai/vector-store.ts`, `src/ai/semantic-search.ts`, `src/ai/memory.ts`, and `src/ai/summarizer.ts` provide deterministic embeddings, in-memory vector storage, semantic search, session memory, and a heuristic summarizer pending LLM integration.
- **AI scaffolding:** `src/ai/embedding-provider.ts`, `src/ai/vector-store.ts`, `src/ai/semantic-search.ts`, `src/ai/memory.ts`, `src/ai/summarizer.ts`, and `src/ai/rag-pipeline.ts` provide deterministic embeddings, in-memory vector storage, semantic search, RAG orchestration, and session memory. Provider selection is controlled via `config.ai` in `src/config/env.ts`.
- **Dev tooling:** `docker-compose.yml` and `Dockerfile` enable one-command startup (`docker compose up --build`) with hot reload via bind mounts.

- **Observability & Ops**
- `/health` returns renderer/cache/metrics snapshots (`src/server.ts:19`).
- `/metrics` exposes Prometheus text format including render latency histograms (`src/server.ts:41`, `src/services/metrics.ts:200`).
- Metrics reset endpoint guarded by `config.metrics.allowReset` and optional token (`src/server.ts:47`).
- `scripts/ci-health.sh` bundles build/lint/tests for quick local validation; `scripts/dependency-check.sh` queues `npm outdated` / `npm audit` runs when the network sandbox is lifted; CI workflow lives at `.github/workflows/ci-health.yml`.
- Dependency snapshots belong under `docs/wiki/dependencies/` (see README for instructions).

## Known Issues & Risks
- **Metric clarity:** Cache-level counters now reflect storage hits/misses, but request-level cache efficacy is tracked separately via `totalFromCache`; document this distinction when onboarding (`src/services/metrics.ts:40`).
- **Rate limiting latency:** Production default remains 1 req/sec per domain; test harness now stubs waits, but integration environments may still need tuned limits (`src/core/rate-limiter.ts:129`).
- **Dependency visibility:** Cannot audit/outdate packages due to restricted network; baseline still on Express 5 beta and Playwright core 1.55.

## Roadmap Alignment
- Current implementation maps to early Phase 1 (transport + content distillation) of `ROADMAP.md`. Multi-agent coordination (`src/agents`) and probabilistic truth layers exist as stubs but lack full coverage. Compare sprint targets in `project-management/sprints/SPRINT_01.md` and `SPRINT_02.md` for next deliverables.
- Active MVP focus: stabilize content addressing (NEURO-102), caching, and renderer metrics per sprint tracker `project-management/SPRINT_01_TRACKER.md`.

## Pending Actions
1. Broaden canonicalization coverage with nested/attribute-heavy fixtures and snapshot expectations (`src/__tests__/content-addressing.test.ts`).
2. Expand rate-limiter regression coverage to include multi-request sequences and assert on recorded wait distributions (`src/__tests__/fetcher.test.ts`).
3. Integrate `scripts/ci-health.sh` into a hosted CI/CD workflow (GitHub Actions or similar) to keep results visible to collaborators.
4. Implement LangChain adapters, memory store, and RAG pipeline atop new AI scaffolding (`src/ai/`).
5. When network access is available, execute `scripts/dependency-check.sh` and capture the summarized output here.
6. Evaluate renderer max concurrency defaults vs. tests in `src/__tests__/fetcher.test.ts` to ensure determinism when Playwright is enabled.
7. Sprint 4: security hardening (prompt injection detection, auth/rate limiting) per `project-management/sprints/SPRINT_04_PLAN.md`.

## Immediate Next Steps
1. **CI integration planning**
   - Draft a lightweight GitHub Actions (or equivalent) definition that invokes `scripts/ci-health.sh` and surfaces artifacts/logs for remote collaborators.
2. **Dependency snapshot tracking**
   - Define where to store dependency check outputs (e.g., `docs/wiki/dependencies/DATE.md`) once `scripts/dependency-check.sh` can run successfully.
3. **Canonicalization fixtures**
   - Collect example pages with tricky attribute whitespace and encode them as fixtures for `src/__tests__/content-addressing.test.ts`.

## Reference Docs
- `README.md` – product vision and quick start.
- `ARCHITECTURE.md` – high-level layer definitions.
- `ROADMAP.md` – 18-month phased milestones.
- `docs/guides/DEVELOPER_SETUP.md` – environment configuration.
- `docs/guides/DEPLOYMENT.md` – security and hosting checklist.
- `project-management/SPRINT_OVERVIEW.md` and linked sprint plans – execution schedule.

- 2025-10-03: Session memory endpoints and RAG pipeline scaffolded; semantic API exposed under `/v1/semantic/*` and `/v1/memory/*`.
- 2025-10-03: Docker Compose support added for one-command dev; Quick Start updated with container instructions.
- 2025-10-03: Quick start + RAG guides and functional examples added; semantic docs updated with curl samples.
- 2025-10-03: FlipIQ eBay pricing guide published (`docs/guides/FLIPIQ_EBAY_PRICING.md`) covering stealth scraping workflow.
- 2025-10-03: Initial AI layer scaffolding landed (deterministic embeddings, in-memory vector store, semantic search tests); Sprint 3 plan documented.
- 2025-10-03: CI workflow stub, dependency snapshot directory, and canonicalization fixtures added; wiki updated accordingly.
- 2025-10-03: CI tooling scripts added; rate limiter tests stub heavy waits; wiki refreshed with new automation guidance.
- 2025-10-03: Canonicalization + metrics patches landed; lint/test suites passing and wiki refreshed.
- 2025-10-03: Initial health assessment recorded; lint/test failures captured and automation gaps noted.
