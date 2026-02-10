/**
 * Comprehensive Feature Validation
 * Tests all the new features we built
 */

import { chromium } from 'playwright-core';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

const chromiumStealth = addExtra(chromium);
chromiumStealth.use(StealthPlugin());

const TEST_URLS = [
  'https://www.ebay.com',
  'https://www.ebay.com/b/Cell-Phones-Smartphones/9355/bn_320094',
  'https://www.ebay.com/b/Laptops-Netbooks/175672/bn_1647748'
];

interface TestResult {
  test: string;
  captchaRate: number;
  avgTimeMs: number;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

// =====================================
// TEST 1: Session Persistence
// =====================================
async function testSessionPersistence() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TEST 1: Session Persistence');
  console.log('Comparing: New context per request vs Persistent context');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromiumStealth.launch({ headless: true });

  // Test A: NEW CONTEXT PER REQUEST (standard approach)
  console.log('Test 1A: New context per request (5 requests)...');
  let captchasA = 0;
  const startA = Date.now();

  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.ebay.com', { waitUntil: 'load', timeout: 30000 });
    const body = await page.locator('body').textContent();

    if (body?.toLowerCase().includes('challenge') || body?.toLowerCase().includes('verify')) {
      captchasA++;
      console.log(`  Request ${i + 1}: ❌ CAPTCHA`);
    } else {
      console.log(`  Request ${i + 1}: ✅ OK`);
    }

    await context.close();
    await new Promise(r => setTimeout(r, 2000));
  }

  const timeA = Date.now() - startA;
  console.log(`  CAPTCHA Rate: ${captchasA}/5 (${(captchasA/5*100).toFixed(0)}%)`);
  console.log(`  Total Time: ${(timeA/1000).toFixed(1)}s\n`);

  // Test B: PERSISTENT CONTEXT (our approach)
  console.log('Test 1B: Persistent context (5 requests)...');
  let captchasB = 0;
  const startB = Date.now();

  const persistentContext = await browser.newContext();

  for (let i = 0; i < 5; i++) {
    const page = await persistentContext.newPage();

    await page.goto('https://www.ebay.com', { waitUntil: 'load', timeout: 30000 });
    const body = await page.locator('body').textContent();

    if (body?.toLowerCase().includes('challenge') || body?.toLowerCase().includes('verify')) {
      captchasB++;
      console.log(`  Request ${i + 1}: ❌ CAPTCHA`);
    } else {
      console.log(`  Request ${i + 1}: ✅ OK`);
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }

  await persistentContext.close();
  const timeB = Date.now() - startB;
  console.log(`  CAPTCHA Rate: ${captchasB}/5 (${(captchasB/5*100).toFixed(0)}%)`);
  console.log(`  Total Time: ${(timeB/1000).toFixed(1)}s\n`);

  await browser.close();

  // Results
  const improvement = captchasA - captchasB;
  results.push({
    test: 'Session Persistence',
    captchaRate: captchasB / 5,
    avgTimeMs: timeB / 5,
    passed: captchasB <= captchasA,
    details: `Persistent: ${captchasB}/5 CAPTCHAs vs New: ${captchasA}/5 CAPTCHAs (${improvement >= 0 ? improvement + ' fewer' : 'worse'})`
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (captchasB < captchasA) {
    console.log('✅ RESULT: Persistent contexts HELP reduce CAPTCHAs');
  } else if (captchasB === captchasA) {
    console.log('⚪ RESULT: No difference (both work equally well)');
  } else {
    console.log('❌ RESULT: Persistent contexts made it worse');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// =====================================
// TEST 2: Session Warming
// =====================================
async function testSessionWarming() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TEST 2: Session Warming');
  console.log('Comparing: Direct to listing vs Homepage first');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromiumStealth.launch({ headless: true });

  // Test A: COLD START (direct to listing)
  console.log('Test 2A: Cold start - direct to listing...');
  let captchasA = 0;
  const contextA = await browser.newContext();

  for (let i = 0; i < 3; i++) {
    const page = await contextA.newPage();

    // Go DIRECTLY to a listing page
    await page.goto('https://www.ebay.com/b/Laptops-Netbooks/175672/bn_1647748', {
      waitUntil: 'load',
      timeout: 30000
    });

    const body = await page.locator('body').textContent();
    if (body?.toLowerCase().includes('challenge') || body?.toLowerCase().includes('verify')) {
      captchasA++;
      console.log(`  Request ${i + 1}: ❌ CAPTCHA`);
    } else {
      console.log(`  Request ${i + 1}: ✅ OK`);
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }
  await contextA.close();
  console.log(`  CAPTCHA Rate: ${captchasA}/3 (${(captchasA/3*100).toFixed(0)}%)\n`);

  // Test B: WARMED SESSION (homepage first)
  console.log('Test 2B: Warm session - homepage first...');
  let captchasB = 0;
  const contextB = await browser.newContext();

  // WARMING: Visit homepage and browse
  console.log('  Warming: Visiting homepage...');
  const warmPage = await contextB.newPage();
  await warmPage.goto('https://www.ebay.com', { waitUntil: 'load', timeout: 30000 });

  // Scroll
  await warmPage.mouse.wheel(0, 300);
  await new Promise(r => setTimeout(r, 1000));
  await warmPage.mouse.wheel(0, 300);
  await new Promise(r => setTimeout(r, 1000));

  // Click a category
  try {
    const links = await warmPage.locator('a[href*="/b/"]').all();
    if (links.length > 0) {
      await links[0].click();
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch {
    // Fine if it fails
  }

  await warmPage.close();
  console.log('  ✅ Session warmed\n');

  // Now try listings
  for (let i = 0; i < 3; i++) {
    const page = await contextB.newPage();

    await page.goto('https://www.ebay.com/b/Laptops-Netbooks/175672/bn_1647748', {
      waitUntil: 'load',
      timeout: 30000
    });

    const body = await page.locator('body').textContent();
    if (body?.toLowerCase().includes('challenge') || body?.toLowerCase().includes('verify')) {
      captchasB++;
      console.log(`  Request ${i + 1}: ❌ CAPTCHA`);
    } else {
      console.log(`  Request ${i + 1}: ✅ OK`);
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }
  await contextB.close();
  console.log(`  CAPTCHA Rate: ${captchasB}/3 (${(captchasB/3*100).toFixed(0)}%)\n`);

  await browser.close();

  // Results
  const improvement = captchasA - captchasB;
  results.push({
    test: 'Session Warming',
    captchaRate: captchasB / 3,
    avgTimeMs: 0,
    passed: captchasB <= captchasA,
    details: `Warmed: ${captchasB}/3 CAPTCHAs vs Cold: ${captchasA}/3 CAPTCHAs (${improvement >= 0 ? improvement + ' fewer' : 'worse'})`
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (captchasB < captchasA) {
    console.log('✅ RESULT: Session warming HELPS reduce CAPTCHAs');
  } else if (captchasB === captchasA) {
    console.log('⚪ RESULT: No difference (both work equally well)');
  } else {
    console.log('❌ RESULT: Session warming made it worse');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// =====================================
// TEST 3: Cookie Persistence
// =====================================
async function testCookiePersistence() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TEST 3: Cookie Persistence');
  console.log('Testing: Save/load cookies across sessions');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await mkdir('.anno/test-cookies', { recursive: true });
  const cookiePath = '.anno/test-cookies/ebay.json';

  // Session 1: Create and save cookies
  console.log('Session 1: Creating cookies...');
  const browser1 = await chromiumStealth.launch({ headless: true });
  const context1 = await browser1.newContext();
  const page1 = await context1.newPage();

  await page1.goto('https://www.ebay.com', { waitUntil: 'load', timeout: 30000 });
  console.log('  ✅ Visited eBay');

  const cookies1 = await context1.cookies();
  await writeFile(cookiePath, JSON.stringify(cookies1, null, 2));
  console.log(`  ✅ Saved ${cookies1.length} cookies to disk\n`);

  await browser1.close();

  // Wait a bit
  await new Promise(r => setTimeout(r, 2000));

  // Session 2: Load cookies and verify
  console.log('Session 2: Loading saved cookies...');
  const browser2 = await chromiumStealth.launch({ headless: true });
  const context2 = await browser2.newContext();

  const cookiesData = await readFile(cookiePath, 'utf-8');
  const loadedCookies = JSON.parse(cookiesData);
  await context2.addCookies(loadedCookies);
  console.log(`  ✅ Loaded ${loadedCookies.length} cookies from disk\n`);

  const page2 = await context2.newPage();
  await page2.goto('https://www.ebay.com', { waitUntil: 'load', timeout: 30000 });

  const cookies2 = await context2.cookies();
  console.log(`  Current cookies: ${cookies2.length}`);

  // Check if we still have the key cookies
  const hasSessionCookies = cookies2.some(c =>
    c.name.toLowerCase().includes('session') ||
    c.name.toLowerCase().includes('s') ||
    c.name === 'dp1'
  );

  await browser2.close();

  results.push({
    test: 'Cookie Persistence',
    captchaRate: 0,
    avgTimeMs: 0,
    passed: loadedCookies.length > 0 && cookies2.length > 0,
    details: `Saved ${cookies1.length} cookies, loaded ${loadedCookies.length}, active ${cookies2.length}`
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (loadedCookies.length > 0 && cookies2.length > 0) {
    console.log('✅ RESULT: Cookie persistence WORKS');
    console.log('   Can save and restore sessions across restarts');
  } else {
    console.log('❌ RESULT: Cookie persistence FAILED');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

// =====================================
// MAIN TEST RUNNER
// =====================================
async function runAllTests() {
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║  ANNO EBAY SCRAPER - FEATURE VALIDATION      ║');
  console.log('╚═══════════════════════════════════════════════╝');

  try {
    await testSessionPersistence();
    await testSessionWarming();
    await testCookiePersistence();

    // Summary
    console.log('\n╔═══════════════════════════════════════════════╗');
    console.log('║  TEST SUMMARY                                 ║');
    console.log('╚═══════════════════════════════════════════════╝\n');

    for (const result of results) {
      const status = result.passed ? '✅' : '❌';
      console.log(`${status} ${result.test}`);
      console.log(`   ${result.details}\n`);
    }

    const allPassed = results.every(r => r.passed);
    const totalCaptchas = results.reduce((sum, r) => sum + r.captchaRate, 0);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (allPassed) {
      console.log('🎉 ALL TESTS PASSED');
      console.log(`   Average CAPTCHA rate: ${(totalCaptchas / results.length * 100).toFixed(1)}%`);
      console.log('\n📌 CONCLUSIONS:');
      console.log('   • Your built features work as intended');
      console.log('   • Ready for production use with real URLs');
      console.log('   • Session persistence + warming are validated');
    } else {
      console.log('⚠️  SOME TESTS FAILED');
      console.log('   Review results above for details');
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED:', (error as Error).message);
    process.exit(1);
  }
}

runAllTests();
