#!/usr/bin/env npx tsx
/**
 * Anno Benchmark Suite
 *
 * Compares Anno's extraction output size against a raw HTML fetch baseline.
 * Measures token reduction across 20 diverse real-world URLs.
 *
 * Usage:
 *   npx tsx bench/run.ts                        # default (Anno at localhost:5213)
 *   ANNO_BASE_URL=http://host:5213 npx tsx bench/run.ts
 *
 * Requires: Anno server running at ANNO_BASE_URL
 */

const ANNO_BASE_URL = process.env.ANNO_BASE_URL || 'http://localhost:5213';
const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Test URLs — diverse real-world pages agents actually fetch
// ---------------------------------------------------------------------------

const URLS: Array<{ url: string; category: string }> = [
  // News
  { url: 'https://www.bbc.com/news', category: 'news-homepage' },
  { url: 'https://www.reuters.com/technology/', category: 'news-section' },
  { url: 'https://www.npr.org/sections/science/', category: 'news-section' },

  // Documentation
  { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Functions', category: 'docs' },
  { url: 'https://docs.python.org/3/tutorial/datastructures.html', category: 'docs' },
  { url: 'https://expressjs.com/en/guide/routing.html', category: 'docs' },

  // Wikipedia
  { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence', category: 'wiki' },
  { url: 'https://en.wikipedia.org/wiki/TypeScript', category: 'wiki' },

  // Forums / Q&A
  { url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array', category: 'forum' },
  { url: 'https://news.ycombinator.com/', category: 'forum' },

  // Blogs / Articles
  { url: 'https://blog.pragmaticengineer.com/', category: 'blog' },
  { url: 'https://martinfowler.com/articles/microservices.html', category: 'blog' },

  // Reference / knowledge
  { url: 'https://www.w3schools.com/js/js_functions.asp', category: 'reference' },
  { url: 'https://www.rust-lang.org/', category: 'homepage' },

  // More blogs / articles
  { url: 'https://sqlite.org/whentouse.html', category: 'docs' },
  { url: 'https://www.joelonsoftware.com/2000/08/09/the-joel-test-12-steps-to-better-code/', category: 'blog' },

  // Data-heavy
  { url: 'https://en.wikipedia.org/wiki/List_of_programming_languages', category: 'tables' },
  { url: 'https://en.wikipedia.org/wiki/Comparison_of_web_browsers', category: 'tables' },

  // Technical articles
  { url: 'https://www.postgresql.org/docs/current/tutorial-select.html', category: 'docs' },
  { url: 'https://redis.io/docs/latest/get-started/', category: 'docs' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BenchResult {
  url: string;
  category: string;
  rawHtmlChars: number;
  rawHtmlTokens: number;
  annoChars: number;
  annoTokens: number;
  reductionPct: number;
  status: 'ok' | 'error';
  error?: string;
}

function estimateTokens(text: string): number {
  // Standard approximation: ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

function stripHtmlToText(html: string): string {
  // Simulate what a basic fetch-to-text tool does:
  // remove scripts, styles, tags, collapse whitespace
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRawHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AnnoBenchmark/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchAnno(url: string): Promise<string> {
  const res = await fetch(`${ANNO_BASE_URL}/v1/content/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, options: { render: false, maxNodes: 60, useCache: false } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anno ${res.status}: ${body.slice(0, 200)}`);
  }

  const text = await res.text();
  const events = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });

  const parts: string[] = [];
  const metadata = events.find((e) => e.type === 'metadata');
  const nodes = events.filter((e) => e.type === 'node');
  const error = events.find((e) => e.type === 'error');

  if (error) throw new Error(String(error.payload.message));

  if (metadata?.payload) {
    const m = metadata.payload;
    if (m.title) parts.push(String(m.title));
  }

  for (const node of nodes) {
    const p = node.payload;
    if (p.text) parts.push(String(p.text));
  }

  return parts.join('\n').trim();
}

function pct(n: number): string {
  return n.toFixed(1) + '%';
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify Anno is running
  try {
    const health = await fetch(`${ANNO_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
    console.log(`Anno server: ${ANNO_BASE_URL} (healthy)\n`);
  } catch {
    console.error(`ERROR: Anno server not reachable at ${ANNO_BASE_URL}`);
    console.error('Start Anno with: npm start');
    process.exit(1);
  }

  const results: BenchResult[] = [];
  const total = URLS.length;

  for (let i = 0; i < total; i++) {
    const { url, category } = URLS[i];
    const label = `[${i + 1}/${total}] ${category}`;

    process.stdout.write(`${label}: ${url.slice(0, 60)}... `);

    try {
      // Fetch raw HTML (baseline)
      const rawHtml = await fetchRawHtml(url);
      const baselineText = stripHtmlToText(rawHtml);

      // Fetch via Anno
      const annoText = await fetchAnno(url);

      const rawHtmlTokens = estimateTokens(rawHtml);
      const baselineTokens = estimateTokens(baselineText);
      const annoTokens = estimateTokens(annoText);

      // Compare Anno vs raw HTML (the full payload an LLM would receive)
      const reductionVsHtml = rawHtml.length > 0
        ? ((rawHtml.length - annoText.length) / rawHtml.length) * 100
        : 0;

      results.push({
        url,
        category,
        rawHtmlChars: rawHtml.length,
        rawHtmlTokens,
        annoChars: annoText.length,
        annoTokens,
        reductionPct: reductionVsHtml,
        status: 'ok',
      });

      console.log(`${pct(reductionVsHtml)} reduction (${rawHtmlTokens} → ${annoTokens} tokens)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        url,
        category,
        rawHtmlChars: 0,
        rawHtmlTokens: 0,
        annoChars: 0,
        annoTokens: 0,
        reductionPct: 0,
        status: 'error',
        error: msg,
      });
      console.log(`ERROR: ${msg.slice(0, 80)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------

  const ok = results.filter((r) => r.status === 'ok');
  const errors = results.filter((r) => r.status === 'error');

  console.log('\n' + '='.repeat(100));
  console.log('ANNO BENCHMARK RESULTS');
  console.log('='.repeat(100));

  // Header
  console.log(
    pad('Category', 16) +
    pad('URL', 40) +
    padRight('Raw HTML', 12) +
    padRight('Anno', 12) +
    padRight('Reduction', 12) +
    padRight('Status', 8)
  );
  console.log('-'.repeat(100));

  for (const r of results) {
    const shortUrl = r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 38);
    console.log(
      pad(r.category, 16) +
      pad(shortUrl, 40) +
      padRight(r.status === 'ok' ? r.rawHtmlTokens.toLocaleString() + ' tok' : '-', 12) +
      padRight(r.status === 'ok' ? r.annoTokens.toLocaleString() + ' tok' : '-', 12) +
      padRight(r.status === 'ok' ? pct(r.reductionPct) : 'ERR', 12) +
      padRight(r.status, 8)
    );
  }

  console.log('-'.repeat(100));

  if (ok.length > 0) {
    const avgReduction = ok.reduce((sum, r) => sum + r.reductionPct, 0) / ok.length;
    const totalRawTokens = ok.reduce((sum, r) => sum + r.rawHtmlTokens, 0);
    const totalAnnoTokens = ok.reduce((sum, r) => sum + r.annoTokens, 0);
    const overallReduction = ((totalRawTokens - totalAnnoTokens) / totalRawTokens) * 100;

    console.log(`\nSuccessful: ${ok.length}/${total} URLs`);
    console.log(`Errors:     ${errors.length}/${total} URLs`);
    console.log(`\nAverage reduction per page:  ${pct(avgReduction)}`);
    console.log(`Overall token reduction:     ${pct(overallReduction)} (${totalRawTokens.toLocaleString()} → ${totalAnnoTokens.toLocaleString()} tokens)`);
    console.log(`Total tokens saved:          ${(totalRawTokens - totalAnnoTokens).toLocaleString()}`);
  }

  // ---------------------------------------------------------------------------
  // CSV output
  // ---------------------------------------------------------------------------

  const csvLines = [
    'url,category,raw_html_chars,raw_html_tokens,anno_chars,anno_tokens,reduction_pct,status,error',
    ...results.map((r) =>
      [
        `"${r.url}"`,
        r.category,
        r.rawHtmlChars,
        r.rawHtmlTokens,
        r.annoChars,
        r.annoTokens,
        r.reductionPct.toFixed(1),
        r.status,
        `"${(r.error || '').replace(/"/g, '""')}"`,
      ].join(',')
    ),
  ];

  const csvPath = new URL('./results.csv', import.meta.url).pathname;
  const { writeFileSync } = await import('fs');
  writeFileSync(csvPath, csvLines.join('\n') + '\n');
  console.log(`\nCSV saved to: ${csvPath}`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
