/**
 * Standalone test for persistent sessions
 * Does NOT require Anno server to be running
 */

import { chromium } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdir } from 'fs/promises';

const chromiumStealth = addExtra(chromium);
chromiumStealth.use(StealthPlugin());

async function test() {
  console.log('🧪 Testing eBay Session with Stealth Mode...\n');

  // Create directory
  await mkdir('.anno/test', { recursive: true });

  console.log('1️⃣ Launching browser with stealth...');
  const browser = await chromiumStealth.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  console.log('✅ Browser launched\n');

  console.log('2️⃣ Creating browser context...');
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  console.log('✅ Context created\n');

  console.log('3️⃣ Warming session - visiting eBay homepage...');
  const page = await context.newPage();

  try {
    await page.goto('https://www.ebay.com', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    console.log('✅ Homepage loaded\n');

    // Check for CAPTCHA
    console.log('4️⃣ Checking for CAPTCHA...');
    const captchaSelectors = [
      '#px-captcha',
      '.g-recaptcha',
      'iframe[src*="recaptcha"]',
      '.challenge-form'
    ];

    let captchaDetected = false;
    for (const selector of captchaSelectors) {
      try {
        const visible = await page.locator(selector).isVisible({ timeout: 1000 });
        if (visible) {
          console.log(`❌ CAPTCHA detected: ${selector}`);
          captchaDetected = true;
          break;
        }
      } catch {
        // Not found, continue
      }
    }

    if (!captchaDetected) {
      console.log('✅ No CAPTCHA on homepage\n');

      // Now try a sold listing
      console.log('5️⃣ Testing sold listing extraction...');
      const testUrl = 'https://www.ebay.com/itm/256473841777';
      console.log(`   URL: ${testUrl}\n`);

      await page.goto(testUrl, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      // Check for CAPTCHA again
      let listingCaptcha = false;
      for (const selector of captchaSelectors) {
        try {
          const visible = await page.locator(selector).isVisible({ timeout: 1000 });
          if (visible) {
            console.log(`❌ CAPTCHA detected on listing: ${selector}`);
            listingCaptcha = true;
            break;
          }
        } catch {
          // Not found
        }
      }

      if (!listingCaptcha) {
        console.log('✅ No CAPTCHA on listing page\n');

        // Try to extract basic info
        console.log('6️⃣ Extracting data...');
        const title = await page.locator('h1.x-item-title__mainTitle, .x-item-title, h1').first().textContent().catch(() => 'Not found');
        const priceText = await page.locator('.x-price-primary, [itemprop="price"]').first().textContent().catch(() => 'Not found');

        console.log(`   Title: ${title?.trim()}`);
        console.log(`   Price: ${priceText?.trim()}\n`);

        if (title && title !== 'Not found') {
          console.log('✅ SUCCESS! Basic extraction working!');
          console.log('\n📌 Next steps:');
          console.log('   1. Integrate with eBay adapter for full extraction');
          console.log('   2. Add cookie persistence');
          console.log('   3. Test with multiple URLs');
        } else {
          console.log('⚠️  Could not extract data - page might have different structure');
        }
      }
    } else {
      console.log('\n⚠️  CAPTCHA detected. Recommendations:');
      console.log('   - Add residential proxies');
      console.log('   - Increase delays between requests');
      console.log('   - Visit more pages during warming');
    }
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    console.log('\n✅ Cleanup complete');
  }
}

test().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
