#!/usr/bin/env node
/**
 * Anno MCP Server
 *
 * Exposes Anno's content extraction capabilities as MCP tools
 * so AI assistants (Claude Code, etc.) can use Anno natively.
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
  version: '1.0.0',
});

// --- Tool: anno_fetch -------------------------------------------------------

server.tool(
  'anno_fetch',
  `Fetch a web page and extract its content as clean, structured text.
Reduces token usage 80%+ vs raw HTML. Supports JavaScript rendering
for SPAs and dynamic sites. Use this instead of WebFetch for better
content extraction, especially for complex or JS-heavy pages.`,
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
      const message = error instanceof Error ? error.message : String(error);
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
  `Fetch multiple web pages in parallel and extract their content.
Returns structured text for each URL. Useful for comparing pages,
gathering information from multiple sources, or bulk extraction.`,
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
      const message = error instanceof Error ? error.message : String(error);
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
  `Crawl a website starting from a URL, following links up to a specified
depth. Returns extracted content from all discovered pages. Ideal for
indexing documentation sites, exploring site structure, or bulk content
extraction. Returns a job ID for long-running crawls.`,
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
      const message = error instanceof Error ? error.message : String(error);
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
  'Check if the Anno server is running and healthy.',
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
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Anno is not reachable at ${ANNO_BASE_URL}: ${message}` }] };
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
