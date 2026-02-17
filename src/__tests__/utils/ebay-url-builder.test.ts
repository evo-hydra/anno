import { describe, it, expect } from 'vitest';
import {
  EbayUrlBuilder,
  ebayUrlBuilder,
  buildEbaySoldUrl,
  isSoldListingsUrl
} from '../../utils/ebay-url-builder';

describe('EbayUrlBuilder', () => {
  describe('buildSoldSearchUrl', () => {
    it('builds basic sold listings URL with query only', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'vintage camera'
      });

      expect(url).toContain('ebay.com/sch/i.html');
      expect(url).toContain('_nkw=vintage+camera');
    });

    it('includes soldListings parameter when true', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        soldListings: true
      });

      expect(url).toContain('LH_Sold=1');
    });

    it('excludes soldListings parameter when false', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        soldListings: false
      });

      expect(url).not.toContain('LH_Sold');
    });

    it('includes completedListings parameter when true', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        completedListings: true
      });

      expect(url).toContain('LH_Complete=1');
    });

    it('excludes completedListings parameter when false', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        completedListings: false
      });

      expect(url).not.toContain('LH_Complete');
    });

    it('includes condition=new', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        condition: 'new'
      });

      expect(url).toContain('LH_ItemCondition=1000');
    });

    it('includes condition=used', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        condition: 'used'
      });

      expect(url).toContain('LH_ItemCondition=3000');
    });

    it('includes condition=refurbished', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        condition: 'refurbished'
      });

      expect(url).toContain('LH_ItemCondition=2000');
    });

    it('includes condition=parts', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        condition: 'parts'
      });

      expect(url).toContain('LH_ItemCondition=7000');
    });

    it('includes minPrice parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        minPrice: 50
      });

      expect(url).toContain('_udlo=50');
    });

    it('includes maxPrice parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        maxPrice: 500
      });

      expect(url).toContain('_udhi=500');
    });

    it('includes both minPrice and maxPrice', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        minPrice: 50,
        maxPrice: 500
      });

      expect(url).toContain('_udlo=50');
      expect(url).toContain('_udhi=500');
    });

    it('includes freeShipping when true', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        freeShipping: true
      });

      expect(url).toContain('LH_FS=1');
    });

    it('excludes freeShipping when false', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        freeShipping: false
      });

      expect(url).not.toContain('LH_FS');
    });

    it('includes localPickup when true', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        localPickup: true
      });

      expect(url).toContain('LH_PrefLoc=1');
    });

    it('excludes localPickup when false', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        localPickup: false
      });

      expect(url).not.toContain('LH_PrefLoc');
    });

    it('includes itemLocation=us', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        itemLocation: 'us'
      });

      expect(url).toContain('LH_PrefLoc=1');
    });

    it('includes itemLocation=uk', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        itemLocation: 'uk'
      });

      expect(url).toContain('LH_PrefLoc=3');
    });

    it('includes itemLocation=worldwide', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        itemLocation: 'worldwide'
      });

      expect(url).toContain('LH_PrefLoc=0');
    });

    it('includes sortBy=price_asc', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        sortBy: 'price_asc'
      });

      expect(url).toContain('_sop=15');
    });

    it('includes sortBy=price_desc', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        sortBy: 'price_desc'
      });

      expect(url).toContain('_sop=16');
    });

    it('includes sortBy=date_recent', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        sortBy: 'date_recent'
      });

      expect(url).toContain('_sop=10');
    });

    it('includes sortBy=date_oldest', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        sortBy: 'date_oldest'
      });

      expect(url).toContain('_sop=1');
    });

    it('includes sortBy=best_match', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        sortBy: 'best_match'
      });

      expect(url).toContain('_sop=12');
    });

    it('includes page parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        page: 3
      });

      expect(url).toContain('_pgn=3');
    });

    it('includes itemsPerPage parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        itemsPerPage: 100
      });

      expect(url).toContain('_ipg=100');
    });

    it('includes categoryId parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        categoryId: '625'
      });

      expect(url).toContain('_sacat=625');
    });

    it('builds complex URL with all options', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'vintage camera',
        soldListings: true,
        completedListings: true,
        condition: 'used',
        minPrice: 100,
        maxPrice: 1000,
        freeShipping: true,
        localPickup: true,
        itemLocation: 'us',
        sortBy: 'price_asc',
        page: 2,
        itemsPerPage: 50,
        categoryId: '625'
      });

      expect(url).toContain('_nkw=vintage+camera');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('LH_Complete=1');
      expect(url).toContain('LH_ItemCondition=3000');
      expect(url).toContain('_udlo=100');
      expect(url).toContain('_udhi=1000');
      expect(url).toContain('LH_FS=1');
      expect(url).toContain('LH_PrefLoc=1');
      expect(url).toContain('_sop=15');
      expect(url).toContain('_pgn=2');
      expect(url).toContain('_ipg=50');
      expect(url).toContain('_sacat=625');
    });

    it('URL encodes query with special characters', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'item & stuff'
      });

      expect(url).toContain('_nkw=item+%26+stuff');
    });

    it('handles empty query string', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: ''
      });

      expect(url).toContain('ebay.com/sch/i.html');
      expect(url).toContain('_nkw=');
    });
  });

  describe('parseEbayUrl', () => {
    it('parses basic sold listings URL', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=camera&LH_Sold=1';
      const options = builder.parseEbayUrl(url);

      expect(options.query).toBe('camera');
      expect(options.soldListings).toBe(true);
    });

    it('parses completedListings parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&LH_Complete=1';
      const options = builder.parseEbayUrl(url);

      expect(options.completedListings).toBe(true);
    });

    it('parses minPrice parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&_udlo=50';
      const options = builder.parseEbayUrl(url);

      expect(options.minPrice).toBe(50);
    });

    it('parses maxPrice parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&_udhi=500';
      const options = builder.parseEbayUrl(url);

      expect(options.maxPrice).toBe(500);
    });

    it('parses freeShipping parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&LH_FS=1';
      const options = builder.parseEbayUrl(url);

      expect(options.freeShipping).toBe(true);
    });

    it('parses localPickup when LH_PrefLoc=1', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&LH_PrefLoc=1';
      const options = builder.parseEbayUrl(url);

      expect(options.localPickup).toBe(true);
    });

    it('parses page parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=test&_pgn=5';
      const options = builder.parseEbayUrl(url);

      expect(options.page).toBe(5);
    });

    it('parses URL with multiple parameters', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=vintage+camera&LH_Sold=1&LH_Complete=1&_udlo=100&_udhi=1000&LH_FS=1&_pgn=2';
      const options = builder.parseEbayUrl(url);

      expect(options.query).toBe('vintage camera');
      expect(options.soldListings).toBe(true);
      expect(options.completedListings).toBe(true);
      expect(options.minPrice).toBe(100);
      expect(options.maxPrice).toBe(1000);
      expect(options.freeShipping).toBe(true);
      expect(options.page).toBe(2);
    });

    it('returns empty object for invalid URL', () => {
      const builder = new EbayUrlBuilder();
      const options = builder.parseEbayUrl('not-a-valid-url');

      expect(options).toEqual({});
    });

    it('returns soldListings=false when not present', () => {
      const builder = new EbayUrlBuilder();
      const options = builder.parseEbayUrl('https://www.ebay.com/sch/i.html?_nkw=test');

      expect(options.soldListings).toBe(false);
    });

    it('returns empty object with no query string', () => {
      const builder = new EbayUrlBuilder();
      const options = builder.parseEbayUrl('https://www.ebay.com/sch/i.html');

      expect(options.soldListings).toBe(false);
      expect(options.completedListings).toBe(false);
      expect(options.freeShipping).toBe(false);
      expect(options.localPickup).toBe(false);
    });

    it('decodes URL-encoded query parameter', () => {
      const builder = new EbayUrlBuilder();
      const url = 'https://www.ebay.com/sch/i.html?_nkw=item+%26+stuff';
      const options = builder.parseEbayUrl(url);

      expect(options.query).toBe('item & stuff');
    });
  });

  describe('isSoldListingsUrl', () => {
    it('returns true for sold listings URL with LH_Sold=1', () => {
      const builder = new EbayUrlBuilder();
      const result = builder.isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');

      expect(result).toBe(true);
    });

    it('returns false for URL without LH_Sold', () => {
      const builder = new EbayUrlBuilder();
      const result = builder.isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test');

      expect(result).toBe(false);
    });

    it('returns false for invalid URL', () => {
      const builder = new EbayUrlBuilder();
      const result = builder.isSoldListingsUrl('not-a-valid-url');

      expect(result).toBe(false);
    });

    it('returns false for non-eBay URL', () => {
      const builder = new EbayUrlBuilder();
      const result = builder.isSoldListingsUrl('https://www.amazon.com/something');

      expect(result).toBe(false);
    });

    it('returns false for completed but not sold listings', () => {
      const builder = new EbayUrlBuilder();
      const result = builder.isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test&LH_Complete=1');

      expect(result).toBe(false);
    });
  });

  describe('Templates', () => {
    it('recentSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.recentSold('test query');

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('_sop=10');
    });

    it('cheapestSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.cheapestSold('test query');

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('_sop=15');
    });

    it('highestSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.highestSold('test query');

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('_sop=16');
    });

    it('priceRangeSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.priceRangeSold('test query', 50, 500);

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('_udlo=50');
      expect(url).toContain('_udhi=500');
    });

    it('usedSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.usedSold('test query');

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('LH_ItemCondition=3000');
      expect(url).toContain('_sop=10');
    });

    it('freeShippingSold template returns URL string', () => {
      const url = EbayUrlBuilder.Templates.freeShippingSold('test query');

      expect(typeof url).toBe('string');
      expect(url).toContain('_nkw=test+query');
      expect(url).toContain('LH_Sold=1');
      expect(url).toContain('LH_FS=1');
    });
  });

  describe('Helper functions', () => {
    describe('buildEbaySoldUrl', () => {
      it('builds URL with query only', () => {
        const url = buildEbaySoldUrl('test query');

        expect(url).toContain('_nkw=test+query');
        expect(url).toContain('LH_Sold=1');
      });

      it('builds URL with query and options', () => {
        const url = buildEbaySoldUrl('test query', {
          minPrice: 50,
          maxPrice: 500,
          condition: 'used'
        });

        expect(url).toContain('_nkw=test+query');
        expect(url).toContain('_udlo=50');
        expect(url).toContain('_udhi=500');
        expect(url).toContain('LH_ItemCondition=3000');
        expect(url).toContain('LH_Sold=1');
      });

      it('builds URL without options parameter', () => {
        const url = buildEbaySoldUrl('simple query');

        expect(url).toContain('_nkw=simple+query');
        expect(url).toContain('ebay.com/sch/i.html');
        expect(url).toContain('LH_Sold=1');
      });
    });

    describe('isSoldListingsUrl (helper)', () => {
      it('returns true for sold listings URL', () => {
        const result = isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');

        expect(result).toBe(true);
      });

      it('returns false for non-sold URL', () => {
        const result = isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test');

        expect(result).toBe(false);
      });

      it('returns false for invalid URL', () => {
        const result = isSoldListingsUrl('invalid');

        expect(result).toBe(false);
      });
    });
  });

  describe('Singleton instance', () => {
    it('exports singleton ebayUrlBuilder instance', () => {
      expect(ebayUrlBuilder).toBeInstanceOf(EbayUrlBuilder);
    });

    it('singleton instance can build URLs', () => {
      const url = ebayUrlBuilder.buildSoldSearchUrl({
        query: 'test',
        soldListings: true
      });

      expect(url).toContain('_nkw=test');
      expect(url).toContain('LH_Sold=1');
    });

    it('singleton instance can parse URLs', () => {
      const options = ebayUrlBuilder.parseEbayUrl('https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');

      expect(options.query).toBe('test');
      expect(options.soldListings).toBe(true);
    });

    it('singleton instance can check if URL is sold listings', () => {
      const result = ebayUrlBuilder.isSoldListingsUrl('https://www.ebay.com/sch/i.html?_nkw=test&LH_Sold=1');

      expect(result).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('handles query with only spaces', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: '   '
      });

      expect(url).toContain('_nkw=+++');
    });

    it('handles very long query string', () => {
      const builder = new EbayUrlBuilder();
      const longQuery = 'a'.repeat(500);
      const url = builder.buildSoldSearchUrl({
        query: longQuery
      });

      expect(url).toContain('_nkw=' + 'a'.repeat(500));
    });

    it('handles zero as minPrice', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        minPrice: 0
      });

      expect(url).toContain('_udlo=0');
    });

    it('handles zero as maxPrice', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        maxPrice: 0
      });

      expect(url).toContain('_udhi=0');
    });

    it('does not include page when page=0', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        page: 0
      });

      expect(url).not.toContain('_pgn');
    });

    it('does not include page when page=1', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        page: 1
      });

      expect(url).not.toContain('_pgn');
    });

    it('does not include itemsPerPage when itemsPerPage=0', () => {
      const builder = new EbayUrlBuilder();
      const url = builder.buildSoldSearchUrl({
        query: 'test',
        itemsPerPage: 0
      });

      expect(url).not.toContain('_ipg');
    });
  });
});
