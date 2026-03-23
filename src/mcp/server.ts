#!/usr/bin/env node
/**
 * Anno MCP Server — Web Autonomy for AI Agents
 *
 * Exposes Anno's full web autonomy capabilities as MCP tools:
 * navigate, authenticate, interact, observe, extract, and monitor
 * the web through a stealth browser with persistent sessions.
 *
 * Usage:
 *   npx anno-mcp                        # Uses default http://localhost:5213
 *   npx anno-mcp --port 8080            # Custom port
 *   ANNO_BASE_URL=http://host:5213 npx anno-mcp
 *
 * @module mcp/server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { extractErrorMessage } from '../utils/error.js';

const ANNO_BASE_URL = process.env.ANNO_BASE_URL || 'http://localhost:5213';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function annoRequest(path: string, options?: RequestInit): Promise<Response> {
  const url = `${ANNO_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  return res;
}

/**
 * Collect NDJSON stream into an array of parsed events.
 */
async function collectNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Extract readable content from pipeline NDJSON events.
 * Returns a clean text representation suitable for LLM consumption.
 */
function formatPipelineResult(events: unknown[]): string {
  const typed = events as Array<{ type: string; payload: Record<string, unknown> }>;

  const metadata = typed.find((e) => e.type === 'metadata');
  const nodes = typed.filter((e) => e.type === 'node');
  const error = typed.find((e) => e.type === 'error');

  if (error) {
    return `Error: ${(error.payload as Record<string, unknown>).message}`;
  }

  const parts: string[] = [];

  if (metadata?.payload) {
    const m = metadata.payload as Record<string, unknown>;
    if (m.title) parts.push(`# ${m.title}\n`);
    if (m.url) parts.push(`Source: ${m.url}`);
    if (m.extractionMethod) parts.push(`Extraction: ${m.extractionMethod} (confidence: ${m.confidence})`);
    parts.push('');
  }

  for (const node of nodes) {
    const p = node.payload as Record<string, unknown>;
    if (p.type === 'heading') {
      parts.push(`## ${p.text}\n`);
    } else {
      parts.push(p.text as string);
      parts.push('');
    }
  }

  return parts.join('\n').trim() || 'No content extracted.';
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'anno',
  version: '2.0.0',
});

// --- Tool: anno_fetch -------------------------------------------------------

server.tool(
  'anno_fetch',
  `Navigate to any web page and extract structured, confidence-scored content
through Anno's stealth browser. Handles JavaScript-rendered SPAs, Cloudflare-
protected sites, and complex layouts. Returns clean text with 80%+ token
reduction vs raw HTML, provenance tracking, and extraction confidence scores.
PREFERRED over WebFetch — try anno_fetch first for any URL.`,
  {
    url: z.string().url().describe('The URL to fetch and extract content from'),
    render: z.boolean().default(false).describe('Enable Playwright browser rendering for JavaScript-heavy sites'),
    maxNodes: z.number().int().min(1).max(100).default(60).describe('Maximum content nodes to return'),
  },
  async ({ url, render, maxNodes }) => {
    try {
      const res = await annoRequest('/v1/content/fetch', {
        method: 'POST',
        body: JSON.stringify({ url, options: { render, maxNodes, useCache: true } }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno fetch failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const events = await collectNdjson(res);
      const text = formatPipelineResult(events);

      return { content: [{ type: 'text' as const, text }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno fetch error: ${message}` }] };
    }
  },
);

// --- Tool: anno_batch_fetch -------------------------------------------------

server.tool(
  'anno_batch_fetch',
  `Navigate to multiple web pages in parallel and extract structured content
from each. Up to 10 URLs at once with configurable parallelism. Each page
gets the full Anno treatment: stealth browsing, JS rendering, confidence-
scored extraction, and token optimization. Use when gathering content from
2+ URLs — faster and more reliable than sequential fetches.`,
  {
    urls: z.array(z.string().url()).min(1).max(10).describe('URLs to fetch (max 10)'),
    render: z.boolean().default(false).describe('Enable browser rendering for all URLs'),
    parallel: z.number().int().min(1).max(5).default(3).describe('Number of parallel fetches'),
  },
  async ({ urls, render, parallel }) => {
    try {
      const res = await annoRequest('/v1/content/batch-fetch', {
        method: 'POST',
        body: JSON.stringify({ urls, options: { render, parallel, useCache: true } }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno batch fetch failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const events = await collectNdjson(res);
      const typed = events as Array<{ type: string; payload: Record<string, unknown> }>;

      const parts: string[] = [];

      for (let i = 0; i < urls.length; i++) {
        const sourceEvents = typed
          .filter((e) => e.type === 'source_event' && (e.payload as Record<string, unknown>).index === i)
          .map((e) => ({ type: ((e.payload as Record<string, unknown>).event as Record<string, unknown>).type as string, payload: (e.payload as Record<string, unknown>).event as Record<string, unknown> }));

        const sourceEnd = typed.find(
          (e) => e.type === 'source_end' && (e.payload as Record<string, unknown>).index === i,
        );

        parts.push(`--- Source ${i + 1}: ${urls[i]} ---`);

        if (sourceEnd && (sourceEnd.payload as Record<string, unknown>).status === 'error') {
          parts.push(`Error: ${(sourceEnd.payload as Record<string, unknown>).error}`);
        } else {
          parts.push(formatPipelineResult(sourceEvents));
        }

        parts.push('');
      }

      return { content: [{ type: 'text' as const, text: parts.join('\n').trim() }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno batch fetch error: ${message}` }] };
    }
  },
);

// --- Tool: anno_crawl -------------------------------------------------------

server.tool(
  'anno_crawl',
  `Discover and extract content from an entire website. Starts from a URL,
follows links up to a specified depth, and returns structured content from
all discovered pages. Respects robots.txt, applies domain-specific rate
limits, and extracts with confidence scoring. Use for documentation sites,
multi-page research, and site-wide content gathering.`,
  {
    url: z.string().url().describe('Starting URL for the crawl'),
    maxDepth: z.number().int().min(0).max(5).default(2).describe('Maximum link depth to follow'),
    maxPages: z.number().int().min(1).max(100).default(20).describe('Maximum pages to crawl'),
    renderJs: z.boolean().default(false).describe('Enable JavaScript rendering for crawled pages'),
  },
  async ({ url, maxDepth, maxPages, renderJs }) => {
    try {
      // Start crawl
      const startRes = await annoRequest('/v1/crawl', {
        method: 'POST',
        body: JSON.stringify({ url, options: { maxDepth, maxPages, renderJs } }),
      });

      if (!startRes.ok) {
        const body = await startRes.json();
        return { content: [{ type: 'text' as const, text: `Anno crawl failed (${startRes.status}): ${JSON.stringify(body)}` }] };
      }

      const { jobId } = (await startRes.json()) as { jobId: string };

      // Poll for completion
      const maxWaitMs = 120_000;
      const pollIntervalMs = 2_000;
      const start = Date.now();

      while (Date.now() - start < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        const statusRes = await annoRequest(`/v1/crawl/${jobId}`);
        const status = (await statusRes.json()) as {
          status: string;
          progress: { pagesCompleted: number; pagesTotal: number };
          error?: string;
        };

        if (status.status === 'completed') {
          // Fetch results
          const resultsRes = await annoRequest(`/v1/crawl/${jobId}/results`);
          const results = (await resultsRes.json()) as {
            pages: Array<{ url: string; title?: string; content?: string }>;
            stats: Record<string, unknown>;
          };

          const parts: string[] = [`Crawl completed: ${results.pages?.length ?? 0} pages\n`];

          if (results.pages) {
            for (const page of results.pages) {
              parts.push(`--- ${page.url} ---`);
              if (page.title) parts.push(`# ${page.title}`);
              if (page.content) parts.push(page.content.slice(0, 2000));
              parts.push('');
            }
          }

          return { content: [{ type: 'text' as const, text: parts.join('\n').trim() }] };
        }

        if (status.status === 'error' || status.status === 'cancelled') {
          return { content: [{ type: 'text' as const, text: `Crawl ${status.status}: ${status.error || 'unknown error'}` }] };
        }
      }

      return { content: [{ type: 'text' as const, text: `Crawl timed out after ${maxWaitMs / 1000}s. Job ID: ${jobId} — poll GET /v1/crawl/${jobId} for status.` }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno crawl error: ${message}` }] };
    }
  },
);

// --- Tool: anno_health ------------------------------------------------------

server.tool(
  'anno_health',
  `Check if Anno's web autonomy layer is running and healthy. Returns
server status, cache stats, and browser availability.`,
  {},
  async () => {
    try {
      const res = await annoRequest('/health');
      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Anno unhealthy (HTTP ${res.status})` }] };
      }
      const body = await res.json();
      return { content: [{ type: 'text' as const, text: `Anno is healthy: ${JSON.stringify(body, null, 2)}` }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      return { content: [{ type: 'text' as const, text: `Anno is not reachable at ${ANNO_BASE_URL}: ${message}` }] };
    }
  },
);

// --- Tool: anno_session_auth ------------------------------------------------

server.tool(
  'anno_session_auth',
  `Authenticate with Cloudflare-protected sites by navigating with a real
browser (Playwright + stealth). Injects seed cookies (e.g., sessionKey),
lets the browser solve Cloudflare challenges, and returns the full cookie
jar including cf_clearance. Set createSession=true to get a persistent
sessionId that can be passed to anno_interact, anno_screenshot, etc. for
authenticated browsing across multiple calls.`,
  {
    domain: z.string().min(1).describe('Target domain (e.g., "claude.ai")'),
    url: z.string().url().describe('URL to navigate to for cookie resolution'),
    cookies: z
      .array(
        z.object({
          name: z.string().describe('Cookie name'),
          value: z.string().describe('Cookie value'),
          domain: z.string().describe('Cookie domain (e.g., ".claude.ai")'),
        })
      )
      .optional()
      .describe('Seed cookies to inject before navigation'),
    waitFor: z.string().optional().describe('CSS selector to wait for after navigation'),
    createSession: z.boolean().default(false).describe('Create a persistent session with authenticated cookies — returns sessionId for use in subsequent tool calls'),
  },
  async ({ domain, url, cookies, waitFor, createSession }) => {
    try {
      const body: Record<string, unknown> = { domain, url, createSession };
      if (cookies) body.cookies = cookies;
      if (waitFor) body.waitFor = waitFor;

      const res = await annoRequest('/v1/session/auth', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorBody = await res.json();
        return { content: [{ type: 'text' as const, text: `Session auth failed (${res.status}): ${JSON.stringify(errorBody)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Session auth error: ${message}` }] };
    }
  },
);

// --- Tool: anno_interact ----------------------------------------------------

server.tool(
  'anno_interact',
  `Act on a web page — click buttons, fill forms, select options, scroll,
hover, type text, and more. Use this to navigate sites, submit forms, and
trigger UI actions through Anno's stealth browser. Returns the results of
each action plus a full inventory of interactive elements on the final page.
Pass sessionId to reuse a persistent browser session across multiple calls.`,
  {
    url: z.string().url().describe('The URL to navigate to'),
    actions: z
      .array(
        z.object({
          type: z
            .enum(['click', 'fill', 'select', 'scroll', 'hover', 'waitFor', 'type', 'screenshot', 'evaluate', 'getPageState'])
            .describe('The action to perform'),
          selector: z.string().optional().describe('CSS selector for the target element'),
          value: z.string().optional().describe('Value for fill/type/select/evaluate actions'),
          direction: z.enum(['up', 'down', 'top', 'bottom']).optional().describe('Scroll direction'),
          condition: z
            .object({
              kind: z.enum(['selector', 'timeout', 'networkidle', 'expression']),
              selector: z.string().optional(),
              ms: z.number().optional(),
              expression: z.string().optional(),
            })
            .optional()
            .describe('Wait condition for waitFor action'),
          expression: z.string().optional().describe('JavaScript expression for evaluate action'),
        })
      )
      .default([])
      .describe('Actions to execute in order'),
    extract: z.boolean().default(false).describe('Extract page content after actions complete'),
    extractPolicy: z.string().default('default').describe('Extraction policy to use'),
    sessionId: z.string().optional().describe('Reuse a persistent browser session from a prior call'),
    createSession: z.boolean().default(false).describe('Create a new persistent session and return its ID'),
  },
  async ({ url, actions, extract, extractPolicy, sessionId, createSession }) => {
    try {
      const res = await annoRequest('/v1/interact', {
        method: 'POST',
        body: JSON.stringify({ url, actions, extract, extractPolicy, sessionId, createSession }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno interact failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno interact error: ${message}` }] };
    }
  },
);

// --- Tool: anno_screenshot --------------------------------------------------

server.tool(
  'anno_screenshot',
  `Capture a visual screenshot of any web page. Gives AI agents eyes —
see what's on the page to reason about unfamiliar layouts, verify actions
worked, or understand visual context that DOM alone can't convey. Optionally
execute actions (click, scroll, etc.) before capture. Pass sessionId to
capture from a persistent browser session.`,
  {
    url: z.string().url().describe('The URL to navigate to'),
    actions: z
      .array(
        z.object({
          type: z.enum(['click', 'fill', 'select', 'scroll', 'hover', 'waitFor', 'type', 'evaluate']).describe('Action to perform before screenshot'),
          selector: z.string().optional(),
          value: z.string().optional(),
          direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
          condition: z
            .object({
              kind: z.enum(['selector', 'timeout', 'networkidle', 'expression']),
              selector: z.string().optional(),
              ms: z.number().optional(),
              expression: z.string().optional(),
            })
            .optional(),
          expression: z.string().optional(),
        })
      )
      .default([])
      .describe('Actions to execute before taking the screenshot'),
    fullPage: z.boolean().default(false).describe('Capture the full scrollable page instead of just the viewport'),
    sessionId: z.string().optional().describe('Reuse a persistent browser session'),
    createSession: z.boolean().default(false).describe('Create a new persistent session'),
  },
  async ({ url, actions, fullPage, sessionId, createSession }) => {
    try {
      const res = await annoRequest('/v1/interact/screenshot', {
        method: 'POST',
        body: JSON.stringify({ url, actions, fullPage, sessionId, createSession }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno screenshot failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const result = (await res.json()) as { screenshot?: string; pageState?: unknown; [key: string]: unknown };

      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];

      if (result.screenshot) {
        content.push({
          type: 'image' as const,
          data: result.screenshot,
          mimeType: 'image/png',
        });
      }

      // Include page state as text alongside the image
      const stateInfo = result.pageState ? JSON.stringify(result.pageState, null, 2) : 'No page state returned';
      content.push({ type: 'text' as const, text: stateInfo });

      return { content };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno screenshot error: ${message}` }] };
    }
  },
);

// --- Tool: anno_page_state -------------------------------------------------

server.tool(
  'anno_page_state',
  `Discover what you can interact with on a page. Returns a structured
inventory of all interactive elements — buttons, links, inputs, selects,
textareas — with their CSS selectors, text content, and attributes. Use
this before anno_interact to understand the page layout and plan actions.
Pass sessionId to inspect a persistent browser session.`,
  {
    url: z.string().url().describe('The URL to inspect'),
    actions: z
      .array(
        z.object({
          type: z.enum(['click', 'fill', 'select', 'scroll', 'hover', 'waitFor', 'type', 'evaluate']).describe('Action to perform before inspecting'),
          selector: z.string().optional(),
          value: z.string().optional(),
          direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
          condition: z
            .object({
              kind: z.enum(['selector', 'timeout', 'networkidle', 'expression']),
              selector: z.string().optional(),
              ms: z.number().optional(),
              expression: z.string().optional(),
            })
            .optional(),
          expression: z.string().optional(),
        })
      )
      .default([])
      .describe('Actions to execute before inspecting page state'),
    sessionId: z.string().optional().describe('Reuse a persistent browser session'),
    createSession: z.boolean().default(false).describe('Create a new persistent session'),
  },
  async ({ url, actions, sessionId, createSession }) => {
    try {
      const res = await annoRequest('/v1/interact/page-state', {
        method: 'POST',
        body: JSON.stringify({ url, actions, sessionId, createSession }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno page-state failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno page-state error: ${message}` }] };
    }
  },
);

// --- Tool: anno_workflow ----------------------------------------------------

server.tool(
  'anno_workflow',
  `Execute a multi-step browser workflow with conditionals, loops, and
variable interpolation. Chain together navigation, interaction, extraction,
waiting, and screenshots into a repeatable automation sequence. Ideal for
complex tasks like "log in, search for X, extract results, paginate."`,
  {
    workflow: z.object({
      name: z.string().min(1).describe('Workflow name'),
      description: z.string().optional().describe('What this workflow does'),
      options: z.object({
        timeout: z.number().positive().optional().describe('Overall timeout in ms (default 120000)'),
        continueOnError: z.boolean().optional().describe('Keep going after step failure'),
        sessionTtl: z.number().positive().optional().describe('Session TTL in seconds (default 1800)'),
      }).optional(),
      variables: z.record(z.string(), z.string()).optional().describe('Initial variables for {{interpolation}}'),
      steps: z.array(z.record(z.string(), z.unknown())).min(1).describe('Workflow steps — types: fetch, interact, extract, wait, screenshot, setVariable, if, loop'),
    }).describe('The workflow definition'),
  },
  async ({ workflow }) => {
    try {
      const res = await annoRequest('/v1/workflow', {
        method: 'POST',
        body: JSON.stringify({ workflow }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno workflow failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno workflow error: ${message}` }] };
    }
  },
);

// --- Tool: anno_watch -------------------------------------------------------

server.tool(
  'anno_watch',
  `Monitor a URL for content changes over time. Register a watch to
periodically check a page and detect when its content changes beyond a
threshold. Use for tracking price changes, page updates, or any content
you need to stay informed about. Pass a watchId to check status of an
existing watch instead of creating a new one.`,
  {
    url: z.string().url().optional().describe('URL to watch (required for creating a new watch)'),
    interval: z.number().int().min(60).default(3600).describe('Check interval in seconds (min 60, default 3600)'),
    changeThreshold: z.number().min(0).max(100).default(1).describe('Minimum change percentage to trigger (0-100)'),
    webhookUrl: z.string().url().optional().describe('URL to POST change notifications to'),
    watchId: z.string().optional().describe('ID of an existing watch to check status (omit to create a new watch)'),
  },
  async ({ url, interval, changeThreshold, webhookUrl, watchId }) => {
    try {
      // If watchId is provided, check status of existing watch
      if (watchId) {
        const res = await annoRequest(`/v1/watch/${watchId}`);
        if (!res.ok) {
          const body = await res.json();
          return { content: [{ type: 'text' as const, text: `Anno watch status failed (${res.status}): ${JSON.stringify(body)}` }] };
        }
        const result = await res.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }

      // Create a new watch
      if (!url) {
        return { content: [{ type: 'text' as const, text: 'Error: url is required when creating a new watch (no watchId provided)' }] };
      }

      const body: Record<string, unknown> = { url, interval, changeThreshold };
      if (webhookUrl) body.webhookUrl = webhookUrl;

      const res = await annoRequest('/v1/watch', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno watch create failed (${res.status}): ${JSON.stringify(errBody)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno watch error: ${message}` }] };
    }
  },
);

// --- Tool: anno_search ------------------------------------------------------

server.tool(
  'anno_search',
  `Search over previously extracted web content using semantic similarity.
Query Anno's vector index to find relevant content from past extractions
without re-fetching. Returns ranked results with similarity scores.`,
  {
    query: z.string().min(1).describe('Search query'),
    k: z.number().int().min(1).max(20).optional().describe('Number of results to return (default 5)'),
    minScore: z.number().optional().describe('Minimum similarity score threshold'),
    filter: z.record(z.string(), z.unknown()).optional().describe('Metadata filter for narrowing results'),
  },
  async ({ query, k, minScore, filter }) => {
    try {
      const body: Record<string, unknown> = { query };
      if (k !== undefined) body.k = k;
      if (minScore !== undefined) body.minScore = minScore;
      if (filter !== undefined) body.filter = filter;

      const res = await annoRequest('/v1/semantic/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno search failed (${res.status}): ${JSON.stringify(errBody)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno search error: ${message}` }] };
    }
  },
);

// --- Tool: anno_observe -----------------------------------------------------

server.tool(
  'anno_observe',
  `Understand what you're looking at. Navigates to a URL and returns a
structured comprehension of the page: what type of page it is (login,
search results, article, product, checkout, form, dashboard, etc.),
what interactive elements are available, what navigation options exist,
and what patterns are detected (captcha, paywall, cookie consent, popups).
Use this as your first step on an unfamiliar page — before deciding
what to interact with. Pass sessionId for persistent session continuity.`,
  {
    url: z.string().url().describe('The URL to observe and comprehend'),
    sessionId: z.string().optional().describe('Reuse a persistent browser session'),
    createSession: z.boolean().default(false).describe('Create a new persistent session'),
  },
  async ({ url, sessionId, createSession }) => {
    try {
      const res = await annoRequest('/v1/interact/observe', {
        method: 'POST',
        body: JSON.stringify({ url, sessionId, createSession }),
      });

      if (!res.ok) {
        const body = await res.json();
        return { content: [{ type: 'text' as const, text: `Anno observe failed (${res.status}): ${JSON.stringify(body)}` }] };
      }

      const result = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = extractErrorMessage(error);
      if (message.includes('ECONNREFUSED')) {
        return { content: [{ type: 'text' as const, text: `Anno server is not running at ${ANNO_BASE_URL}. Start it with: npm start` }] };
      }
      return { content: [{ type: 'text' as const, text: `Anno observe error: ${message}` }] };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Anno MCP server failed to start: ${error}\n`);
  process.exit(1);
});
