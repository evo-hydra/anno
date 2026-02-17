/**
 * Performance Baseline Benchmark
 *
 * Measures request latency and response sizes for the Anno API.
 * Results are saved to benchmarks/reports/ for tracking over time.
 *
 * Usage: npm run bench:perf
 */

import http from 'http';
import { createApp } from '../src/app';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NUM_REQUESTS = 10;
const TARGET_PATH = '/v1/content/fetch';
const TARGET_BODY = JSON.stringify({ url: 'https://example.com' });
const HEALTH_PATH = '/health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RequestResult {
  latencyMs: number;
  responseBytes: number;
  statusCode: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function makeRequest(
  server: http.Server,
  method: string,
  path: string,
  body?: string,
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      reject(new Error('Server not listening'));
      return;
    }

    const start = performance.now();
    let responseBytes = 0;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
        });
        res.on('end', () => {
          const latencyMs = performance.now() - start;
          resolve({
            latencyMs,
            responseBytes,
            statusCode: res.statusCode ?? 0,
          });
        });
      },
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);

  // Start on random port
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`\nBenchmark server listening on port ${port}\n`);

  try {
    // Warm up with health check
    await makeRequest(server, 'GET', HEALTH_PATH);
    console.log('Warm-up complete.\n');

    // -----------------------------------------------------------------------
    // Health endpoint baseline
    // -----------------------------------------------------------------------

    console.log(`--- GET ${HEALTH_PATH} (${NUM_REQUESTS} requests) ---`);
    const healthResults: RequestResult[] = [];

    for (let i = 0; i < NUM_REQUESTS; i++) {
      const result = await makeRequest(server, 'GET', HEALTH_PATH);
      healthResults.push(result);
      process.stdout.write('.');
    }
    console.log(' done\n');

    // -----------------------------------------------------------------------
    // Content fetch baseline
    // -----------------------------------------------------------------------

    console.log(`--- POST ${TARGET_PATH} (${NUM_REQUESTS} requests) ---`);
    const fetchResults: RequestResult[] = [];

    for (let i = 0; i < NUM_REQUESTS; i++) {
      const result = await makeRequest(server, 'POST', TARGET_PATH, TARGET_BODY);
      fetchResults.push(result);
      process.stdout.write('.');
    }
    console.log(' done\n');

    // -----------------------------------------------------------------------
    // Compute stats
    // -----------------------------------------------------------------------

    function computeStats(results: RequestResult[]) {
      const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
      const sizes = results.map((r) => r.responseBytes);

      return {
        count: results.length,
        latency: {
          min: Math.round(latencies[0] * 100) / 100,
          max: Math.round(latencies[latencies.length - 1] * 100) / 100,
          mean: Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100,
          p50: Math.round(percentile(latencies, 50) * 100) / 100,
          p95: Math.round(percentile(latencies, 95) * 100) / 100,
        },
        responseSize: {
          min: Math.min(...sizes),
          max: Math.max(...sizes),
          mean: Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length),
        },
        statusCodes: results.reduce(
          (acc, r) => {
            acc[r.statusCode] = (acc[r.statusCode] || 0) + 1;
            return acc;
          },
          {} as Record<number, number>,
        ),
      };
    }

    const healthStats = computeStats(healthResults);
    const fetchStats = computeStats(fetchResults);

    // -----------------------------------------------------------------------
    // Print summary
    // -----------------------------------------------------------------------

    console.log('==================================================');
    console.log('  PERFORMANCE BASELINE REPORT');
    console.log('==================================================\n');

    function printStats(label: string, stats: ReturnType<typeof computeStats>) {
      console.log(`  ${label}`);
      console.log(`  ${'─'.repeat(44)}`);
      console.log(`  Requests:    ${stats.count}`);
      console.log(`  Status:      ${JSON.stringify(stats.statusCodes)}`);
      console.log(`  Latency (ms):`);
      console.log(`    min:  ${stats.latency.min}`);
      console.log(`    p50:  ${stats.latency.p50}`);
      console.log(`    p95:  ${stats.latency.p95}`);
      console.log(`    max:  ${stats.latency.max}`);
      console.log(`    mean: ${stats.latency.mean}`);
      console.log(`  Response size (bytes):`);
      console.log(`    min:  ${stats.responseSize.min}`);
      console.log(`    max:  ${stats.responseSize.max}`);
      console.log(`    mean: ${stats.responseSize.mean}`);
      console.log();
    }

    printStats(`GET ${HEALTH_PATH}`, healthStats);
    printStats(`POST ${TARGET_PATH}`, fetchStats);

    // -----------------------------------------------------------------------
    // Save report
    // -----------------------------------------------------------------------

    const report = {
      timestamp: new Date().toISOString(),
      nodeVersion: process.version,
      requests: NUM_REQUESTS,
      endpoints: {
        health: healthStats,
        contentFetch: fetchStats,
      },
    };

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportPath = `benchmarks/reports/perf-baseline-${ts}.json`;

    const { writeFileSync } = await import('fs');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Report saved: ${reportPath}\n`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
