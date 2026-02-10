/**
 * eBay URL Builder
 *
 * Utility for constructing eBay search URLs with sold listings filters.
 * Critical for FlipIQ price research and market analysis.
 *
 * @module utils/ebay-url-builder
 */

export interface EbaySoldSearchOptions {
  /** Search query (e.g., "Nintendo Switch OLED") */
  query: string;

  /** Only include sold items */
  soldListings?: boolean;

  /** Include completed listings (sold + unsold) */
  completedListings?: boolean;

  /** Condition filters */
  condition?: 'new' | 'used' | 'refurbished' | 'parts';

  /** Price range */
  minPrice?: number;
  maxPrice?: number;

  /** Shipping options */
  freeShipping?: boolean;
  localPickup?: boolean;

  /** Location filters */
  itemLocation?: 'us' | 'uk' | 'worldwide';

  /** Sorting */
  sortBy?: 'price_asc' | 'price_desc' | 'date_recent' | 'date_oldest' | 'best_match';

  /** Pagination */
  page?: number;
  itemsPerPage?: number;

  /** Category ID (optional) */
  categoryId?: string;
}

export class EbayUrlBuilder {
  private readonly BASE_URL = 'https://www.ebay.com/sch/i.html';

  /**
   * Build eBay sold listings search URL
   *
   * @example
   * const builder = new EbayUrlBuilder();
   * const url = builder.buildSoldSearchUrl({
   *   query: 'Nintendo Switch OLED',
   *   soldListings: true,
   *   minPrice: 200,
   *   maxPrice: 400,
   *   condition: 'used'
   * });
   * // https://www.ebay.com/sch/i.html?_nkw=Nintendo+Switch+OLED&LH_Sold=1&_udlo=200&_udhi=400&LH_ItemCondition=3000
   */
  buildSoldSearchUrl(options: EbaySoldSearchOptions): string {
    const params = new URLSearchParams();

    // Search query (required)
    params.set('_nkw', options.query);

    // Sold listings filter (THE CRITICAL PARAMETER)
    if (options.soldListings) {
      params.set('LH_Sold', '1');
    }

    // Completed listings (includes both sold and unsold)
    if (options.completedListings) {
      params.set('LH_Complete', '1');
    }

    // Condition filters
    if (options.condition) {
      const conditionMap = {
        new: '1000',      // New
        used: '3000',     // Used
        refurbished: '2000|2010|2020|2030', // Refurbished (all types)
        parts: '7000'     // For parts or not working
      };
      params.set('LH_ItemCondition', conditionMap[options.condition]);
    }

    // Price range
    if (options.minPrice !== undefined) {
      params.set('_udlo', options.minPrice.toString());
    }
    if (options.maxPrice !== undefined) {
      params.set('_udhi', options.maxPrice.toString());
    }

    // Shipping options
    if (options.freeShipping) {
      params.set('LH_FS', '1');
    }
    if (options.localPickup) {
      params.set('LH_PrefLoc', '1');
    }

    // Location filters
    if (options.itemLocation) {
      const locationMap = {
        us: '1',        // Items located in US
        uk: '3',        // Items located in UK
        worldwide: '0'  // Worldwide
      };
      params.set('LH_PrefLoc', locationMap[options.itemLocation]);
    }

    // Sorting
    if (options.sortBy) {
      const sortMap = {
        price_asc: '15',      // Price + Shipping: lowest first
        price_desc: '16',     // Price + Shipping: highest first
        date_recent: '10',    // Time: newly listed
        date_oldest: '1',     // Time: ending soonest
        best_match: '12'      // Best Match (default)
      };
      params.set('_sop', sortMap[options.sortBy]);
    }

    // Pagination
    if (options.page && options.page > 1) {
      params.set('_pgn', options.page.toString());
    }
    if (options.itemsPerPage) {
      params.set('_ipg', options.itemsPerPage.toString());
    }

    // Category
    if (options.categoryId) {
      params.set('_sacat', options.categoryId);
    }

    // Construct final URL
    return `${this.BASE_URL}?${params.toString()}`;
  }

  /**
   * Extract search options from an existing eBay URL
   * Useful for understanding what filters are applied
   */
  parseEbayUrl(url: string): Partial<EbaySoldSearchOptions> {
    try {
      const parsed = new URL(url);
      const params = parsed.searchParams;

      const options: Partial<EbaySoldSearchOptions> = {};

      // Extract query
      const query = params.get('_nkw');
      if (query) options.query = query;

      // Check for sold listings
      options.soldListings = params.get('LH_Sold') === '1';
      options.completedListings = params.get('LH_Complete') === '1';

      // Price range
      const minPrice = params.get('_udlo');
      const maxPrice = params.get('_udhi');
      if (minPrice) options.minPrice = parseFloat(minPrice);
      if (maxPrice) options.maxPrice = parseFloat(maxPrice);

      // Shipping
      options.freeShipping = params.get('LH_FS') === '1';
      options.localPickup = params.get('LH_PrefLoc') === '1';

      // Page
      const page = params.get('_pgn');
      if (page) options.page = parseInt(page, 10);

      return options;
    } catch {
      return {};
    }
  }

  /**
   * Check if a URL is an eBay sold listings search
   */
  isSoldListingsUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('ebay.com') &&
             parsed.searchParams.get('LH_Sold') === '1';
    } catch {
      return false;
    }
  }

  /**
   * Common eBay search templates for FlipIQ
   */
  static readonly Templates = {
    /**
     * Find recently sold items for a product
     */
    recentSold: (productName: string) => new EbayUrlBuilder().buildSoldSearchUrl({
      query: productName,
      soldListings: true,
      sortBy: 'date_recent'
    }),

    /**
     * Find cheapest sold items for a product
     */
    cheapestSold: (productName: string) => new EbayUrlBuilder().buildSoldSearchUrl({
      query: productName,
      soldListings: true,
      sortBy: 'price_asc'
    }),

    /**
     * Find highest priced sold items
     */
    highestSold: (productName: string) => new EbayUrlBuilder().buildSoldSearchUrl({
      query: productName,
      soldListings: true,
      sortBy: 'price_desc'
    }),

    /**
     * Find sold items in specific price range
     */
    priceRangeSold: (productName: string, min: number, max: number) =>
      new EbayUrlBuilder().buildSoldSearchUrl({
        query: productName,
        soldListings: true,
        minPrice: min,
        maxPrice: max
      }),

    /**
     * Find recently sold used items (for resale research)
     */
    usedSold: (productName: string) => new EbayUrlBuilder().buildSoldSearchUrl({
      query: productName,
      soldListings: true,
      condition: 'used',
      sortBy: 'date_recent'
    }),

    /**
     * Find sold items with free shipping
     */
    freeShippingSold: (productName: string) => new EbayUrlBuilder().buildSoldSearchUrl({
      query: productName,
      soldListings: true,
      freeShipping: true
    })
  };
}

// Export singleton instance
export const ebayUrlBuilder = new EbayUrlBuilder();

/**
 * Quick helper functions for common use cases
 */
export const buildEbaySoldUrl = (query: string, options?: Partial<EbaySoldSearchOptions>) => {
  return ebayUrlBuilder.buildSoldSearchUrl({
    query,
    soldListings: true,
    ...options
  });
};

export const isSoldListingsUrl = (url: string) => {
  return ebayUrlBuilder.isSoldListingsUrl(url);
};
