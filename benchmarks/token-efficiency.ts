#!/usr/bin/env tsx

/**
 * Token Efficiency Benchmark
 *
 * Measures token reduction: raw HTML vs Anno JSONL output
 * Target: >75% reduction on average
 */

import { encoding_for_model } from 'tiktoken';
import { fetchPage } from '../dist/services/fetcher.js';
import { distillContent } from '../dist/services/distiller.js';

const encoder = encoding_for_model('gpt-4');

interface BenchmarkResult {
  url: string;
  category: string;
  htmlTokens: number;
  jsonlTokens: number;
  reductionPercent: number;
  extractionMethod: string;
  confidence: number;
}

// Curated test URLs across categories
const TEST_URLS = [
  // News articles
  { url: 'https://www.bbc.com/news/technology', category: 'news' },
  { url: 'https://www.reuters.com/technology/', category: 'news' },
  { url: 'https://apnews.com/technology', category: 'news' },

  // Tech blogs
  { url: 'https://arstechnica.com/', category: 'tech-blog' },
  { url: 'https://techcrunch.com/', category: 'tech-blog' },

  // Documentation
  { url: 'https://nodejs.org/en/docs', category: 'documentation' },
  { url: 'https://docs.python.org/3/', category: 'documentation' },

  // Academic
  { url: 'https://arxiv.org/abs/2103.00020', category: 'academic' },

  // Product pages
  { url: 'https://www.amazon.com/dp/B08N5WRWNW', category: 'product' },
];

function countTokens(text: string): number {
  return encoder.encode(text).length;
}

function serializeToJSONL(result: any): string {
  // Simulate JSONL output format
  const lines = [
    JSON.stringify({ type: 'metadata', payload: { title: result.title, method: result.extractionMethod } }),
    ...result.nodes.map((node: any) =>
      JSON.stringify({ type: 'content', payload: { text: node.text } })
    ),
    JSON.stringify({ type: 'done', payload: { confidence: result.extractionConfidence } })
  ];
  return lines.join('\n');
}

async function benchmarkURL(url: string, category: string): Promise<BenchmarkResult | null> {
  try {
    console.log(`\n📊 Benchmarking: ${url}`);

    // Fetch raw HTML
    const fetchResult = await fetchPage({ url, useCache: true, mode: 'http' });
    const htmlTokens = countTokens(fetchResult.body);

    // Distill content
    const distilled = await distillContent(fetchResult.body, url);
    const jsonlOutput = serializeToJSONL(distilled);
    const jsonlTokens = countTokens(jsonlOutput);

    const reductionPercent = ((htmlTokens - jsonlTokens) / htmlTokens) * 100;

    console.log(`  HTML: ${htmlTokens.toLocaleString()} tokens`);
    console.log(`  JSONL: ${jsonlTokens.toLocaleString()} tokens`);
    console.log(`  Reduction: ${reductionPercent.toFixed(1)}%`);
    console.log(`  Method: ${distilled.extractionMethod}`);

    return {
      url,
      category,
      htmlTokens,
      jsonlTokens,
      reductionPercent,
      extractionMethod: distilled.extractionMethod || 'unknown',
      confidence: distilled.extractionConfidence || 0
    };
  } catch (error) {
    console.error(`  ❌ Failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return null;
  }
}

async function runBenchmark() {
  console.log('🚀 Token Efficiency Benchmark');
  console.log('=' .repeat(50));
  console.log(`Testing ${TEST_URLS.length} URLs\n`);

  const results: BenchmarkResult[] = [];

  // Run benchmarks sequentially to avoid rate limiting
  for (const { url, category } of TEST_URLS) {
    const result = await benchmarkURL(url, category);
    if (result) {
      results.push(result);
    }
    // Delay between requests
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (results.length === 0) {
    console.log('\n❌ No successful benchmarks');
    return;
  }

  // Calculate statistics
  const avgReduction = results.reduce((sum, r) => sum + r.reductionPercent, 0) / results.length;
  const sortedReductions = results.map(r => r.reductionPercent).sort((a, b) => a - b);
  const p50 = sortedReductions[Math.floor(sortedReductions.length * 0.5)];
  const p95 = sortedReductions[Math.floor(sortedReductions.length * 0.95)];
  const p99 = sortedReductions[Math.floor(sortedReductions.length * 0.99)];

  // Category breakdown
  const byCategory = new Map<string, number[]>();
  results.forEach(r => {
    if (!byCategory.has(r.category)) {
      byCategory.set(r.category, []);
    }
    byCategory.get(r.category)!.push(r.reductionPercent);
  });

  // Print results
  console.log('\n' + '='.repeat(50));
  console.log('📈 RESULTS');
  console.log('='.repeat(50));

  console.log(`\nOverall Statistics:`);
  console.log(`  Average Reduction: ${avgReduction.toFixed(1)}%`);
  console.log(`  Median (p50): ${p50.toFixed(1)}%`);
  console.log(`  p95: ${p95.toFixed(1)}%`);
  console.log(`  p99: ${p99.toFixed(1)}%`);

  console.log(`\nBy Category:`);
  byCategory.forEach((reductions, category) => {
    const avg = reductions.reduce((a, b) => a + b, 0) / reductions.length;
    console.log(`  ${category}: ${avg.toFixed(1)}% (n=${reductions.length})`);
  });

  console.log(`\nBy Extraction Method:`);
  const byMethod = new Map<string, number[]>();
  results.forEach(r => {
    if (!byMethod.has(r.extractionMethod)) {
      byMethod.set(r.extractionMethod, []);
    }
    byMethod.get(r.extractionMethod)!.push(r.reductionPercent);
  });

  byMethod.forEach((reductions, method) => {
    const avg = reductions.reduce((a, b) => a + b, 0) / reductions.length;
    console.log(`  ${method}: ${avg.toFixed(1)}% (n=${reductions.length})`);
  });

  // Success criteria
  console.log('\n' + '='.repeat(50));
  if (avgReduction >= 75) {
    console.log(`✅ SUCCESS: ${avgReduction.toFixed(1)}% reduction (target: >75%)`);
  } else {
    console.log(`⚠️  BELOW TARGET: ${avgReduction.toFixed(1)}% reduction (target: >75%)`);
  }
  console.log('='.repeat(50));

  // Save results
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      avgReduction,
      p50,
      p95,
      p99,
      totalUrls: results.length
    },
    byCategory: Object.fromEntries(byCategory.entries()),
    byMethod: Object.fromEntries(byMethod.entries()),
    details: results
  };

  const fs = await import('fs/promises');
  await fs.mkdir('benchmarks/reports', { recursive: true });
  await fs.writeFile(
    'benchmarks/reports/token-efficiency.json',
    JSON.stringify(report, null, 2)
  );

  console.log('\n📁 Report saved to benchmarks/reports/token-efficiency.json');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runBenchmark().catch(console.error);
}

export { runBenchmark, benchmarkURL };
