import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ebaySearchAdapter } from '../services/extractors/ebay-search-adapter';
import { ebayAdapter } from '../services/extractors/ebay-adapter';
import { distillContent } from '../services/distiller';

const fixturesDir = join(process.cwd(), 'tests/fixtures');

const loadFixture = (filename: string): string => {
  return readFileSync(join(fixturesDir, filename), 'utf-8');
};

/**
 * Minimal eBay item page HTML with the selectors the adapter expects.
 */
const EBAY_ITEM_HTML = `<!DOCTYPE html>
<html>
<head><title>Test eBay Item</title></head>
<body>
  <h1 class="x-item-title__mainTitle">
    <span class="ux-textspans">Nintendo Switch OLED Console - White</span>
  </h1>
  <div class="x-price-primary">
    <span class="ux-textspans">US $299.99</span>
  </div>
  <div class="vi-bboxrev-postiontop">Sold on Nov 3, 2024</div>
  <div data-testid="x-item-condition-value">
    <span class="ux-textspans">Used</span>
  </div>
  <div data-testid="ux-item-number">
    <span class="ux-textspans">256473841777</span>
  </div>
  <div class="ux-labels-values--shipping">
    <span>US $10.00</span>
  </div>
  <div class="x-sellercard-atf__info__about-seller">
    <a href="/usr/testSeller">testSeller</a>
  </div>
  <div class="x-sellercard-atf__data--rating">99.5% positive</div>
  <div class="ux-image-carousel-item">
    <img src="https://i.ebayimg.com/images/test.jpg" />
  </div>
</body>
</html>`;

describe('ebaySearchAdapter', () => {
  it('detects sold-search URLs', () => {
    expect(
      ebaySearchAdapter.isSoldSearch(
        'https://www.ebay.com/sch/i.html?_nkw=nintendo+switch+oled&LH_Sold=1&LH_Complete=1'
      )
    ).toBe(true);

    expect(
      ebaySearchAdapter.isSoldSearch('https://www.ebay.com/itm/256473841777')
    ).toBe(false);
  });

  it('extractLegacy returns structured items', () => {
    const html = loadFixture('ebay-search-results.html');
    const result = ebaySearchAdapter.extractLegacy(
      html,
      'https://www.ebay.com/sch/i.html?_nkw=nintendo+switch+oled&LH_Sold=1'
    );

    expect(result.detectedCount).toBe(3);
    expect(result.extractedCount).toBe(3);
    expect(result.confidence > 0.5).toBe(true);

    const [first] = result.items;
    expect(first.title).toBe('Nintendo Switch OLED Console');
    expect(first.price).toBe(299.99);
    expect(first.currency).toBe('USD');
    expect(first.soldDate).toBe('Nov 3, 2024');
    expect(first.condition).toBe('Used');
    expect(first.shippingText).toBe('+$10.00 shipping');
    expect(first.url).toBe('https://www.ebay.com/itm/1234567890');
  });
});

describe('distillContent with eBay adapters', () => {
  it('uses ebay-search-adapter for sold listings search', async () => {
    const html = loadFixture('ebay-search-results.html');

    const result = await distillContent(
      html,
      'https://www.ebay.com/sch/i.html?_nkw=nintendo+switch+oled&LH_Sold=1'
    );

    expect(result.extractionMethod).toBe('ebay-search-adapter');
    expect(result.ebaySearchData).toBeTruthy();
    expect(result.ebaySearchData?.items.length).toBe(3);
    expect(result.fallbackUsed).toBe(false);
  });

  it('uses ebay-adapter for item pages', async () => {
    const result = await distillContent(EBAY_ITEM_HTML, 'https://www.ebay.com/itm/256473841777');

    expect(result.extractionMethod).toBe('ebay-adapter');
    expect(result.ebayData).toBeTruthy();
    expect(result.fallbackUsed).toBe(false);
  });
});

describe('ebayAdapter', () => {
  it('extractLegacy captures listing data', () => {
    const result = ebayAdapter.extractLegacy(EBAY_ITEM_HTML, 'https://www.ebay.com/itm/256473841777');

    expect(result.title.length > 0).toBe(true);
    expect(result.currency).toBe('USD');
    expect(result.soldPrice !== null).toBe(true);
    expect(result.itemNumber).toBe('256473841777');
    expect(result.seller.name !== null).toBe(true);
  });
});
