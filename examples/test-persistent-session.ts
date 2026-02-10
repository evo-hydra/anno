/**
 * Quick test script to verify persistent session manager works
 */

import { PersistentSessionManager } from '../src/services/persistent-session-manager';
import { ebayAdapter } from '../src/services/extractors/ebay-adapter';
import { logger } from '../src/utils/logger';
import { mkdir } from 'fs/promises';
import { rendererManager } from '../src/services/renderer';

async function test() {
  console.log('🧪 Testing Persistent Session Manager...\n');

  // Create necessary directories
  await mkdir('.anno/sessions', { recursive: true });

  // Initialize renderer
  console.log('1️⃣ Initializing renderer...');
  await rendererManager.init();
  console.log('✅ Renderer initialized\n');

  // Create session manager
  console.log('2️⃣ Creating session manager...');
  const sessionManager = new PersistentSessionManager({
    warmingPages: 2, // Reduce for testing
    cookieStorePath: '.anno/sessions'
  });
  console.log('✅ Session manager created\n');

  // Get session (will warm it up)
  console.log('3️⃣ Getting session for ebay.com (this will warm it up)...');
  console.log('   This takes ~30-60 seconds...');
  const context = await sessionManager.getSession('ebay.com');
  console.log('✅ Session ready!\n');

  // Test with a real eBay URL
  console.log('4️⃣ Testing with eBay listing...');
  const testUrl = 'https://www.ebay.com/itm/256473841777';
  console.log(`   URL: ${testUrl}`);

  const page = await context.newPage();

  try {
    // Navigate
    await page.goto(testUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Check for CAPTCHA
    const captcha = await sessionManager.detectCaptcha(page);
    if (captcha.detected) {
      console.log(`❌ CAPTCHA detected: ${captcha.type}`);
      console.log('   This means we need to:');
      console.log('   - Add residential proxies');
      console.log('   - Slow down rate limiting');
      console.log('   - Or increase session warming');
    } else {
      console.log('✅ No CAPTCHA detected!');

      // Try to extract data
      const html = await page.content();
      const listing = ebayAdapter.extract(html, testUrl);

      console.log('\n📦 Extracted Data:');
      console.log(`   Title: ${listing.title}`);
      console.log(`   Price: ${listing.soldPrice ? `$${listing.soldPrice}` : 'N/A'}`);
      console.log(`   Date: ${listing.soldDate || 'N/A'}`);
      console.log(`   Condition: ${listing.condition || 'N/A'}`);
      console.log(`   Confidence: ${(listing.confidence * 100).toFixed(0)}%`);

      if (listing.soldPrice) {
        console.log('\n✅ SUCCESS! Data extraction working!');
      } else {
        console.log('\n⚠️  No sold price found. This might not be a sold listing.');
      }
    }
  } catch (error) {
    console.error('❌ Error:', (error as Error).message);
  } finally {
    await page.close();
  }

  // Cleanup
  console.log('\n5️⃣ Cleaning up...');
  await sessionManager.closeAll();
  console.log('✅ Done!\n');

  console.log('📊 Session Stats:', sessionManager.getStats());

  process.exit(0);
}

// Run test
test().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
