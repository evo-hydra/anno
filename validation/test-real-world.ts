#!/usr/bin/env tsx

/**
 * Anno Real-World Validation Suite
 *
 * Purpose: Test Anno with real eBay data to understand:
 * - What data quality looks like
 * - What's missing from extractions
 * - What AI features would be most valuable
 * - What questions users would want to ask
 *
 * Run this BEFORE building AI features to validate assumptions.
 */

import { AnnoClient, FetchResult } from '../sdk/typescript/dist/index.js';
import { writeFileSync } from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const ANNO_ENDPOINT = process.env.ANNO_ENDPOINT || 'http://localhost:5213';
const OUTPUT_FILE = './validation/OBSERVATIONS.md';

// Test with real FlipIQ use cases
const TEST_PRODUCTS = [
  { name: 'Nintendo Switch OLED', category: 'Gaming' },
  { name: 'iPhone 14 Pro Max', category: 'Electronics' },
  { name: 'Sony PS5', category: 'Gaming' },
  { name: 'MacBook Pro M3', category: 'Computers' },
  { name: 'AirPods Pro', category: 'Electronics' },
  { name: 'Samsung Galaxy S24', category: 'Electronics' },
  { name: 'Xbox Series X', category: 'Gaming' },
  { name: 'iPad Pro', category: 'Tablets' },
];

// ============================================================================
// DATA EXTRACTION HELPERS
// ============================================================================

interface ExtractedPrice {
  value: number;
  text: string;
  confidence?: number;
  nodeIndex: number;
}

interface ExtractedProduct {
  title: string;
  confidence?: number;
  nodeIndex: number;
}

interface ShippingInfo {
  isFree: boolean;
  cost?: number;
  text: string;
}

interface ConditionInfo {
  condition: string;
  text: string;
}

function extractPrices(result: FetchResult): ExtractedPrice[] {
  const prices: ExtractedPrice[] = [];

  result.nodes.forEach((node, index) => {
    // Match various price formats
    const pricePatterns = [
      /\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g,  // $1,234.56
      /(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*USD/gi,  // 1234.56 USD
    ];

    for (const pattern of pricePatterns) {
      const matches = node.text.matchAll(pattern);
      for (const match of matches) {
        const priceStr = match[1].replace(/,/g, '');
        const value = parseFloat(priceStr);

        // Filter reasonable prices (not dates, zip codes, etc.)
        if (value > 0 && value < 50000) {
          prices.push({
            value,
            text: node.text,
            confidence: node.confidence,
            nodeIndex: index,
          });
        }
      }
    }
  });

  return prices;
}

function extractProductTitles(result: FetchResult): ExtractedProduct[] {
  const products: ExtractedProduct[] = [];

  result.nodes.forEach((node, index) => {
    // Look for headings and title-like text
    if (node.tag === 'h1' || node.tag === 'h2' || node.tag === 'h3') {
      products.push({
        title: node.text,
        confidence: node.confidence,
        nodeIndex: index,
      });
    }

    // Also check for long text nodes that might be titles
    if (node.text.length > 20 && node.text.length < 200) {
      // Heuristic: titles often have product names/brands
      const hasBrand = /\b(Apple|Samsung|Sony|Microsoft|Nintendo|Google)\b/i.test(node.text);
      const hasModel = /\b(Pro|Max|Plus|Ultra|OLED|4K)\b/i.test(node.text);

      if (hasBrand || hasModel) {
        products.push({
          title: node.text,
          confidence: node.confidence,
          nodeIndex: index,
        });
      }
    }
  });

  return products;
}

function extractShippingInfo(result: FetchResult): ShippingInfo[] {
  const shipping: ShippingInfo[] = [];

  result.nodes.forEach(node => {
    const text = node.text.toLowerCase();

    if (text.includes('free shipping') || text.includes('free ship')) {
      shipping.push({
        isFree: true,
        text: node.text,
      });
    } else if (text.includes('shipping')) {
      const costMatch = text.match(/\$(\d+\.?\d*)/);
      if (costMatch) {
        shipping.push({
          isFree: false,
          cost: parseFloat(costMatch[1]),
          text: node.text,
        });
      }
    }
  });

  return shipping;
}

function extractCondition(result: FetchResult): ConditionInfo[] {
  const conditions: ConditionInfo[] = [];

  const conditionPatterns = [
    /\b(new|brand new|factory sealed)\b/i,
    /\b(used|pre-owned|refurbished)\b/i,
    /\b(like new|excellent|very good|good|acceptable)\b/i,
    /\b(open box|damaged|for parts)\b/i,
  ];

  result.nodes.forEach(node => {
    for (const pattern of conditionPatterns) {
      const match = node.text.match(pattern);
      if (match) {
        conditions.push({
          condition: match[1],
          text: node.text,
        });
      }
    }
  });

  return conditions;
}

function extractSellerInfo(result: FetchResult): string[] {
  const sellers: string[] = [];

  result.nodes.forEach(node => {
    // Look for seller-related text
    if (node.text.includes('Sold by') || node.text.includes('Seller:')) {
      sellers.push(node.text);
    }
  });

  return sellers;
}

// ============================================================================
// ANALYSIS FUNCTIONS
// ============================================================================

interface ProductAnalysis {
  product: string;
  url: string;
  metadata: {
    status: number;
    fromCache: boolean;
    rendered: boolean;
    durationMs: number;
    totalNodes: number;
    confidence: number;
  };
  extracted: {
    prices: ExtractedPrice[];
    products: ExtractedProduct[];
    shipping: ShippingInfo[];
    conditions: ConditionInfo[];
    sellers: string[];
  };
  statistics: {
    avgPrice?: number;
    minPrice?: number;
    maxPrice?: number;
    priceRange?: number;
    priceStdDev?: number;
    uniquePrices: number;
  };
  quality: {
    hasPrices: boolean;
    hasProducts: boolean;
    hasShipping: boolean;
    hasConditions: boolean;
    dataCompleteness: number; // 0-1 score
  };
  sampleNodes: Array<{ tag: string; text: string; confidence?: number }>;
}

async function analyzeProduct(
  anno: AnnoClient,
  product: string
): Promise<ProductAnalysis> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📦 Analyzing: ${product}`);
  console.log('='.repeat(70));

  const url = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(product)}`;

  console.log(`🌐 Fetching: ${url}`);
  console.log('⏳ This may take 10-20 seconds (rendering enabled)...\n');

  const result = await anno.fetch(url, {
    render: true, // Enable rendering for JavaScript-heavy sites like eBay
    maxNodes: 100, // Max allowed by API
    useCache: true,
  });

  // Extract all data
  const prices = extractPrices(result);
  const products = extractProductTitles(result);
  const shipping = extractShippingInfo(result);
  const conditions = extractCondition(result);
  const sellers = extractSellerInfo(result);

  // Compute statistics
  const priceValues = prices.map(p => p.value);
  const statistics = priceValues.length > 0 ? {
    avgPrice: priceValues.reduce((a, b) => a + b, 0) / priceValues.length,
    minPrice: Math.min(...priceValues),
    maxPrice: Math.max(...priceValues),
    priceRange: Math.max(...priceValues) - Math.min(...priceValues),
    priceStdDev: stdDev(priceValues),
    uniquePrices: new Set(priceValues).size,
  } : {
    uniquePrices: 0,
  };

  // Quality assessment
  const dataCompleteness =
    (prices.length > 0 ? 0.25 : 0) +
    (products.length > 0 ? 0.25 : 0) +
    (shipping.length > 0 ? 0.25 : 0) +
    (conditions.length > 0 ? 0.25 : 0);

  const analysis: ProductAnalysis = {
    product,
    url,
    metadata: {
      status: result.metadata.status,
      fromCache: result.metadata.fromCache,
      rendered: result.metadata.rendered,
      durationMs: result.metadata.durationMs,
      totalNodes: result.nodes.length,
      confidence: result.confidence.overallConfidence,
    },
    extracted: {
      prices,
      products,
      shipping,
      conditions,
      sellers,
    },
    statistics,
    quality: {
      hasPrices: prices.length > 0,
      hasProducts: products.length > 0,
      hasShipping: shipping.length > 0,
      hasConditions: conditions.length > 0,
      dataCompleteness,
    },
    sampleNodes: result.nodes.slice(0, 10).map(n => ({
      tag: n.tag,
      text: n.text.slice(0, 100),
      confidence: n.confidence,
    })),
  };

  // Print summary
  printAnalysisSummary(analysis);

  return analysis;
}

function printAnalysisSummary(analysis: ProductAnalysis): void {
  console.log(`✅ Status: ${analysis.metadata.status}`);
  console.log(`⚡ Duration: ${(analysis.metadata.durationMs / 1000).toFixed(2)}s`);
  console.log(`🎯 Confidence: ${(analysis.metadata.confidence * 100).toFixed(1)}%`);
  console.log(`📊 Nodes extracted: ${analysis.metadata.totalNodes}`);
  console.log(`💾 From cache: ${analysis.metadata.fromCache ? 'Yes' : 'No'}`);
  console.log(`🎭 Rendered: ${analysis.metadata.rendered ? 'Yes' : 'No'}`);

  console.log(`\n📈 Data Quality:`);
  console.log(`  - Completeness: ${(analysis.quality.dataCompleteness * 100).toFixed(0)}%`);
  console.log(`  - Prices found: ${analysis.extracted.prices.length}`);
  console.log(`  - Products found: ${analysis.extracted.products.length}`);
  console.log(`  - Shipping info: ${analysis.extracted.shipping.length}`);
  console.log(`  - Conditions: ${analysis.extracted.conditions.length}`);
  console.log(`  - Sellers: ${analysis.extracted.sellers.length}`);

  if (analysis.statistics.avgPrice) {
    console.log(`\n💰 Price Statistics:`);
    console.log(`  - Average: $${analysis.statistics.avgPrice.toFixed(2)}`);
    console.log(`  - Range: $${analysis.statistics.minPrice?.toFixed(2)} - $${analysis.statistics.maxPrice?.toFixed(2)}`);
    console.log(`  - Std Dev: $${analysis.statistics.priceStdDev?.toFixed(2)}`);
    console.log(`  - Unique prices: ${analysis.statistics.uniquePrices}`);
  }

  if (analysis.extracted.products.length > 0) {
    console.log(`\n📦 Sample Products:`);
    analysis.extracted.products.slice(0, 3).forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.title.slice(0, 60)}${p.title.length > 60 ? '...' : ''}`);
    });
  }

  if (analysis.extracted.shipping.length > 0) {
    const freeShipping = analysis.extracted.shipping.filter(s => s.isFree).length;
    console.log(`\n🚚 Shipping: ${freeShipping}/${analysis.extracted.shipping.length} free`);
  }
}

// ============================================================================
// RECOMMENDATION ENGINE
// ============================================================================

interface AIFeatureRecommendations {
  criticalFeatures: string[];
  highPriorityFeatures: string[];
  mediumPriorityFeatures: string[];
  dataQualityIssues: string[];
  questionsUsersWillAsk: string[];
  suggestedAgents: string[];
}

function generateRecommendations(
  analyses: ProductAnalysis[]
): AIFeatureRecommendations {
  const recommendations: AIFeatureRecommendations = {
    criticalFeatures: [],
    highPriorityFeatures: [],
    mediumPriorityFeatures: [],
    dataQualityIssues: [],
    questionsUsersWillAsk: [],
    suggestedAgents: [],
  };

  // Analyze data completeness
  const avgCompleteness = analyses.reduce((sum, a) => sum + a.quality.dataCompleteness, 0) / analyses.length;
  const allHavePrices = analyses.every(a => a.quality.hasPrices);
  const allHaveProducts = analyses.every(a => a.quality.hasProducts);
  const avgPricesPerPage = analyses.reduce((sum, a) => sum + a.extracted.prices.length, 0) / analyses.length;

  // Critical features (must have)
  if (allHavePrices) {
    recommendations.criticalFeatures.push(
      '✅ Price extraction is working well - build RAG pipeline for price queries'
    );
  } else {
    recommendations.dataQualityIssues.push(
      '⚠️ Some pages missing prices - improve extraction heuristics'
    );
  }

  if (avgPricesPerPage > 10) {
    recommendations.criticalFeatures.push(
      '✅ Good price density - build price comparison agent'
    );
    recommendations.suggestedAgents.push('PriceComparisonAgent');
  }

  // High priority features
  if (analyses.some(a => a.extracted.shipping.length > 0)) {
    recommendations.highPriorityFeatures.push(
      'Add shipping cost analysis to RAG pipeline'
    );
    recommendations.questionsUsersWillAsk.push(
      '"Which listings have free shipping?"'
    );
  }

  if (analyses.some(a => a.extracted.conditions.length > 0)) {
    recommendations.highPriorityFeatures.push(
      'Add condition filtering to search'
    );
    recommendations.questionsUsersWillAsk.push(
      '"Show me only new/sealed items"'
    );
  }

  // Medium priority
  if (analyses.some(a => a.extracted.sellers.length > 0)) {
    recommendations.mediumPriorityFeatures.push(
      'Track seller reputation and pricing patterns'
    );
  }

  // Common questions users will ask
  recommendations.questionsUsersWillAsk.push(
    '"What\'s the average price for [product]?"',
    '"Which listing has the best deal?"',
    '"Has the price changed in the last week?"',
    '"Compare prices across different conditions"',
    '"Alert me when price drops below $X"'
  );

  // Suggested agents based on data
  if (allHavePrices) {
    recommendations.suggestedAgents.push('PriceAnalysisAgent');
  }
  if (allHaveProducts) {
    recommendations.suggestedAgents.push('ProductResearchAgent');
  }
  if (analyses.some(a => a.statistics.priceStdDev && a.statistics.priceStdDev > 50)) {
    recommendations.suggestedAgents.push('DealFinderAgent');
  }

  // Data quality assessment
  if (avgCompleteness < 0.5) {
    recommendations.dataQualityIssues.push(
      `⚠️ Low data completeness (${(avgCompleteness * 100).toFixed(0)}%) - improve extraction`
    );
  }

  return recommendations;
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function generateMarkdownReport(
  analyses: ProductAnalysis[],
  recommendations: AIFeatureRecommendations
): string {
  const timestamp = new Date().toISOString();

  let report = `# Anno Real-World Validation Report\n\n`;
  report += `**Generated:** ${timestamp}\n`;
  report += `**Products Tested:** ${analyses.length}\n`;
  report += `**Endpoint:** ${ANNO_ENDPOINT}\n\n`;

  report += `---\n\n`;

  // Executive Summary
  report += `## Executive Summary\n\n`;
  const avgConfidence = analyses.reduce((sum, a) => sum + a.metadata.confidence, 0) / analyses.length;
  const avgCompleteness = analyses.reduce((sum, a) => sum + a.quality.dataCompleteness, 0) / analyses.length;
  const avgDuration = analyses.reduce((sum, a) => sum + a.metadata.durationMs, 0) / analyses.length;

  report += `- **Average Confidence:** ${(avgConfidence * 100).toFixed(1)}%\n`;
  report += `- **Average Data Completeness:** ${(avgCompleteness * 100).toFixed(1)}%\n`;
  report += `- **Average Fetch Time:** ${(avgDuration / 1000).toFixed(2)}s\n`;
  report += `- **Cache Hit Rate:** ${(analyses.filter(a => a.metadata.fromCache).length / analyses.length * 100).toFixed(0)}%\n\n`;

  // Detailed Results
  report += `## Detailed Results\n\n`;

  analyses.forEach((analysis, i) => {
    report += `### ${i + 1}. ${analysis.product}\n\n`;
    report += `**URL:** ${analysis.url}\n\n`;

    report += `**Metadata:**\n`;
    report += `- Status: ${analysis.metadata.status}\n`;
    report += `- Confidence: ${(analysis.metadata.confidence * 100).toFixed(1)}%\n`;
    report += `- Duration: ${(analysis.metadata.durationMs / 1000).toFixed(2)}s\n`;
    report += `- Nodes: ${analysis.metadata.totalNodes}\n`;
    report += `- Cached: ${analysis.metadata.fromCache}\n`;
    report += `- Rendered: ${analysis.metadata.rendered}\n\n`;

    report += `**Extracted Data:**\n`;
    report += `- Prices: ${analysis.extracted.prices.length}\n`;
    report += `- Products: ${analysis.extracted.products.length}\n`;
    report += `- Shipping info: ${analysis.extracted.shipping.length}\n`;
    report += `- Conditions: ${analysis.extracted.conditions.length}\n`;
    report += `- Sellers: ${analysis.extracted.sellers.length}\n\n`;

    if (analysis.statistics.avgPrice) {
      report += `**Price Statistics:**\n`;
      report += `- Average: $${analysis.statistics.avgPrice.toFixed(2)}\n`;
      report += `- Range: $${analysis.statistics.minPrice?.toFixed(2)} - $${analysis.statistics.maxPrice?.toFixed(2)}\n`;
      report += `- Std Dev: $${analysis.statistics.priceStdDev?.toFixed(2)}\n`;
      report += `- Unique prices: ${analysis.statistics.uniquePrices}\n\n`;
    }

    report += `**Quality Score:** ${(analysis.quality.dataCompleteness * 100).toFixed(0)}%\n\n`;

    report += `---\n\n`;
  });

  // AI Feature Recommendations
  report += `## 🤖 AI Feature Recommendations\n\n`;

  if (recommendations.criticalFeatures.length > 0) {
    report += `### Critical Features (Build First)\n\n`;
    recommendations.criticalFeatures.forEach(feature => {
      report += `- ${feature}\n`;
    });
    report += `\n`;
  }

  if (recommendations.highPriorityFeatures.length > 0) {
    report += `### High Priority Features\n\n`;
    recommendations.highPriorityFeatures.forEach(feature => {
      report += `- ${feature}\n`;
    });
    report += `\n`;
  }

  if (recommendations.mediumPriorityFeatures.length > 0) {
    report += `### Medium Priority Features\n\n`;
    recommendations.mediumPriorityFeatures.forEach(feature => {
      report += `- ${feature}\n`;
    });
    report += `\n`;
  }

  // Questions Users Will Ask
  report += `### Questions Users Will Ask\n\n`;
  report += `Based on the data quality, users will likely ask:\n\n`;
  recommendations.questionsUsersWillAsk.forEach(q => {
    report += `- ${q}\n`;
  });
  report += `\n`;

  // Suggested Agents
  report += `### Suggested Agents to Build\n\n`;
  recommendations.suggestedAgents.forEach(agent => {
    report += `- \`${agent}\`\n`;
  });
  report += `\n`;

  // Data Quality Issues
  if (recommendations.dataQualityIssues.length > 0) {
    report += `### ⚠️ Data Quality Issues\n\n`;
    recommendations.dataQualityIssues.forEach(issue => {
      report += `- ${issue}\n`;
    });
    report += `\n`;
  }

  // Implementation Guide
  report += `## 🎯 Implementation Guide\n\n`;
  report += `Based on this validation, here's what to build next:\n\n`;

  report += `### Phase 1: Core RAG Pipeline (4 hours)\n\n`;
  report += `\`\`\`typescript\n`;
  report += `// src/ai/rag-pipeline.ts\n`;
  report += `export class RAGPipeline {\n`;
  report += `  async query(question: string): Promise<Answer> {\n`;
  report += `    // 1. Parse question (extract product, price range, conditions)\n`;
  report += `    // 2. Semantic search across cached listings\n`;
  report += `    // 3. Extract prices, shipping, conditions from results\n`;
  report += `    // 4. Compute statistics and answer question\n`;
  report += `    // 5. Generate answer with citations\n`;
  report += `  }\n`;
  report += `}\n`;
  report += `\`\`\`\n\n`;

  report += `### Phase 2: Price Analysis Agent (2 hours)\n\n`;
  report += `Focus on:\n`;
  report += `- Price comparison across listings\n`;
  report += `- Deal detection (outliers below average)\n`;
  report += `- Price trend analysis\n`;
  report += `- Shipping cost inclusion\n\n`;

  report += `### Phase 3: Agent Router (2 hours)\n\n`;
  report += `Build simple intent classification:\n`;
  report += `- Price queries → PriceAnalysisAgent\n`;
  report += `- Product research → ProductResearchAgent\n`;
  report += `- General questions → RAG Pipeline\n\n`;

  // Conclusion
  report += `## Conclusion\n\n`;
  report += `**Data Quality:** ${avgCompleteness > 0.7 ? '✅ Good' : avgCompleteness > 0.5 ? '⚠️ Moderate' : '❌ Needs Improvement'}\n`;
  report += `**Ready for AI:** ${avgCompleteness > 0.6 ? 'Yes' : 'No - improve extraction first'}\n\n`;

  report += `**Next Steps:**\n`;
  report += `1. Review this report\n`;
  report += `2. Build features in recommended order\n`;
  report += `3. Test with real FlipIQ workflows\n`;
  report += `4. Iterate based on user feedback\n\n`;

  return report;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function stdDev(values: number[]): number {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const squareDiffs = values.map(value => Math.pow(value - avg, 2));
  const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / squareDiffs.length;
  return Math.sqrt(avgSquareDiff);
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log('\n🚀 Anno Real-World Validation Suite');
  console.log('='.repeat(70));
  console.log(`📍 Endpoint: ${ANNO_ENDPOINT}`);
  console.log(`📦 Products to test: ${TEST_PRODUCTS.length}`);
  console.log(`📄 Output: ${OUTPUT_FILE}\n`);

  console.log('⚠️  Make sure Anno server is running: npm start\n');

  // Initialize client
  const anno = new AnnoClient({
    endpoint: ANNO_ENDPOINT,
    timeout: 60000, // 60 second timeout for rendered pages
  });

  // Health check
  try {
    const health = await anno.health();
    console.log(`✅ Anno is ${health.status}\n`);
  } catch (error) {
    console.error('❌ Cannot connect to Anno. Is it running?');
    console.error('   Start with: npm start');
    process.exit(1);
  }

  // Run analysis on all products
  const analyses: ProductAnalysis[] = [];

  for (const { name } of TEST_PRODUCTS) {
    try {
      const analysis = await analyzeProduct(anno, name);
      analyses.push(analysis);

      // Small delay between requests to be polite
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`\n❌ Error analyzing ${name}:`, error);
    }
  }

  // Generate recommendations
  console.log('\n' + '='.repeat(70));
  console.log('🤖 Generating AI Feature Recommendations');
  console.log('='.repeat(70) + '\n');

  const recommendations = generateRecommendations(analyses);

  console.log('📊 Recommendations:\n');
  console.log('Critical Features:');
  recommendations.criticalFeatures.forEach(f => console.log(`  - ${f}`));

  console.log('\nSuggested Agents:');
  recommendations.suggestedAgents.forEach(a => console.log(`  - ${a}`));

  console.log('\nQuestions Users Will Ask:');
  recommendations.questionsUsersWillAsk.slice(0, 3).forEach(q => console.log(`  - ${q}`));

  // Generate markdown report
  const report = generateMarkdownReport(analyses, recommendations);
  writeFileSync(OUTPUT_FILE, report);

  console.log(`\n✅ Report saved to: ${OUTPUT_FILE}`);
  console.log('\n📚 Next: Read the report and build the recommended AI features!\n');
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
