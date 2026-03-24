---
name: Anno Web Autonomy — Ride the Bike
project: /home/evo-nirvana/dev/projects/nebuchadnezzar/anno
created: 2026-03-23
test_command: "npm run lint && npx vitest run"
---

## 1. Wire anno_interact MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_interact` MCP tool that calls POST /v1/interact. Accept url, actions array (click/fill/select/scroll/hover/type/waitFor/evaluate), optional extract boolean, and optional sessionId. Return action results + page state (interactive elements with selectors). Description should emphasize this is for acting on web pages — clicking buttons, filling forms, navigating.
- **done-when**: `anno_interact` tool appears in MCP tool list, accepts url + actions + extract params, returns structured action results and page state from the interact endpoint
- **status**: done
- **seraph_id**: b38a5654fc7349499a843f3203e2168d

## 2. Wire anno_screenshot MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_screenshot` MCP tool that calls POST /v1/interact/screenshot. Accept url, optional actions to execute before capture, fullPage boolean. Return base64 image as MCP image content type + page state. This gives AI agents eyes — visual context to reason about unfamiliar pages.
- **done-when**: `anno_screenshot` tool appears in MCP tool list, returns image content block and page state JSON
- **status**: done

## 3. Wire anno_page_state MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_page_state` MCP tool that calls POST /v1/interact/page-state. Accept url, optional pre-actions. Return structured inventory of all interactive elements on the page (buttons, links, inputs, selects) with their selectors, text, and attributes. Description: "Discover what you can interact with on a page before deciding what to do."
- **done-when**: `anno_page_state` tool appears in MCP tool list, returns structured interactive element inventory
- **status**: done

## 4. Wire anno_workflow MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_workflow` MCP tool that calls POST /v1/workflow. Accept a workflow definition object (name, steps array with fetch/interact/extract/wait/screenshot/setVariable/if/loop step types, optional variables). Return step results, extractions, and screenshots. Description: "Execute a multi-step browser workflow with conditionals, loops, and variable interpolation."
- **done-when**: `anno_workflow` tool appears in MCP tool list, accepts workflow definition and returns structured results
- **status**: done

## 5. Wire anno_watch MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_watch` MCP tool that calls POST /v1/watch (create) and GET /v1/watch/:id (status check). Accept url, interval (seconds, min 60), changeThreshold (0-100%), optional webhookUrl. Return watchId on create. Include a `watchId` param for checking status of existing watches. Description: "Monitor a URL for content changes over time."
- **done-when**: `anno_watch` tool appears in MCP tool list, can create watches and check their status
- **status**: done

## 6. Wire anno_search MCP tool
- **files**: src/mcp/server.ts
- **do**: Add `anno_search` MCP tool that calls POST /v1/semantic/search. Accept query string, optional k (1-20), minScore, filter. Return ranked similarity results from previously indexed content. Description: "Search over previously extracted web content using semantic similarity."
- **done-when**: `anno_search` tool appears in MCP tool list, returns ranked search results
- **status**: done

## 7. Thread sessionId through all MCP interaction tools
- **files**: src/mcp/server.ts, src/api/routes/interact.ts, src/api/routes/session-auth.ts
- **do**: Add optional `sessionId` parameter to anno_interact, anno_screenshot, anno_page_state, anno_fetch, and anno_workflow MCP tools. When provided, reuse the existing browser session from SessionManager instead of creating an ephemeral page. When omitted, create a fresh session and return its sessionId in the response so the agent can continue the session in subsequent calls. The interact route currently uses `rendererManager.withPage()` for ephemeral pages — add a branch that uses `sessionManager.getSession(sessionId)` when sessionId is provided. anno_session_auth should also return a sessionId so its authenticated cookies can be used in follow-up calls.
- **done-when**: MCP tools accept sessionId, reuse browser sessions across calls, and return sessionId in responses. An agent can: session_auth → interact → screenshot → fetch in sequence on the same browser context.
- **status**: done
- **size**: large
- **seraph_id**: 4b70a2b3c95e4653a2acb431449ca599

## 8. Add anno_observe MCP tool — page comprehension
- **files**: src/mcp/server.ts, src/services/page-observer.ts, src/api/routes/interact.ts
- **do**: Create a new `anno_observe` MCP tool and backing service. Combines page_state + content extraction + page classification into a single "what am I looking at?" response. Returns: pageType (login, search-results, article, product, checkout, form, dashboard, unknown), interactive elements summary, navigation options, detected patterns (captcha, paywall, cookie consent), key content summary. This is the comprehension layer — the thing nobody else does. Accept url and optional sessionId.
- **done-when**: `anno_observe` tool returns structured page classification with interactive elements, navigation options, and detected patterns. Works with and without sessionId.
- **status**: done
- **size**: large
- **seraph_id**: dd5ac3cf1dca4558a0c1449bfeb11e7f

## 9. Rewrite MCP tool descriptions for web autonomy positioning
- **files**: src/mcp/server.ts, package.json
- **do**: Rewrite all existing MCP tool descriptions (anno_fetch, anno_batch_fetch, anno_crawl, anno_session_auth, anno_health) to frame Anno as the web autonomy layer, not a content extractor. Update package.json description from "Web content extraction for AI agents" to "Web autonomy for AI agents — navigate, authenticate, interact, and extract with a stealth browser." Update MCP server name/description. anno_fetch description should lead with navigation + comprehension, not token reduction.
- **done-when**: All tool descriptions reframed around web autonomy identity. package.json description updated. No tool description uses "content extraction" as the primary framing.
- **status**: done

## 10. Add MCP tool tests
- **files**: src/__tests__/mcp-server.test.ts
- **do**: Add unit tests for the new MCP tools (anno_interact, anno_screenshot, anno_page_state, anno_workflow, anno_watch, anno_search, anno_observe). Mock the HTTP calls to the Anno REST API. Verify each tool: accepts correct params, calls the right endpoint, formats the response properly, handles errors gracefully, handles sessionId threading.
- **done-when**: Tests pass for all new MCP tools. Error cases covered. SessionId flow tested end-to-end (mocked).
- **status**: done
- **size**: large
- **seraph_id**: 94e504a80d464f63afd95eb0311585fc
