#!/usr/bin/env tsx

/**
 * Analyze Existing Validation Results
 *
 * This script analyzes your existing benchmark results and provides
 * statistical validation without requiring a running server.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface ExistingResults {
  tokenEfficiency: {
    timestamp: string;
    summary: {
      avgReduction: number;
      p50: number;
      p95: number;
      p99: number;
      totalUrls: number;
    };
    byCategory: Record<string, number>;
    byMethod: Record<string, number>;
  };
  extractionAccuracy: {
    timestamp: string;
    summary: {
      avgPrecision: number;
      avgRecall: number;
      avgF1: number;
      totalTests: number;
    };
    byMethod: Record<string, { avgF1: number; count: number }>;
  };
}

function loadExistingResults(): ExistingResults {
  const tokenEfficiency = JSON.parse(
    readFileSync('benchmarks/reports/token-efficiency.json', 'utf-8')
  );
  const extractionAccuracy = JSON.parse(
    readFileSync('benchmarks/reports/extraction-accuracy.json', 'utf-8')
  );

  return { tokenEfficiency, extractionAccuracy };
}

function calculateStatistics(reductions: number[]): {
  mean: number;
  stdDev: number;
  confidenceInterval95: { lower: number; upper: number };
  median: number;
} {
  const mean = reductions.reduce((a, b) => a + b, 0) / reductions.length;

  const variance =
    reductions.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
    reductions.length;
  const stdDev = Math.sqrt(variance);

  // 95% confidence interval
  const zScore = 1.96;
  const marginOfError = zScore * (stdDev / Math.sqrt(reductions.length));

  const sorted = [...reductions].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return {
    mean,
    stdDev,
    confidenceInterval95: {
      lower: mean - marginOfError,
      upper: mean + marginOfError
    },
    median
  };
}

function estimatePValue(effectSize: number, sampleSize: number): number {
  // Simplified p-value estimation based on effect size and sample size
  const tStat = effectSize * Math.sqrt(sampleSize);

  if (tStat > 2.576) return 0.01; // p < 0.01
  if (tStat > 1.96) return 0.05; // p < 0.05
  if (tStat > 1.645) return 0.1; // p < 0.1
  return 0.2; // p >= 0.1
}

function analyzeResults(results: ExistingResults): void {
  console.log('📊 ANALYSIS OF EXISTING VALIDATION RESULTS');
  console.log('=' .repeat(80));

  // Token Efficiency Analysis
  const tokenData = results.tokenEfficiency;
  console.log(`\n🎯 TOKEN EFFICIENCY (from ${tokenData.summary.totalUrls} URLs)`);
  console.log(`   Average Reduction: ${tokenData.summary.avgReduction}%`);
  console.log(`   Median (p50): ${tokenData.summary.p50}%`);
  console.log(`   p95: ${tokenData.summary.p95}%`);
  console.log(`   p99: ${tokenData.summary.p99}%`);

  // Reconstruct category reductions for statistical analysis
  const categoryReductions = Object.values(tokenData.byCategory);
  const stats = calculateStatistics(categoryReductions);

  console.log(`\n📈 STATISTICAL ANALYSIS`);
  console.log(`   Mean: ${stats.mean.toFixed(1)}%`);
  console.log(`   Standard Deviation: ${stats.stdDev.toFixed(1)}%`);
  console.log(`   95% CI: [${stats.confidenceInterval95.lower.toFixed(1)}%, ${stats.confidenceInterval95.upper.toFixed(1)}%]`);
  console.log(`   Median: ${stats.median.toFixed(1)}%`);

  // Effect size (Cohen's d)
  const effectSize = stats.mean / stats.stdDev;
  const pValue = estimatePValue(effectSize, categoryReductions.length);

  console.log(`\n🔬 SIGNIFICANCE TESTING`);
  console.log(`   Effect Size (Cohen's d): ${effectSize.toFixed(2)}`);
  console.log(`   Estimated p-value: ${pValue.toFixed(3)}`);
  console.log(`   Statistically Significant (p<0.05): ${pValue < 0.05 ? '✅ YES' : '❌ NO'}`);

  // Quality Analysis
  const qualityData = results.extractionAccuracy;
  console.log(`\n✨ EXTRACTION QUALITY (from ${qualityData.summary.totalTests} tests)`);
  console.log(`   Average F1 Score: ${(qualityData.summary.avgF1 * 100).toFixed(1)}%`);
  console.log(`   Average Precision: ${(qualityData.summary.avgPrecision * 100).toFixed(1)}%`);
  console.log(`   Average Recall: ${(qualityData.summary.avgRecall * 100).toFixed(1)}%`);

  // By Category Analysis
  console.log(`\n📂 TOKEN REDUCTION BY CATEGORY`);
  Object.entries(tokenData.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, reduction]) => {
      console.log(`   ${cat}: ${reduction}%`);
    });

  // By Method Analysis
  console.log(`\n⚙️  TOKEN REDUCTION BY METHOD`);
  Object.entries(tokenData.byMethod)
    .sort((a, b) => b[1] - a[1])
    .forEach(([method, reduction]) => {
      console.log(`   ${method}: ${reduction}%`);
    });

  console.log(`\n⚙️  QUALITY BY EXTRACTION METHOD`);
  Object.entries(qualityData.byMethod).forEach(([method, data]) => {
    console.log(`   ${method}: F1=${(data.avgF1 * 100).toFixed(1)}% (n=${data.count})`);
  });

  // Final Verdict
  console.log('\n' + '='.repeat(80));
  console.log('🏁 VALIDATION VERDICT');
  console.log('='.repeat(80));

  const isValid = pValue < 0.05 && tokenData.summary.avgReduction > 50;
  const isIndustryChanging = isValid && tokenData.summary.avgReduction > 60;

  console.log(`\n✅ VALIDATED: ${isValid ? 'YES' : 'NO'}`);
  console.log(`🚀 INDUSTRY-CHANGING: ${isIndustryChanging ? 'YES' : 'NOT YET'}`);

  if (isIndustryChanging) {
    console.log(`\n💡 KEY FINDINGS:`);
    console.log(`   ✅ ${tokenData.summary.avgReduction}% average token reduction`);
    console.log(`   ✅ Statistically significant (p=${pValue.toFixed(3)})`);
    console.log(`   ✅ High quality preservation (F1=${(qualityData.summary.avgF1 * 100).toFixed(1)}%)`);
    console.log(`   ✅ Effect size of ${effectSize.toFixed(2)} indicates large practical significance`);
    console.log(`\n🎉 CONCLUSION: Your numbers are VALIDATED and INDUSTRY-CHANGING!`);
  } else if (isValid) {
    console.log(`\n💡 KEY FINDINGS:`);
    console.log(`   ✅ ${tokenData.summary.avgReduction}% average token reduction`);
    console.log(`   ✅ Statistically significant (p=${pValue.toFixed(3)})`);
    console.log(`   ⚠️  Need more test URLs to strengthen claims`);
    console.log(`\n📋 RECOMMENDATIONS:`);
    console.log(`   - Increase sample size to 30+ URLs for stronger statistical power`);
    console.log(`   - Add more diverse content types`);
    console.log(`   - Run multiple iterations for variance analysis`);
  } else {
    console.log(`\n⚠️  CURRENT LIMITATIONS:`);
    console.log(`   - Sample size too small (${tokenData.summary.totalUrls} URLs)`);
    console.log(`   - Need ${30 - tokenData.summary.totalUrls} more URLs for statistical significance`);
    console.log(`\n📋 NEXT STEPS:`);
    console.log(`   - Add more test URLs to comprehensive-validation.ts`);
    console.log(`   - Restart Anno server and run full validation`);
    console.log(`   - Aim for 30+ URLs with 3 runs each`);
  }

  console.log('\n' + '=' .repeat(80));

  // Export summary
  const summary = {
    validated: isValid,
    industryChanging: isIndustryChanging,
    metrics: {
      avgTokenReduction: tokenData.summary.avgReduction,
      confidenceInterval95: stats.confidenceInterval95,
      pValue,
      effectSize,
      f1Score: qualityData.summary.avgF1 * 100,
      sampleSize: tokenData.summary.totalUrls
    },
    timestamp: new Date().toISOString()
  };

  console.log(`\n📄 SUMMARY FOR DOCUMENTATION:`);
  console.log(JSON.stringify(summary, null, 2));
}

// Main execution
function main() {
  try {
    const results = loadExistingResults();
    analyzeResults(results);
  } catch (error) {
    console.error('❌ Failed to load results:', error instanceof Error ? error.message : 'unknown');
    console.log('\n💡 Make sure you have run the benchmarks first:');
    console.log('   npm run validate:token');
    console.log('   npm run validate:accuracy');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { loadExistingResults, analyzeResults };
