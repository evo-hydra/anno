#!/usr/bin/env npx tsx
/**
 * eBay Sold Prices Validation Test
 *
 * Validates Anno's ability to extract sold listing data from eBay.
 * This is THE critical test for FlipIQ integration.
 *
 * Usage:
 *   RENDERING_ENABLED=true RENDER_STEALTH=true npm start
 *   npx tsx validation/test-ebay-sold-prices.ts
 */

import { AnnoClient } from '../sdk/typescript/src/index';
import { buildEbaySoldUrl } from '../src/utils/ebay-url-builder';
import { writeFileSync } from 'fs';
import { join } from 'path';

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

interface SoldItem {
  title: string;
  price: number | null;
  soldDate: string | null;
  condition: string | null;
  shipping: string | null;
  seller: string | null;
}

interface ValidationResult {
  product: string;
  url: string;
  itemsFound: number;
  itemsWithPrices: number;
  itemsWithDates: number;
  itemsWithCondition: number;
  items: SoldItem[];
  priceStats: {
    min: number;
    max: number;
    avg: number;
    median: number;
  } | null;
  dataCompleteness: number;
  success: boolean;
  error?: string;
  executionTimeMs: number;
}

class EbaySoldPricesValidator {
  private anno: AnnoClient;
  private results: ValidationResult[] = [];

  constructor(endpoint = 'http://localhost:5213') {
    this.anno = new AnnoClient({
      endpoint,
      timeout: 60000, // 60s for complex pages
    });
  }

  /**
   * Test sold prices extraction for a product
   */
  async testProduct(product: string): Promise<ValidationResult> {
    console.log(`\n${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    console.log(`${colors.bright}Testing: ${product}${colors.reset}`);
    console.log(`${colors.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

    const startTime = Date.now();

    // Build sold listings URL
    const url = buildEbaySoldUrl(product, {
      sortBy: 'date_recent',
      itemsPerPage: 60, // Get as many as possible
    });

    console.log(`🌐 URL: ${url}`);
    console.log(`⏳ Fetching sold listings (this may take 20-30s with rendering)...\n`);

    try {
      // Fetch with rendering enabled
      const result = await this.anno.fetch(url, {
        render: true,
        maxNodes: 100,
        useCache: true,
      });

      const executionTimeMs = Date.now() - startTime;

      // Extract sold items
      const items = this.extractSoldItems(result);

      console.log(`${colors.green}✓ Extraction complete${colors.reset}`);
      console.log(`⏱️  Time: ${(executionTimeMs / 1000).toFixed(2)}s\n`);

      // Calculate statistics
      const itemsWithPrices = items.filter((i) => i.price !== null).length;
      const itemsWithDates = items.filter((i) => i.soldDate !== null).length;
      const itemsWithCondition = items.filter((i) => i.condition !== null).length;

      const priceStats = this.calculatePriceStats(items);
      const dataCompleteness = this.calculateDataCompleteness(items);

      // Display results
      this.displayResults({
        product,
        url,
        itemsFound: items.length,
        itemsWithPrices,
        itemsWithDates,
        itemsWithCondition,
        priceStats,
        dataCompleteness,
        items,
      });

      const validationResult: ValidationResult = {
        product,
        url,
        itemsFound: items.length,
        itemsWithPrices,
        itemsWithDates,
        itemsWithCondition,
        items,
        priceStats,
        dataCompleteness,
        success: itemsWithPrices >= 10 && dataCompleteness >= 0.6, // Success criteria
        executionTimeMs,
      };

      this.results.push(validationResult);
      return validationResult;
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;
      console.log(`${colors.red}✗ Error: ${(error as Error).message}${colors.reset}\n`);

      const validationResult: ValidationResult = {
        product,
        url,
        itemsFound: 0,
        itemsWithPrices: 0,
        itemsWithDates: 0,
        itemsWithCondition: 0,
        items: [],
        priceStats: null,
        dataCompleteness: 0,
        success: false,
        error: (error as Error).message,
        executionTimeMs,
      };

      this.results.push(validationResult);
      return validationResult;
    }
  }

  /**
   * Extract sold items from Anno result
   */
  private extractSoldItems(result: any): SoldItem[] {
    const items: SoldItem[] = [];
    const text = result.distilled?.markdown || result.markdown || '';

    // Parse each line looking for sold item data
    const lines = text.split('\n');

    let currentItem: Partial<SoldItem> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect item title (usually longer text)
      if (trimmed.length > 20 && !trimmed.startsWith('$') && !trimmed.toLowerCase().includes('sold')) {
        // Save previous item
        if (currentItem && currentItem.title) {
          items.push(currentItem as SoldItem);
        }

        // Start new item
        currentItem = {
          title: trimmed,
          price: null,
          soldDate: null,
          condition: null,
          shipping: null,
          seller: null,
        };
      } else if (currentItem) {
        // Extract price
        const priceMatch = trimmed.match(/\$[\d,]+\.?\d*/);
        if (priceMatch && !currentItem.price) {
          const priceStr = priceMatch[0].replace(/[$,]/g, '');
          currentItem.price = parseFloat(priceStr);
        }

        // Extract sold date
        if (trimmed.toLowerCase().includes('sold') && trimmed.match(/\w{3}\s+\d{1,2}/)) {
          currentItem.soldDate = trimmed;
        }

        // Extract condition
        if (
          trimmed.match(/\b(new|used|refurbished|pre-owned|open box)\b/i) &&
          !currentItem.condition
        ) {
          currentItem.condition = trimmed;
        }

        // Extract shipping
        if (trimmed.toLowerCase().includes('shipping') && !currentItem.shipping) {
          currentItem.shipping = trimmed;
        }
      }
    }

    // Save last item
    if (currentItem && currentItem.title) {
      items.push(currentItem as SoldItem);
    }

    return items;
  }

  /**
   * Calculate price statistics
   */
  private calculatePriceStats(items: SoldItem[]) {
    const prices = items.map((i) => i.price).filter((p) => p !== null) as number[];

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);

    return {
      min: prices[0],
      max: prices[prices.length - 1],
      avg: prices.reduce((a, b) => a + b, 0) / prices.length,
      median: prices[Math.floor(prices.length / 2)],
    };
  }

  /**
   * Calculate data completeness score
   */
  private calculateDataCompleteness(items: SoldItem[]): number {
    if (items.length === 0) return 0;

    let score = 0;
    let maxScore = 0;

    for (const item of items) {
      if (item.title) score += 0.2;
      if (item.price) score += 0.4; // Price is most important
      if (item.soldDate) score += 0.2;
      if (item.condition) score += 0.1;
      if (item.shipping) score += 0.1;
      maxScore += 1;
    }

    return score / maxScore;
  }

  /**
   * Display results in terminal
   */
  private displayResults(result: {
    product: string;
    itemsFound: number;
    itemsWithPrices: number;
    itemsWithDates: number;
    itemsWithCondition: number;
    priceStats: any;
    dataCompleteness: number;
    items: SoldItem[];
  }) {
    console.log(`${colors.bright}📊 RESULTS${colors.reset}\n`);

    // Items found
    const itemsColor = result.itemsFound >= 20 ? colors.green : colors.yellow;
    console.log(`  ${itemsColor}Items found: ${result.itemsFound}${colors.reset}`);
    console.log(`  ${itemsColor}With prices: ${result.itemsWithPrices}${colors.reset}`);
    console.log(`  ${itemsColor}With dates: ${result.itemsWithDates}${colors.reset}`);
    console.log(`  ${itemsColor}With condition: ${result.itemsWithCondition}${colors.reset}`);

    // Price statistics
    if (result.priceStats) {
      console.log(`\n  ${colors.bright}💰 Price Statistics:${colors.reset}`);
      console.log(`    Min: $${result.priceStats.min.toFixed(2)}`);
      console.log(`    Max: $${result.priceStats.max.toFixed(2)}`);
      console.log(`    Avg: $${result.priceStats.avg.toFixed(2)}`);
      console.log(`    Median: $${result.priceStats.median.toFixed(2)}`);
    }

    // Data completeness
    const completenessPercent = (result.dataCompleteness * 100).toFixed(1);
    const completenessColor = result.dataCompleteness >= 0.7 ? colors.green : result.dataCompleteness >= 0.5 ? colors.yellow : colors.red;
    console.log(`\n  ${completenessColor}Data completeness: ${completenessPercent}%${colors.reset}`);

    // Sample items
    console.log(`\n  ${colors.bright}Sample items:${colors.reset}`);
    for (const item of result.items.slice(0, 3)) {
      console.log(`    • ${item.title.slice(0, 50)}...`);
      console.log(`      Price: ${item.price ? `$${item.price}` : 'N/A'} | Date: ${item.soldDate || 'N/A'}`);
    }
  }

  /**
   * Generate summary report
   */
  generateReport() {
    console.log(`\n${colors.cyan}${'═'.repeat(60)}${colors.reset}`);
    console.log(`${colors.bright}EBAY SOLD PRICES VALIDATION SUMMARY${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(60)}${colors.reset}\n`);

    const totalTests = this.results.length;
    const passedTests = this.results.filter((r) => r.success).length;
    const successRate = (passedTests / totalTests) * 100;

    // Overall success rate
    const rateColor = successRate >= 80 ? colors.green : successRate >= 60 ? colors.yellow : colors.red;
    console.log(`${rateColor}Success Rate: ${successRate.toFixed(1)}% (${passedTests}/${totalTests})${colors.reset}\n`);

    // Per-product results
    console.log(`${colors.bright}Per-Product Results:${colors.reset}\n`);
    for (const result of this.results) {
      const status = result.success ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`;
      console.log(`  ${status} ${result.product}`);
      console.log(`    Items: ${result.itemsWithPrices}/${result.itemsFound} with prices`);
      console.log(`    Completeness: ${(result.dataCompleteness * 100).toFixed(1)}%`);
      console.log(`    Time: ${(result.executionTimeMs / 1000).toFixed(2)}s\n`);
    }

    // Save detailed results
    this.saveResults();

    // Final verdict
    if (successRate >= 80) {
      console.log(`${colors.green}${colors.bright}🎉 EXCELLENT! Anno is ready for production.${colors.reset}\n`);
    } else if (successRate >= 60) {
      console.log(`${colors.yellow}${colors.bright}⚠️  GOOD, but needs improvement.${colors.reset}\n`);
    } else {
      console.log(`${colors.red}${colors.bright}❌ NEEDS WORK. Check configuration.${colors.reset}\n`);
    }
  }

  /**
   * Save results to JSON file
   */
  private saveResults() {
    const outputPath = join(__dirname, 'ebay-sold-prices-results.json');
    writeFileSync(outputPath, JSON.stringify(this.results, null, 2));
    console.log(`${colors.cyan}📄 Detailed results saved to: ${outputPath}${colors.reset}\n`);
  }
}

/**
 * Run validation tests
 */
async function main() {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  ANNO - eBay Sold Prices Validation                   ║');
  console.log('║  Competition Killer Edition                           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  const validator = new EbaySoldPricesValidator();

  // Test products (FlipIQ use cases)
  const testProducts = [
    'Nintendo Switch OLED',
    'iPhone 13 Pro Max 256GB',
    'PlayStation 5 Console',
    'MacBook Pro M3',
    'AirPods Pro 2nd Generation',
  ];

  console.log(`${colors.bright}Testing ${testProducts.length} products...${colors.reset}\n`);

  for (const product of testProducts) {
    await validator.testProduct(product);

    // Small delay between requests
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Generate final report
  validator.generateReport();
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error(`${colors.red}Fatal error: ${error.message}${colors.reset}`);
    process.exit(1);
  });
}

export { EbaySoldPricesValidator, ValidationResult };
