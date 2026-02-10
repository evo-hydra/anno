# Anno Deployment & Security Notes

## Local Development
- `npm run dev` or `docker compose up --build`
- Default port: `5213`
- Deterministic semantic stack, no external dependencies required

## Production Checklist
1. **Network placement** – run Anno behind an API gateway or reverse proxy (NGINX, Traefik, AWS ALB).
2. **Authentication** – issue API keys or use mTLS/JWT to restrict access. All endpoints are unauthenticated by default.
3. **TLS termination** – terminate HTTPS at the load balancer or proxy. Anno itself runs HTTP.
4. **Rate limiting** – configure per-route limits to avoid abuse (especially `/v1/content/fetch` and `/v1/semantic/*`).
5. **Environment secrets** – store API keys, proxy credentials, and LLM tokens in a secret manager. Do not commit `.env.local`.
6. **Robots & compliance** – Anno respects `robots.txt` unless `RESPECT_ROBOTS=false`. Obtain legal approval before disabling.
7. **Monitoring** – export `/metrics` to Prometheus and watch latency for embeddings/RAG once LLM providers are live.
8. **Persistence** – in-memory vector store and memory entries are ephemeral. For production, integrate Redis/Pinecone (pending Sprint 3 follow-up).

## Cloud-Hosted LLMs
- Once LangChain integrations are installed, set `AI_LLM_PROVIDER` and `AI_EMBEDDING_PROVIDER` accordingly.
- Ensure outbound network policies allow access to LLM APIs; use VPC endpoints or secure proxies as needed.
- Monitor token usage; implement caching for repeated queries.

## Security & Auth Checklist

### ✅ Sprint 4: Built-in Security Features (ENABLED)

Anno now includes production-ready security features:

#### 1. **API Key Authentication** 🔐
```bash
# Enable authentication
API_AUTH_ENABLED=true
API_KEYS=your-secret-key-1,your-secret-key-2,your-secret-key-3
API_KEY_HEADER=X-API-Key  # Optional, defaults to X-API-Key
```

- SHA-256 hashed keys for secure comparison
- Multi-key support for different clients
- Auto-disabled in development (NODE_ENV !== production)
- Fail-closed security (requires keys when enabled)

**Usage**: Include API key in request header:
```bash
curl -H "X-API-Key: your-secret-key-1" http://localhost:5213/v1/semantic/search
```

#### 2. **Rate Limiting** ⏱️
```bash
# Enable rate limiting
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=100      # Max requests
RATE_LIMIT_WINDOW_MS=60000       # Per 60 seconds (1 minute)
```

- Token bucket algorithm for smooth limiting
- Per-API-key or per-IP tracking
- Standard X-RateLimit-* headers in responses
- Automatic cleanup of old tracking data

#### 3. **Audit Logging** 📝
```bash
# Optional audit log configuration
AUDIT_LOG_REQUEST_BODY=false     # Log request bodies (may contain sensitive data)
AUDIT_LOG_RESPONSE=false         # Log response data
```

- Structured JSON logs for all /v1/* requests
- Tracks: method, path, IP, API key (hashed), status, timing
- Integrates with Winston logger
- Privacy-aware (anonymizes sensitive data)

#### 4. **Prompt Injection Detection** 🛡️
Automatic protection against malicious AI prompts:

- **10 threat types detected**: instruction injection, role manipulation, system prompt leaks, jailbreaks, encoding attacks, etc.
- **RAG pipeline integration**: Queries and retrieved content are analyzed
- **Automatic sanitization**: Malicious content is removed/neutralized
- **Safety metadata**: Responses include threat warnings when detected

Enabled by default in RAG pipeline. Disable per-request:
```typescript
await ragPipeline.run({ query: "...", enableSafety: false });
```

#### 5. **Security Metrics** 📊
Monitor security events via `/metrics` endpoint:

```prometheus
# Authentication
anno_security_auth_failures_total
anno_security_auth_success_total

# Rate Limiting
anno_security_rate_limit_exceeded_total

# Prompt Injection
anno_security_prompt_injections_total{threat_type="instruction_injection"}
anno_security_unsafe_queries_total
anno_security_unsafe_content_total
anno_security_sanitizations_total
```

### 🔒 Production Deployment Checklist

Before deploying to production:

- [x] **Enable API authentication** (`API_AUTH_ENABLED=true`)
- [x] **Configure API keys** (use secrets manager, not .env files)
- [x] **Enable rate limiting** (`RATE_LIMIT_ENABLED=true`)
- [ ] **TLS termination** at load balancer/proxy (HTTPS)
- [ ] **Network isolation** (run behind API gateway/reverse proxy)
- [x] **Audit logging** enabled for compliance
- [x] **Prompt injection protection** active on AI endpoints
- [ ] **Monitor /metrics** in Prometheus/Grafana
- [ ] **Secret rotation** plan for API keys
- [ ] **Backup strategy** for Redis (if using persistent vector store)

### 🚀 Example Production Configuration

```bash
# Security
NODE_ENV=production
API_AUTH_ENABLED=true
API_KEYS=${SECRET_API_KEYS}  # Load from secrets manager

RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX_REQUESTS=100
RATE_LIMIT_WINDOW_MS=60000

# AI/LLM
AI_LLM_PROVIDER=openai
AI_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=${SECRET_OPENAI_KEY}

# Vector Store (optional Redis persistence)
AI_VECTOR_STORE=redis
REDIS_ENABLED=true
REDIS_URL=redis://redis:6379

# Monitoring
AUDIT_LOG_REQUEST_BODY=false
AUDIT_LOG_RESPONSE=false
```

### 📖 Additional Resources

- **LangChain Setup**: `docs/guides/LANGCHAIN_INTEGRATION.md`
- **Sprint 3 Status**: `project-management/sprints/SPRINT_03_STATUS.md` (AI features)
- **Sprint 4 Status**: `project-management/sprints/SPRINT_04_STATUS.md` (Security features)
