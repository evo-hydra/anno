/**
 * eBay Search Adapter
 *
 * Extends EbayAdapterV2 with search capability for sold price lookups.
 * Implements MarketplaceSearchAdapter interface.
 *
 * @module extractors/ebay-search-adapter
 */

import { JSDOM } from 'jsdom';
import { logger } from '../../utils/logger';
import { EbayAdapterV2 } from './ebay-adapter-v2';
import { ebaySearchFetcher } from './ebay-search-fetcher';
import {
  MarketplaceSearchAdapter,
  SearchOptions,
  SearchResponse,
  SearchResult,
  PriceStatistics,
  MarketplaceListing,
} from './marketplace-adapter';

// ============================================================================
// Legacy Interfaces (for backward compatibility)
// ============================================================================

export interface EbaySoldSearchItem {
  title: string;
  price: number | null;
  currency: string;
  priceText: string | null;
  soldDate: string | null;
  condition: string | null;
  shippingText: string | null;
  shippingCost: number | null;
  url: string | null;
}

export interface EbaySoldSearchExtraction {
  items: EbaySoldSearchItem[];
  detectedCount: number;
  extractedCount: number;
  confidence: number;
}

// ============================================================================
// EbaySearchAdapter - Implements MarketplaceSearchAdapter
// ============================================================================

export class EbaySearchAdapter extends EbayAdapterV2 implements MarketplaceSearchAdapter {
  /**
   * Search eBay for products matching query
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResponse> {
    logger.debug('eBay search', { query, options });

    const searchUrl = this.buildSearchUrl(query, options);
    logger.debug('eBay search URL', { searchUrl });

    // Fetch using Playwright (bypasses bot detection)
    // Longer timeout to handle challenge page resolution (up to 15s)
    const fetchResult = await ebaySearchFetcher.fetch(searchUrl, {
      timeout: 45000,
      retryAttempts: 3,
    });

    if (!fetchResult.success || !fetchResult.html) {
      throw new Error(
        `Failed to fetch eBay search results: ${fetchResult.error?.message || 'Unknown error'}`
      );
    }

    logger.info('eBay search HTML fetched successfully', {
      htmlSize: fetchResult.html.length,
      duration: fetchResult.metadata.duration,
      challengeDetected: fetchResult.metadata.challengeDetected,
    });

    // Parse the fetched HTML
    return this.parseSearchResultsFromHtml(fetchResult.html, query, options);
  }

  /**
   * Convenience method to get sold price statistics
   */
  async searchSoldPrices(query: string, options?: SearchOptions): Promise<PriceStatistics | null> {
    const searchOptions: SearchOptions = {
      ...options,
      soldOnly: true, // Force sold-only filtering
      maxResults: options?.maxResults || 50,
    };

    const response = await this.search(query, searchOptions);
    return response.priceStats || null;
  }

  // =========================================================================
  // Public API for External HTTP Fetching
  // =========================================================================

  /**
   * Build eBay search URL with filters
   * Public method for external use by MarketplaceRegistry
   */
  buildSearchUrl(query: string, options?: SearchOptions): string {
    const baseUrl = 'https://www.ebay.com/sch/i.html';
    const params = new URLSearchParams();

    // Query
    params.append('_nkw', query);

    // Sold/completed listings filter
    if (options?.soldOnly) {
      params.append('LH_Sold', '1'); // Sold listings only
      params.append('LH_Complete', '1'); // Completed listings
    }

    // Max results (pagination)
    if (options?.maxResults) {
      const itemsPerPage = Math.min(options.maxResults, 200); // eBay max is 200
      params.append('_ipg', itemsPerPage.toString());
    }

    // Sorting
    if (options?.sortBy) {
      const sortMap = {
        relevance: '12', // Best match
        price_low: '15', // Price + shipping: lowest first
        price_high: '16', // Price + shipping: highest first
        date_new: '10', // End date: newest first
        date_old: '1', // End date: soonest first
      };
      params.append('_sop', sortMap[options.sortBy] || '12');
    }

    // Price filters
    if (options?.filters?.priceMin) {
      params.append('_udlo', options.filters.priceMin.toString());
    }
    if (options?.filters?.priceMax) {
      params.append('_udhi', options.filters.priceMax.toString());
    }

    // Condition filters
    if (options?.filters?.condition && options.filters.condition.length > 0) {
      const conditionMap = {
        new: '1000',
        used_like_new: '1500',
        used_very_good: '2000',
        used_good: '3000',
        used_acceptable: '4000',
        refurbished: '2000',
        unknown: '',
      };

      const conditionCodes = options.filters.condition
        .map(c => conditionMap[c])
        .filter(Boolean);

      if (conditionCodes.length > 0) {
        params.append('LH_ItemCondition', conditionCodes.join('|'));
      }
    }

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Parse search results from HTML
   * Public method for external use - caller fetches HTML and passes it here
   */
  async parseSearchResultsFromHtml(
    html: string,
    query: string,
    _options?: SearchOptions
  ): Promise<SearchResponse> {
    const results = await this.parseSearchResults(html);
    const priceStats = this.aggregatePrices(results);

    return {
      query,
      marketplace: 'ebay',
      results,
      totalResults: results.length,
      priceStats: priceStats || undefined,
      searchedAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Search Results Parser
  // =========================================================================

  /**
   * Parse eBay search results page (internal method)
   */
  private async parseSearchResults(html: string): Promise<SearchResult[]> {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    // eBay uses both .s-item and .s-card class structures depending on layout
    // Try .s-card first (2025 design), fall back to .s-item (legacy)
    let items = Array.from(document.querySelectorAll('ul.srp-results > li.s-card'));
    if (items.length === 0) {
      items = Array.from(document.querySelectorAll('li.s-item'));
    }

    logger.debug('eBay search adapter parsing results', {
      detectedItems: items.length,
      selector: items.length > 0 && items[0].className.includes('s-card') ? '.s-card' : '.s-item',
    });

    const results: SearchResult[] = [];

    for (const element of items) {
      const searchResult = await this.parseSearchResultItem(element);
      if (searchResult) {
        results.push(searchResult);
      }
    }

    return results;
  }

  /**
   * Parse a single search result item
   */
  private async parseSearchResultItem(element: Element): Promise<SearchResult | null> {
    // Extract title - try both .s-card and .s-item patterns
    const title =
      element.querySelector('.s-card__title span')?.textContent?.trim() ||
      element.querySelector('.s-card__title')?.textContent?.trim() ||
      element.querySelector('.s-item__title')?.textContent?.trim() ||
      element.querySelector('[role="heading"]')?.textContent?.trim() ||
      null;

    // Skip eBay header items
    if (!title || title.toLowerCase().includes('shop on ebay')) {
      return null;
    }

    // Extract price - try both .s-card and .s-item patterns
    const priceText =
      element.querySelector('.s-card__price')?.textContent?.trim() ||
      element.querySelector('.s-item__price')?.textContent?.trim() ||
      null;

    const { price, currency } = this.parsePrice(priceText || '');

    // Skip items without price
    if (price === null) {
      return null;
    }

    // Extract sold date - try both patterns
    const soldDateSource =
      element.querySelector('.s-card__subtitle')?.textContent ||
      element.querySelector('.s-item__title--tag')?.textContent ||
      element.querySelector('.s-item__subtitle')?.textContent ||
      element.textContent;

    let soldDate: string | null = null;
    if (soldDateSource) {
      const match = soldDateSource.match(/Sold\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i);
      if (match) {
        soldDate = match[1];
      }
    }

    // Extract condition - try both patterns
    const conditionText =
      element.querySelector('.s-card__subtitle span')?.textContent?.trim() ||
      element.querySelector('.s-item__subtitle span')?.textContent?.trim() ||
      element.querySelector('.SECONDARY_INFO')?.textContent?.trim() ||
      null;

    // Extract shipping - try both patterns
    const shippingText =
      element.querySelector('.s-card__shipping')?.textContent?.trim() ||
      element.querySelector('.s-item__shipping')?.textContent?.trim() ||
      null;

    const shippingCost = this.parseShippingCost(shippingText);

    // Extract URL - try both patterns
    const link =
      element.querySelector<HTMLAnchorElement>('a.s-item__link')?.href ||
      element.querySelector<HTMLAnchorElement>('a[href*="/itm/"]')?.href ||
      null;

    if (!link) {
      return null;
    }

    // Extract item number from URL
    const itemIdMatch = link.match(/\/itm\/(\d+)/);
    const itemNumber = itemIdMatch ? itemIdMatch[1] : null;

    // Extract image - try both patterns
    const imgElement =
      (element.querySelector('.s-card__image img') as HTMLImageElement) ||
      (element.querySelector('.s-item__image-img') as HTMLImageElement);
    const imageUrl = imgElement?.src || null;

    // Determine availability
    const availability = soldDate ? 'sold' : 'unknown';

    // Build listing
    const listing: MarketplaceListing = {
      id: itemNumber || `ebay-search-${Date.now()}-${Math.random()}`,
      marketplace: 'ebay',
      url: link,
      title,
      price: { amount: price, currency },
      shippingCost: shippingCost !== null ? { amount: shippingCost, currency } : undefined,
      condition: this.mapCondition(conditionText),
      availability,
      soldDate: soldDate || undefined,
      seller: {
        name: null, // Not available in search results
        rating: undefined,
      },
      images: imageUrl ? [imageUrl] : [],
      itemNumber: itemNumber || undefined,
      extractedAt: new Date().toISOString(),
      extractionMethod: `${this.name} Search v${this.version}`,
      confidence: this.calculateSearchResultConfidence({
        hasTitle: true,
        hasPrice: true,
        hasUrl: true,
        hasItemNumber: !!itemNumber,
      }),
      extractorVersion: this.version,
    };

    return {
      url: link,
      listing,
    };
  }

  /**
   * Parse shipping cost from text
   */
  private parseShippingCost(shippingText: string | null): number | null {
    if (!shippingText) {
      return null;
    }

    if (/free/i.test(shippingText)) {
      return 0;
    }

    const match = shippingText.match(/\$[\d,.]+/);
    if (match) {
      const value = match[0].replace(/[$,]/g, '');
      const amount = Number.parseFloat(value);
      return Number.isNaN(amount) ? null : amount;
    }

    return null;
  }

  /**
   * Calculate confidence for search result extractions
   */
  private calculateSearchResultConfidence(indicators: {
    hasTitle: boolean;
    hasPrice: boolean;
    hasUrl: boolean;
    hasItemNumber: boolean;
  }): number {
    let confidence = 0;

    if (indicators.hasTitle) confidence += 0.3;
    if (indicators.hasPrice) confidence += 0.4; // Price is critical
    if (indicators.hasUrl) confidence += 0.2;
    if (indicators.hasItemNumber) confidence += 0.1;

    return confidence;
  }

  // =========================================================================
  // Price Aggregation
  // =========================================================================

  /**
   * Aggregate price statistics from search results
   */
  aggregatePrices(results: SearchResult[]): PriceStatistics | null {
    // Extract prices
    const prices = results
      .map(r => r.listing.price?.amount)
      .filter((p): p is number => p !== null && p !== undefined);

    if (prices.length === 0) {
      return null;
    }

    // Sort prices
    const sorted = prices.sort((a, b) => a - b);

    // Calculate statistics
    const low = sorted[0];
    const high = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const average = sorted.reduce((sum, p) => sum + p, 0) / sorted.length;

    // Extract currency (assume all same currency)
    const currency = results.find(r => r.listing.price)?.listing.price?.currency || 'USD';

    return {
      count: prices.length,
      low,
      median,
      high,
      average,
      prices: sorted,
      currency,
    };
  }

  // =========================================================================
  // Legacy Interface Support
  // =========================================================================

  /**
   * Legacy extract method for backward compatibility
   * @deprecated Use parseSearchResultsFromHtml instead
   */
  extractLegacy(html: string, url: string): EbaySoldSearchExtraction {
    const dom = new JSDOM(html);
    const document = dom.window.document;

    const items = Array.from(document.querySelectorAll('li.s-item'));

    logger.debug('eBay search adapter (legacy) extracting', {
      url,
      detectedItems: items.length,
    });

    const results: EbaySoldSearchItem[] = [];

    for (const element of items) {
      const title =
        element.querySelector('.s-card__title span')?.textContent?.trim() ||
        element.querySelector('.s-item__title')?.textContent?.trim() ||
        null;

      if (!title || title.toLowerCase().includes('shop on ebay')) {
        continue;
      }

      const priceText =
        element.querySelector('.s-card__price')?.textContent?.trim() ||
        element.querySelector('.s-item__price')?.textContent?.trim() ||
        null;

      const { price, currency, raw } = this.parsePriceWithRaw(priceText);

      const soldDateSource =
        element.querySelector('.s-item__title--tag')?.textContent ||
        element.querySelector('.s-item__subtitle')?.textContent ||
        element.textContent;

      let soldDate: string | null = null;
      if (soldDateSource) {
        const match = soldDateSource.match(/Sold\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/i);
        if (match) {
          soldDate = match[1];
        }
      }

      const conditionText =
        element.querySelector('.s-item__subtitle span')?.textContent?.trim() ||
        element.querySelector('.SECONDARY_INFO')?.textContent?.trim() ||
        null;

      const shippingText =
        element.querySelector('.s-item__shipping')?.textContent?.trim() ||
        element.querySelector('.s-card__shipping')?.textContent?.trim() ||
        null;

      const shippingCost = this.parseShippingCost(shippingText);

      const link = element.querySelector<HTMLAnchorElement>('a.s-item__link')?.href ?? null;

      if (price === null) {
        continue;
      }

      results.push({
        title,
        price,
        currency,
        priceText: raw,
        soldDate,
        condition: conditionText,
        shippingText,
        shippingCost,
        url: link,
      });
    }

    const extractedCount = results.length;
    const detectedCount = items.length;
    const confidence =
      extractedCount === 0
        ? 0
        : Math.min(0.95, 0.5 + Math.min(0.4, extractedCount / Math.max(10, detectedCount || 1)));

    return {
      items: results,
      detectedCount,
      extractedCount,
      confidence,
    };
  }

  /**
   * Parse price with raw text (for legacy interface)
   */
  private parsePriceWithRaw(priceText: string | null): { price: number | null; currency: string; raw: string | null } {
    if (!priceText) {
      return { price: null, currency: 'USD', raw: null };
    }

    const cleaned = priceText.replace(/\s+/g, ' ').trim();

    let currency = 'USD';
    if (cleaned.includes('$')) currency = 'USD';
    else if (cleaned.includes('£')) currency = 'GBP';
    else if (cleaned.includes('€')) currency = 'EUR';
    else if (cleaned.toLowerCase().includes('usd')) currency = 'USD';

    const numericMatch = cleaned.match(/[\d,]+\.?\d*/);
    if (numericMatch) {
      const numericString = numericMatch[0].replace(/,/g, '');
      const price = Number.parseFloat(numericString);
      if (!Number.isNaN(price)) {
        return { price, currency, raw: cleaned };
      }
    }

    return { price: null, currency, raw: cleaned || null };
  }

  /**
   * Check if URL is a sold search page (for legacy interface)
   */
  isSoldSearch(url: string): boolean {
    try {
      const parsed = new URL(url);
      const isEbay =
        parsed.hostname.includes('ebay.com') ||
        parsed.hostname.includes('ebay.co.uk') ||
        parsed.hostname.includes('ebay.ca');

      if (!isEbay) {
        return false;
      }

      const params = parsed.searchParams;
      return params.get('LH_Sold') === '1' || parsed.pathname.includes('/sch/');
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const ebaySearchAdapter = new EbaySearchAdapter();
