#!/usr/bin/env tsx

/**
 * Extraction Accuracy Benchmark
 *
 * Measures extraction accuracy against ground truth
 * Target: F1 score >0.85
 */

import { distillContent } from '../dist/services/distiller.js';
import { readFileSync } from 'fs';
import { join } from 'path';

interface GroundTruth {
  url: string;
  html: string;
  expected: {
    title: string;
    contentKeywords: string[]; // Key phrases that should appear
    minParagraphs: number;
    minContentLength: number;
    author?: string;
  };
}

// Mock ground truth dataset
const GROUND_TRUTH: GroundTruth[] = [
  {
    url: 'https://example.com/article1',
    html: `
      <!DOCTYPE html>
      <html>
      <head><title>The Future of AI: A Deep Dive</title></head>
      <body>
        <nav>Skip to content</nav>
        <h1>The Future of AI: A Deep Dive</h1>
        <p class="byline">By Jane Smith</p>
        <article>
          <p>Artificial intelligence is transforming our world at an unprecedented pace.</p>
          <p>Machine learning models are becoming increasingly sophisticated.</p>
          <p>The implications for society are profound and far-reaching.</p>
        </article>
        <footer>Copyright 2025</footer>
      </body>
      </html>
    `,
    expected: {
      title: 'The Future of AI: A Deep Dive',
      contentKeywords: ['artificial intelligence', 'machine learning', 'society'],
      minParagraphs: 3,
      minContentLength: 100,
      author: 'Jane Smith'
    }
  },
  {
    url: 'https://example.com/article2',
    html: `
      <!DOCTYPE html>
      <html>
      <head><title>Climate Change: What You Need to Know</title></head>
      <body>
        <div class="ad">Advertisement</div>
        <h1>Climate Change: What You Need to Know</h1>
        <div class="content">
          <p>Global temperatures continue to rise at alarming rates.</p>
          <p>Scientists warn of catastrophic consequences if action is not taken.</p>
          <p>Renewable energy adoption is accelerating worldwide.</p>
          <p>Individual actions matter in the fight against climate change.</p>
        </div>
        <div class="sidebar">Related Articles</div>
      </body>
      </html>
    `,
    expected: {
      title: 'Climate Change: What You Need to Know',
      contentKeywords: ['climate', 'temperature', 'renewable energy'],
      minParagraphs: 4,
      minContentLength: 150
    }
  },
  {
    url: 'https://example.com/article3',
    html: `
      <!DOCTYPE html>
      <html>
      <head><title>JavaScript Best Practices 2025</title></head>
      <body>
        <header>Developer Blog</header>
        <h1>JavaScript Best Practices 2025</h1>
        <main>
          <p>Modern JavaScript development requires following best practices.</p>
          <p>TypeScript adoption has reached new heights this year.</p>
          <p>Async/await patterns simplify asynchronous code significantly.</p>
          <p>Testing remains crucial for maintaining code quality.</p>
          <p>Performance optimization should be considered from the start.</p>
        </main>
      </body>
      </html>
    `,
    expected: {
      title: 'JavaScript Best Practices 2025',
      contentKeywords: ['JavaScript', 'TypeScript', 'async', 'testing'],
      minParagraphs: 5,
      minContentLength: 200
    }
  }
];

interface AccuracyMetrics {
  precision: number;
  recall: number;
  f1: number;
}

function calculateTextSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

function evaluateExtraction(extracted: any, groundTruth: GroundTruth): AccuracyMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  // Title accuracy
  const titleSimilarity = calculateTextSimilarity(
    extracted.title,
    groundTruth.expected.title
  );
  if (titleSimilarity > 0.7) {
    truePositives++;
  } else {
    falseNegatives++;
  }

  // Content keyword presence
  const extractedContent = extracted.contentText.toLowerCase();
  groundTruth.expected.contentKeywords.forEach(keyword => {
    if (extractedContent.includes(keyword.toLowerCase())) {
      truePositives++;
    } else {
      falseNegatives++;
    }
  });

  // Paragraph count
  if (extracted.nodes.length >= groundTruth.expected.minParagraphs) {
    truePositives++;
  } else {
    falseNegatives++;
  }

  // Content length
  if (extracted.contentLength >= groundTruth.expected.minContentLength) {
    truePositives++;
  } else {
    falseNegatives++;
  }

  // Author (if expected)
  if (groundTruth.expected.author) {
    if (extracted.byline && extracted.byline.includes(groundTruth.expected.author)) {
      truePositives++;
    } else {
      falseNegatives++;
    }
  }

  // Calculate metrics
  const precision = truePositives / (truePositives + falsePositives || 1);
  const recall = truePositives / (truePositives + falseNegatives || 1);
  const f1 = 2 * (precision * recall) / (precision + recall || 1);

  return { precision, recall, f1 };
}

async function runAccuracyBenchmark() {
  console.log('🎯 Extraction Accuracy Benchmark');
  console.log('='.repeat(50));
  console.log(`Testing ${GROUND_TRUTH.length} ground truth examples\n`);

  const results: Array<{
    url: string;
    metrics: AccuracyMetrics;
    method: string;
    confidence: number;
  }> = [];

  for (const gt of GROUND_TRUTH) {
    console.log(`\n📝 Testing: ${gt.url}`);

    try {
      const extracted = await distillContent(gt.html, gt.url);
      const metrics = evaluateExtraction(extracted, gt);

      console.log(`  Title: ${extracted.title}`);
      console.log(`  Paragraphs: ${extracted.nodes.length}`);
      console.log(`  Content Length: ${extracted.contentLength}`);
      console.log(`  Method: ${extracted.extractionMethod}`);
      console.log(`  Precision: ${(metrics.precision * 100).toFixed(1)}%`);
      console.log(`  Recall: ${(metrics.recall * 100).toFixed(1)}%`);
      console.log(`  F1: ${(metrics.f1 * 100).toFixed(1)}%`);

      results.push({
        url: gt.url,
        metrics,
        method: extracted.extractionMethod || 'unknown',
        confidence: extracted.extractionConfidence || 0
      });
    } catch (error) {
      console.error(`  ❌ Failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  if (results.length === 0) {
    console.log('\n❌ No successful extractions');
    return;
  }

  // Calculate averages
  const avgPrecision = results.reduce((sum, r) => sum + r.metrics.precision, 0) / results.length;
  const avgRecall = results.reduce((sum, r) => sum + r.metrics.recall, 0) / results.length;
  const avgF1 = results.reduce((sum, r) => sum + r.metrics.f1, 0) / results.length;

  // By method
  const byMethod = new Map<string, AccuracyMetrics[]>();
  results.forEach(r => {
    if (!byMethod.has(r.method)) {
      byMethod.set(r.method, []);
    }
    byMethod.get(r.method)!.push(r.metrics);
  });

  // Print results
  console.log('\n' + '='.repeat(50));
  console.log('📈 RESULTS');
  console.log('='.repeat(50));

  console.log(`\nOverall Metrics:`);
  console.log(`  Precision: ${(avgPrecision * 100).toFixed(1)}%`);
  console.log(`  Recall: ${(avgRecall * 100).toFixed(1)}%`);
  console.log(`  F1 Score: ${(avgF1 * 100).toFixed(1)}%`);

  console.log(`\nBy Extraction Method:`);
  byMethod.forEach((metrics, method) => {
    const avgMethodF1 = metrics.reduce((sum, m) => sum + m.f1, 0) / metrics.length;
    console.log(`  ${method}: F1 = ${(avgMethodF1 * 100).toFixed(1)}% (n=${metrics.length})`);
  });

  // Success criteria
  console.log('\n' + '='.repeat(50));
  if (avgF1 >= 0.85) {
    console.log(`✅ SUCCESS: F1 = ${(avgF1 * 100).toFixed(1)}% (target: >85%)`);
  } else {
    console.log(`⚠️  BELOW TARGET: F1 = ${(avgF1 * 100).toFixed(1)}% (target: >85%)`);
  }
  console.log('='.repeat(50));

  // Save results
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      avgPrecision,
      avgRecall,
      avgF1,
      totalTests: results.length
    },
    byMethod: Object.fromEntries(
      Array.from(byMethod.entries()).map(([method, metrics]) => [
        method,
        {
          avgF1: metrics.reduce((sum, m) => sum + m.f1, 0) / metrics.length,
          count: metrics.length
        }
      ])
    ),
    details: results
  };

  const fs = await import('fs/promises');
  await fs.mkdir('benchmarks/reports', { recursive: true });
  await fs.writeFile(
    'benchmarks/reports/extraction-accuracy.json',
    JSON.stringify(report, null, 2)
  );

  console.log('\n📁 Report saved to benchmarks/reports/extraction-accuracy.json');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAccuracyBenchmark().catch(console.error);
}

export { runAccuracyBenchmark };
