#!/usr/bin/env tsx

import { performance } from 'perf_hooks';
import { createLangChainEmbeddingProvider, createLangChainSummarizer } from '../src/ai/langchain-integration';

interface Stats {
  runs: number;
  minMs: number;
  avgMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
}

function summarize(values: number[]): Stats {
  const runs = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const avgMs = runs ? Math.round(sorted.reduce((a, b) => a + b, 0) / runs) : 0;
  const p = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  return {
    runs,
    minMs: Math.round(minMs),
    avgMs,
    maxMs: Math.round(maxMs),
    p50Ms: Math.round(p(0.5)),
    p95Ms: Math.round(p(0.95))
  };
}

async function timeIt<T>(fn: () => Promise<T>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function run(): Promise<void> {
  const runs = Number(process.env.LLM_BENCH_RUNS || 5);
  const text = 'Measure embeddings and summarization latency for Anno.';

  const results: Record<string, Stats> = {};

  // Embeddings: OpenAI (requires OPENAI_API_KEY)
  if (process.env.OPENAI_API_KEY) {
    const openaiEmb = createLangChainEmbeddingProvider('openai');
    const embTimes: number[] = [];
    for (let i = 0; i < runs; i++) {
      embTimes.push(await timeIt(() => openaiEmb.embedQuery(text)));
    }
    results['embeddings_openai'] = summarize(embTimes);
  }

  // Embeddings: Ollama (requires OLLAMA running)
  const ollamaEmb = createLangChainEmbeddingProvider('ollama');
  const ollamaEmbTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      ollamaEmbTimes.push(await timeIt(() => ollamaEmb.embedQuery(text)));
    } catch {
      break;
    }
  }
  if (ollamaEmbTimes.length) {
    results['embeddings_ollama'] = summarize(ollamaEmbTimes);
  }

  // Summarization: OpenAI (if key present)
  if (process.env.OPENAI_API_KEY) {
    const openaiSum = createLangChainSummarizer('openai');
    const sumTimes: number[] = [];
    for (let i = 0; i < runs; i++) {
      sumTimes.push(await timeIt(() => openaiSum.generateSummaries([{ level: 'paragraph', content: text }])));
    }
    results['summarization_openai'] = summarize(sumTimes);
  }

  // Summarization: Ollama
  const ollamaSum = createLangChainSummarizer('ollama');
  const ollamaSumTimes: number[] = [];
  for (let i = 0; i < runs; i++) {
    try {
      ollamaSumTimes.push(await timeIt(() => ollamaSum.generateSummaries([{ level: 'paragraph', content: text }])));
    } catch {
      break;
    }
  }
  if (ollamaSumTimes.length) {
    results['summarization_ollama'] = summarize(ollamaSumTimes);
  }

  console.log(JSON.stringify({ runs, results }, null, 2));
}

run().catch(err => {
  console.error('Latency benchmark failed:', err?.message || err);
  process.exit(1);
});



