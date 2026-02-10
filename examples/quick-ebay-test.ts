/**
 * Quick test to see if we can access eBay at all
 */

import { chromium } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const chromiumStealth = addExtra(chromium);
chromiumStealth.use(StealthPlugin());

async function test() {
  console.log('🧪 Quick eBay Access Test...\n');

  const browser = await chromiumStealth.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to eBay (waiting for "load" not "networkidle")...');
    await page.goto('https://www.ebay.com', {
      waitUntil: 'load',  // Less strict than networkidle
      timeout: 30000
    });
    console.log('✅ Page loaded!\n');

    // Get title
    const title = await page.title();
    console.log(`Page title: ${title}\n`);

    // Check if we see challenge/CAPTCHA
    const bodyText = await page.locator('body').textContent();
    if (bodyText?.toLowerCase().includes('challenge') ||
        bodyText?.toLowerCase().includes('verify') ||
        bodyText?.toLowerCase().includes('captcha')) {
      console.log('❌ CAPTCHA/Challenge detected in page text');
      console.log('   This machine/IP is being challenged by eBay');
      console.log('\n💡 Solutions:');
      console.log('   1. Use residential proxy');
      console.log('   2. Test from different network');
      console.log('   3. Wait and try again later');
    } else {
      console.log('✅ No obvious challenge detected');
      console.log('✅ eBay homepage accessible!\n');

      // Try sold listing
      console.log('Testing sold listing...');
      await page.goto('https://www.ebay.com/itm/256473841777', {
        waitUntil: 'load',
        timeout: 30000
      });

      const listingTitle = await page.title();
      console.log(`Listing title: ${listingTitle}\n`);

      const listingBody = await page.locator('body').textContent();
      if (listingBody?.toLowerCase().includes('challenge') ||
          listingBody?.toLowerCase().includes('verify')) {
        console.log('❌ CAPTCHA on listing page');
      } else {
        console.log('✅ Listing page accessible!');
        console.log('\n🎉 SUCCESS! eBay is accessible from this machine/IP');
        console.log('   The full backfill should work (at slow rate)');
      }
    }
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
    console.log('\n💡 This could mean:');
    console.log('   - Network connectivity issue');
    console.log('   - eBay is blocking this IP');
    console.log('   - Firewall blocking requests');
  } finally {
    await browser.close();
  }
}

test().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});
