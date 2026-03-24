---
name: Anno Session Auth — Cloudflare-Cleared Cookie Provider
project: /home/evo-nirvana/dev/projects/nebuchadnezzar/anno
created: 2026-03-22
test_command: "npm run test:unit"
---

## 1. Add session auth HTTP endpoint to Anno server
- **files**: src/api/routes/session-auth.ts, src/server.ts
- **do**: Create a new Express route `POST /v1/session/auth` that accepts `{ domain: string, url: string, cookies?: Array<{name, value, domain}>, waitFor?: string }`. The handler: (1) Creates a Playwright session via RendererManager with stealth enabled, (2) Injects any provided seed cookies (e.g., sessionKey from Claude CLI), (3) Navigates to the URL, (4) Waits for Cloudflare challenge to resolve (detect via wall-detector, then wait for `networkidle` or a `waitFor` selector), (5) Extracts all cookies from the browser context via `context.cookies()`, (6) Returns `{ success: boolean, cookies: Array<{name, value, domain, path, expires, httpOnly, secure, sameSite}>, challengeDetected: boolean }`. Use the existing RendererManager singleton — don't create a new browser instance. Import wall-detector to log whether a challenge was encountered. Register the route in server.ts alongside existing routes.
- **done-when**: `POST /v1/session/auth` with `{ domain: "claude.ai", url: "https://claude.ai", cookies: [{name: "sessionKey", value: "test", domain: ".claude.ai"}] }` returns a cookie array including `cf_clearance` (when Cloudflare is present) or the full cookie jar. Endpoint returns 400 for missing domain/url. Non-rendered fallback returns seed cookies unchanged if Playwright is unavailable.
- **status**: done
- **size**: large
- **seraph_id**: eb297a1c660e4fc3b7d5a7a29cde4cb6
- **lessons**: rendererManager.withPage already supports cookie injection — no new API needed. wall-detector detects but doesn't solve; waitForNavigation handles resolution.

## 2. Expose session auth as MCP tool (anno_session_auth)
- **files**: src/mcp/server.ts
- **do**: Add a new MCP tool `anno_session_auth` that calls the `/v1/session/auth` endpoint. Parameters: `domain` (string, required), `url` (string URL, required), `cookies` (optional array of `{name, value, domain}` objects for seed cookies), `waitFor` (optional string CSS selector to wait for after navigation). The tool calls `annoRequest('/v1/session/auth', { method: 'POST', body })` and returns the cookie array as formatted JSON text. Follow the exact pattern of `anno_fetch` — same error handling, same ECONNREFUSED check, same response structure. Description should emphasize: "Authenticate with Cloudflare-protected sites by navigating with a real browser. Injects seed cookies, solves challenges, returns the full cookie jar including cf_clearance."
- **done-when**: `anno_session_auth` appears in MCP tool list. Calling it with domain + url + seed cookies returns the cookie jar JSON. Error cases (missing params, server down) return helpful messages.
- **status**: done

## 3. Wire desktop app to use Anno for Dispatch auth
- **files**: /home/evo-nirvana/dev/projects/claude-code-desktop-ubuntu/src/main/dispatch/credentials.ts
- **do**: Add a `resolveCloudflareAuth` method to `DispatchCredentials` that shells out to Anno's HTTP API. The method: (1) Reads the OAuth access token from `~/.claude/.credentials.json` (existing `getAccessToken()`), (2) Calls `POST http://localhost:5213/v1/session/auth` with `{ domain: "claude.ai", url: "https://claude.ai/api/organizations", cookies: [{ name: "sessionKey", value: accessToken, domain: ".claude.ai" }] }`, (3) Parses the response cookies, extracts `cf_clearance` and the org UUID from the successful API response, (4) Caches the `cf_clearance` with its expiry. Update `getRemoteOptions()` to call `resolveCloudflareAuth()` and include the `cfClearance` value. Update `discoverOrgUuid()` to include the `cf_clearance` cookie in its fetch headers. Add a `ANNO_BASE_URL` env var (default `http://localhost:5213`) so the Anno endpoint is configurable. If Anno is unreachable, fall back to current behavior (direct fetch, which will fail on Cloudflare but works in test).
- **done-when**: With Anno running, `getRemoteOptions()` returns a `cfClearance` value extracted from Anno's Playwright session. `discoverOrgUuid()` succeeds because the cf_clearance cookie bypasses Cloudflare. Desktop app logs `[dispatch] Registered: env-xxx` on startup.
- **status**: done

## 4. Add tests for session auth endpoint
- **files**: src/__tests__/session-auth.test.ts
- **do**: Write unit tests for the session auth route handler: (1) Returns 400 when domain or url missing, (2) Returns seed cookies unchanged when Playwright is unavailable (graceful degradation), (3) Returns cookies from Playwright context when rendering succeeds (mock RendererManager.withPage to return fake cookies), (4) Detects and reports Cloudflare challenge via wall-detector. Mock the renderer and wall-detector — don't launch a real browser in tests. Follow the test patterns in the codebase (vi.mock at file scope, vi.hoisted for complex mocks).
- **done-when**: Tests pass. `npm run test:unit` passes clean including new tests.
- **status**: done
