/**
 * Price Analysis RAG Pipeline
 *
 * AI-powered price analysis for eBay sold listings.
 * Provides intelligent market insights for FlipIQ.
 *
 * @module ai/price-analysis-rag
 */

import { buildEbaySoldUrl } from '../utils/ebay-url-builder';
import { logger } from '../utils/logger';
import { type EbaySoldListing } from '../services/extractors/ebay-adapter';
import { type EbaySoldSearchExtraction } from '../services/extractors/ebay-search-adapter';

// AnnoClient types (would normally import from SDK package)
interface FetchOptions {
  render?: boolean;
  maxNodes?: number;
  useCache?: boolean;
}

interface AnnoExtractionPayload {
  method: string;
  confidence: number;
  fallbackUsed: boolean;
  byline: string | null;
  siteName: string | null;
  ebayListing?: EbaySoldListing;
  ebaySearch?: EbaySoldSearchExtraction;
}

interface AnnoFetchResponse {
  markdown: string;
  nodes: string[];
  extraction?: AnnoExtractionPayload;
}

class AnnoClient {
  private endpoint: string;
  private timeout: number;

  constructor(config: { endpoint: string; timeout: number }) {
    this.endpoint = config.endpoint;
    this.timeout = config.timeout;
  }

  async fetch(url: string, options: FetchOptions): Promise<AnnoFetchResponse> {
    // This would normally use the SDK, but for now we'll use fetch directly
    const response = await fetch(`${this.endpoint}/v1/content/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, options }),
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      throw new Error(`Anno fetch failed: ${response.statusText}`);
    }

    // Parse JSONL stream
    const text = await response.text();
    const lines = text.split('\n').filter(l => l.trim());

    let markdown = '';
    const nodes: string[] = [];
    let extraction: AnnoExtractionPayload | undefined;

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'node' && obj.payload?.text) {
          markdown += obj.payload.text + '\n';
          nodes.push(obj.payload.text);
        } else if (obj.type === 'extraction' && obj.payload) {
          extraction = {
            method: obj.payload.method,
            confidence: obj.payload.confidence,
            fallbackUsed: obj.payload.fallbackUsed,
            byline: obj.payload.byline ?? null,
            siteName: obj.payload.siteName ?? null,
            ebayListing: obj.payload.ebayListing,
            ebaySearch: obj.payload.ebaySearch
          };
        }
      } catch {
        // Ignore parse errors
      }
    }

    return { markdown, nodes, extraction };
  }
}

export interface PriceDataPoint {
  price: number;
  currency: string;
  soldDate: Date | null;
  condition: 'new' | 'used' | 'refurbished' | 'parts' | 'unknown';
  title: string;
  shipping: number | null;
  url: string;
}

export interface PriceStatistics {
  count: number;
  mean: number;
  median: number;
  mode: number | null;
  min: number;
  max: number;
  stdDev: number;
  variance: number;
  range: number;
  percentiles: {
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    p95: number;
  };
}

export interface PriceAnalysisResult {
  product: string;
  statistics: PriceStatistics;
  byCondition: Record<string, PriceStatistics>;
  deals: Array<{
    item: PriceDataPoint;
    savingsPercent: number;
    reason: string;
  }>;
  trends: {
    direction: 'up' | 'down' | 'stable';
    recentAvg: number;
    olderAvg: number;
    changePercent: number;
  } | null;
  recommendations: string[];
  confidence: number;
  dataPoints: PriceDataPoint[];
}

export class PriceAnalysisRAG {
  private anno: AnnoClient;

  constructor(annoEndpoint = 'http://localhost:5213') {
    this.anno = new AnnoClient({
      endpoint: annoEndpoint,
      timeout: 60000,
    });
  }

  /**
   * Analyze prices for a product
   *
   * @example
   * const rag = new PriceAnalysisRAG();
   * const analysis = await rag.analyze('Nintendo Switch OLED');
   * console.log(`Average price: $${analysis.statistics.mean.toFixed(2)}`);
   */
  async analyze(product: string, options?: {
    condition?: 'new' | 'used' | 'refurbished';
    maxItems?: number;
    daysBack?: number;
  }): Promise<PriceAnalysisResult> {
    logger.info('Starting price analysis', { product, options });

    // Fetch sold listings
    const url = buildEbaySoldUrl(product, {
      condition: options?.condition,
      sortBy: 'date_recent',
      itemsPerPage: options?.maxItems || 60,
    });

    const result = await this.anno.fetch(url, {
      render: true,
      maxNodes: 100,
      useCache: true,
    });

    // Extract price data points
    const dataPoints = this.extractPriceData(result);

    if (dataPoints.length === 0) {
      throw new Error('No price data found');
    }

    logger.info('Extracted price data', { count: dataPoints.length });

    // Calculate statistics
    const statistics = this.calculateStatistics(dataPoints);

    // Group by condition
    const byCondition = this.groupByCondition(dataPoints);

    // Find deals
    const deals = this.findDeals(dataPoints, statistics);

    // Analyze trends
    const trends = this.analyzeTrends(dataPoints, options?.daysBack || 30);

    // Generate recommendations
    const recommendations = this.generateRecommendations({
      statistics,
      byCondition,
      deals,
      trends,
    });

    // Calculate confidence score
    const confidence = this.calculateConfidence(dataPoints);

    return {
      product,
      statistics,
      byCondition,
      deals,
      trends,
      recommendations,
      confidence,
      dataPoints,
    };
  }

  /**
   * Extract price data from Anno result
   */
  private extractPriceData(result: AnnoFetchResponse): PriceDataPoint[] {
    const dataPoints: PriceDataPoint[] = [];

    if (result.extraction?.ebaySearch) {
      for (const item of result.extraction.ebaySearch.items) {
        if (item.price === null || item.price <= 0) {
          continue;
        }

        let soldDate: Date | null = null;
        if (item.soldDate) {
          const parsed = new Date(item.soldDate);
          if (!Number.isNaN(parsed.getTime())) {
            soldDate = parsed;
          }
        }

        const normalizedCondition = this.normalizeCondition(item.condition);

        dataPoints.push({
          title: item.title,
          price: item.price,
          currency: item.currency,
          soldDate,
          condition: normalizedCondition,
          shipping: item.shippingCost,
          url: item.url ?? ''
        });
      }

      if (dataPoints.length > 0) {
        return dataPoints;
      }
    }

    // Fallback: parse markdown stream
    const fallbackPoints: PriceDataPoint[] = [];
    const text = result.markdown || '';
    const lines = text.split('\n');

    let currentItem: Partial<PriceDataPoint> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect item title
      if (trimmed.length > 20 && !trimmed.startsWith('$')) {
        if (currentItem && currentItem.price && currentItem.title) {
          fallbackPoints.push(currentItem as PriceDataPoint);
        }

        currentItem = {
          title: trimmed,
          price: 0,
          currency: 'USD',
          soldDate: null,
          condition: 'unknown',
          shipping: null,
          url: ''
        };
      } else if (currentItem) {
        // Extract price
        const priceMatch = trimmed.match(/\$[\d,]+\.?\d*/);
        if (priceMatch && currentItem.price === 0) {
          const priceStr = priceMatch[0].replace(/[$,]/g, '');
          currentItem.price = parseFloat(priceStr);
          currentItem.currency = 'USD';
        }

        // Extract date
        const dateMatch = trimmed.match(/Sold\s+(\w{3}\s+\d{1,2},?\s+\d{4})/i);
        if (dateMatch) {
          try {
            currentItem.soldDate = new Date(dateMatch[1]);
          } catch {
            currentItem.soldDate = null;
          }
        }

        // Extract condition
        if (trimmed.match(/\bnew\b/i)) {
          currentItem.condition = 'new';
        } else if (trimmed.match(/\bused\b/i)) {
          currentItem.condition = 'used';
        } else if (trimmed.match(/\brefurbished\b/i)) {
          currentItem.condition = 'refurbished';
        } else if (trimmed.match(/\bparts\b/i)) {
          currentItem.condition = 'parts';
        }

        // Extract shipping
        const shippingMatch = trimmed.match(/\$[\d.]+\s*shipping/i);
        if (shippingMatch) {
          const shippingStr = shippingMatch[0].match(/\$[\d.]+/)?.[0].replace('$', '');
          if (shippingStr) {
            currentItem.shipping = parseFloat(shippingStr);
          }
        }
      }
    }

    // Save last item
    if (currentItem && currentItem.price && currentItem.title) {
      fallbackPoints.push(currentItem as PriceDataPoint);
    }

    return fallbackPoints.filter((dp) => dp.price > 0);
  }

  private normalizeCondition(raw: string | null): PriceDataPoint['condition'] {
    if (!raw) {
      return 'unknown';
    }

    const lower = raw.toLowerCase();
    if (lower.includes('new')) {
      return 'new';
    }
    if (lower.includes('used')) {
      return 'used';
    }
    if (lower.includes('refurbished')) {
      return 'refurbished';
    }
    if (lower.includes('parts') || lower.includes('not working')) {
      return 'parts';
    }
    return 'unknown';
  }

  /**
   * Calculate comprehensive price statistics
   */
  private calculateStatistics(data: PriceDataPoint[]): PriceStatistics {
    const prices = data.map((d) => d.price).sort((a, b) => a - b);
    const n = prices.length;

    if (n === 0) {
      throw new Error('No price data to analyze');
    }

    // Mean
    const mean = prices.reduce((a, b) => a + b, 0) / n;

    // Median
    const median = n % 2 === 0 ? (prices[n / 2 - 1] + prices[n / 2]) / 2 : prices[Math.floor(n / 2)];

    // Mode (most common price)
    const frequency: Record<number, number> = {};
    let maxFreq = 0;
    let mode: number | null = null;

    for (const price of prices) {
      frequency[price] = (frequency[price] || 0) + 1;
      if (frequency[price] > maxFreq) {
        maxFreq = frequency[price];
        mode = price;
      }
    }

    // Only use mode if it appears more than once
    if (maxFreq <= 1) mode = null;

    // Standard deviation and variance
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    // Percentiles
    const percentile = (p: number) => {
      const index = Math.ceil((p / 100) * n) - 1;
      return prices[Math.max(0, Math.min(index, n - 1))];
    };

    return {
      count: n,
      mean,
      median,
      mode,
      min: prices[0],
      max: prices[n - 1],
      stdDev,
      variance,
      range: prices[n - 1] - prices[0],
      percentiles: {
        p25: percentile(25),
        p50: percentile(50),
        p75: percentile(75),
        p90: percentile(90),
        p95: percentile(95),
      },
    };
  }

  /**
   * Group data by condition and calculate stats for each
   */
  private groupByCondition(data: PriceDataPoint[]): Record<string, PriceStatistics> {
    const groups: Record<string, PriceDataPoint[]> = {};

    for (const item of data) {
      const condition = item.condition || 'unknown';
      if (!groups[condition]) {
        groups[condition] = [];
      }
      groups[condition].push(item);
    }

    const result: Record<string, PriceStatistics> = {};
    for (const [condition, items] of Object.entries(groups)) {
      if (items.length > 0) {
        result[condition] = this.calculateStatistics(items);
      }
    }

    return result;
  }

  /**
   * Find deals (prices significantly below average)
   */
  private findDeals(
    data: PriceDataPoint[],
    stats: PriceStatistics
  ): Array<{ item: PriceDataPoint; savingsPercent: number; reason: string }> {
    const deals: Array<{ item: PriceDataPoint; savingsPercent: number; reason: string }> = [];

    // Define "deal" threshold: more than 15% below mean
    const dealThreshold = stats.mean * 0.85;

    for (const item of data) {
      if (item.price < dealThreshold) {
        const savingsPercent = ((stats.mean - item.price) / stats.mean) * 100;

        let reason = `${savingsPercent.toFixed(1)}% below average`;

        // Add context
        if (item.price < stats.percentiles.p25) {
          reason += ' (bottom 25%)';
        }
        if (item.condition === 'new') {
          reason += ' + NEW condition!';
        }
        if (item.shipping === 0) {
          reason += ' + FREE shipping';
        }

        deals.push({ item, savingsPercent, reason });
      }
    }

    // Sort by savings
    return deals.sort((a, b) => b.savingsPercent - a.savingsPercent).slice(0, 10);
  }

  /**
   * Analyze price trends over time
   */
  private analyzeTrends(
    data: PriceDataPoint[],
    daysBack: number
  ): {
    direction: 'up' | 'down' | 'stable';
    recentAvg: number;
    olderAvg: number;
    changePercent: number;
  } | null {
    // Filter items with dates
    const withDates = data.filter((d) => d.soldDate !== null);

    if (withDates.length < 10) {
      return null; // Not enough data
    }

    const now = new Date();
    const cutoffRecent = new Date(now.getTime() - daysBack / 2 * 24 * 60 * 60 * 1000);
    const cutoffOlder = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const recent = withDates.filter((d) => d.soldDate! >= cutoffRecent);
    const older = withDates.filter((d) => d.soldDate! < cutoffRecent && d.soldDate! >= cutoffOlder);

    if (recent.length === 0 || older.length === 0) {
      return null;
    }

    const recentAvg = recent.reduce((sum, d) => sum + d.price, 0) / recent.length;
    const olderAvg = older.reduce((sum, d) => sum + d.price, 0) / older.length;

    const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;

    let direction: 'up' | 'down' | 'stable' = 'stable';
    if (changePercent > 5) direction = 'up';
    else if (changePercent < -5) direction = 'down';

    return {
      direction,
      recentAvg,
      olderAvg,
      changePercent,
    };
  }

  /**
   * Generate actionable recommendations
   */
  private generateRecommendations(analysis: {
    statistics: PriceStatistics;
    byCondition: Record<string, PriceStatistics>;
    deals: Array<{ item: PriceDataPoint; savingsPercent: number; reason: string }>;
    trends: {
      direction: 'up' | 'down' | 'stable';
      recentAvg: number;
      olderAvg: number;
      changePercent: number;
    } | null;
  }): string[] {
    const recommendations: string[] = [];

    // Price range recommendation
    recommendations.push(
      `Typical price range: $${analysis.statistics.percentiles.p25.toFixed(2)} - $${analysis.statistics.percentiles.p75.toFixed(2)}`
    );

    // Median vs mean
    if (Math.abs(analysis.statistics.median - analysis.statistics.mean) > analysis.statistics.mean * 0.1) {
      recommendations.push(
        `Price distribution is skewed. Focus on median ($${analysis.statistics.median.toFixed(2)}) rather than average.`
      );
    }

    // Condition-based
    if (analysis.byCondition.new && analysis.byCondition.used) {
      const newAvg = analysis.byCondition.new.mean;
      const usedAvg = analysis.byCondition.used.mean;
      const savings = ((newAvg - usedAvg) / newAvg) * 100;

      recommendations.push(
        `Buying used saves ~${savings.toFixed(0)}% (avg $${usedAvg.toFixed(2)} vs $${newAvg.toFixed(2)} new)`
      );
    }

    // Deals
    if (analysis.deals.length > 0) {
      recommendations.push(`Found ${analysis.deals.length} deals below market average!`);
    }

    // Trends
    if (analysis.trends) {
      if (analysis.trends.direction === 'up') {
        recommendations.push(
          `⚠️ Prices trending UP (+${analysis.trends.changePercent.toFixed(1)}%). Consider buying soon.`
        );
      } else if (analysis.trends.direction === 'down') {
        recommendations.push(
          `📉 Prices trending DOWN (${analysis.trends.changePercent.toFixed(1)}%). May be worth waiting.`
        );
      }
    }

    return recommendations;
  }

  /**
   * Calculate confidence score based on data quality
   */
  private calculateConfidence(data: PriceDataPoint[]): number {
    let confidence = 0;

    // Sample size
    if (data.length >= 50) confidence += 0.4;
    else if (data.length >= 20) confidence += 0.3;
    else if (data.length >= 10) confidence += 0.2;
    else confidence += 0.1;

    // Date coverage
    const withDates = data.filter((d) => d.soldDate !== null).length;
    confidence += (withDates / data.length) * 0.3;

    // Condition data
    const withCondition = data.filter((d) => d.condition !== 'unknown').length;
    confidence += (withCondition / data.length) * 0.2;

    // Price variance (lower is better)
    const prices = data.map((d) => d.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const cv = Math.sqrt(variance) / mean; // Coefficient of variation

    if (cv < 0.2) confidence += 0.1;
    else if (cv < 0.4) confidence += 0.05;

    return Math.min(confidence, 1.0);
  }
}

// Export singleton
export const priceAnalysisRAG = new PriceAnalysisRAG();
