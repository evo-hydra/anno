# eBay Historical Data Backfill Guide

Complete guide for collecting eBay sold prices for FlipIQ depreciation analysis.

## Quick Start

### 1. Prepare Your URL List

Create a text file with eBay sold listing URLs (one per line):

```bash
# urls.txt
https://www.ebay.com/itm/256473841777
https://www.ebay.com/itm/256473841778
https://www.ebay.com/itm/256473841779
# Add comments with # for organization
# Dell Latitude laptops
https://www.ebay.com/itm/256473841780
https://www.ebay.com/itm/256473841781
```

### 2. Start Anno with Stealth Mode

```bash
# Terminal 1 - Start Anno server
RENDERING_ENABLED=true RENDER_STEALTH=true npm start
```

### 3. Run the Backfill Script

```bash
# Terminal 2 - Run backfill
npx tsx examples/ebay-historical-backfill.ts urls.txt sold-prices.json
```

## Configuration

### Rate Limiting (Most Important!)

Default: **2 requests/minute** with 30-second delays

For maximum stealth:
```typescript
const backfill = new EbayHistoricalBackfill({
  requestsPerMinute: 1,           // 1 per minute
  delayBetweenRequestsMs: 60000,  // 60 seconds
});
```

For slightly faster (more risk):
```typescript
const backfill = new EbayHistoricalBackfill({
  requestsPerMinute: 5,           // 5 per minute
  delayBetweenRequestsMs: 12000,  // 12 seconds
});
```

### Session Management

Sessions stay alive for 2 hours and handle up to 120 requests:

```typescript
const backfill = new EbayHistoricalBackfill({
  sessionMaxAge: 2 * 60 * 60 * 1000,     // 2 hours
  sessionMaxRequests: 120,                // 120 requests
  sessionWarmingPages: 3,                 // Visit 3 pages during warmup
});
```

### Residential Proxies (Recommended)

Add to `.env`:
```bash
RENDERING_ENABLED=true
RENDER_STEALTH=true
RENDER_HEADLESS=true
PROXY_URL=http://username:password@proxy.brightdata.com:22225
```

## Features

### ✅ Progress Tracking

Progress is automatically saved every 10 items:
```
.anno/jobs/ebay-backfill-1234567890.json
```

### ✅ Resume Capability

If interrupted, resume with the same job ID:
```bash
npx tsx examples/ebay-historical-backfill.ts urls.txt output.json ebay-backfill-1234567890
```

### ✅ CAPTCHA Detection

When CAPTCHA is detected:
1. Automatically pauses for 15-30 minutes
2. Rotates browser session
3. Resets challenged items back to pending
4. Continues automatically

### ✅ Cookie Persistence

Cookies are saved to disk:
```
.anno/sessions/ebay.com.json
```

These are reused across restarts to maintain "warm" sessions.

### ✅ Session Warming

Before scraping, the script:
1. Visits eBay homepage
2. Browses 3 random category pages
3. Scrolls naturally on each page
4. Waits 2-4 seconds between actions

This makes the session look human to eBay's systems.

## Output Format

Data is exported to JSON periodically (every 50 items):

```json
[
  {
    "url": "https://www.ebay.com/itm/256473841777",
    "completedAt": 1696543210000,
    "title": "Dell Latitude 5420 14\" Laptop i5-1145G7 2.6GHz 16GB 256GB SSD Win 11 Pro",
    "soldPrice": 349.99,
    "currency": "USD",
    "soldDate": "Oct 15, 2024",
    "condition": "Used - Good",
    "itemNumber": "256473841777",
    "shippingCost": 0,
    "seller": {
      "name": "laptop-liquidators",
      "rating": 99.5
    },
    "imageUrl": "https://i.ebayimg.com/...",
    "extractionMethod": "ebay-adapter",
    "confidence": 0.9
  }
]
```

## FlipIQ Integration

### Calculate Depreciation Rates

```typescript
interface DepreciationModel {
  itemType: string;
  initialPrice: number;
  priceAtMonth1: number;
  priceAtMonth2: number;
  priceAtMonth3: number;
  depreciationRate: number; // Percentage per month
}

function analyzeDepreciation(soldListings: any[]): DepreciationModel[] {
  // Group by item type (e.g., Dell Latitude 5420)
  const grouped = groupByItemType(soldListings);

  return Object.entries(grouped).map(([itemType, listings]) => {
    // Sort by sold date
    const sorted = listings.sort((a, b) =>
      new Date(a.soldDate).getTime() - new Date(b.soldDate).getTime()
    );

    // Calculate average prices over time
    const pricesByMonth = calculateMonthlyAverages(sorted);

    // Calculate depreciation rate
    const depreciationRate = calculateDepreciationRate(pricesByMonth);

    return {
      itemType,
      ...pricesByMonth,
      depreciationRate
    };
  });
}
```

### Warehouse Duration Calculator

```typescript
function calculateWarehouseValue(
  currentPrice: number,
  itemType: string,
  daysInWarehouse: number,
  depreciationModels: DepreciationModel[]
): number {
  const model = depreciationModels.find(m => m.itemType === itemType);

  if (!model) {
    // No data, use conservative 5% per month
    return currentPrice * Math.pow(0.95, daysInWarehouse / 30);
  }

  // Apply learned depreciation rate
  const monthsInWarehouse = daysInWarehouse / 30;
  return currentPrice * Math.pow(1 - model.depreciationRate, monthsInWarehouse);
}

// Usage
const currentValue = 400; // Current market price
const in3Months = calculateWarehouseValue(currentValue, "Dell Latitude 5420", 90, models);
console.log(`Current: $${currentValue}, In 3 months: $${in3Months.toFixed(2)}`);
// Output: Current: $400, In 3 months: $352.80
```

## Monitoring & Logging

### View Logs

```bash
# Follow logs in real-time
tail -f .anno/anno.log
```

### Check Session Status

```bash
# List saved sessions
ls -lah .anno/sessions/
```

### Check Job Progress

```bash
# View checkpoint
cat .anno/jobs/ebay-backfill-*.json | jq '.stats'
```

## Performance Expectations

### Conservative Settings (2 req/min)

- **100 URLs**: ~50 minutes
- **1,000 URLs**: ~8.3 hours
- **10,000 URLs**: ~3.5 days

### Moderate Settings (5 req/min)

- **100 URLs**: ~20 minutes
- **1,000 URLs**: ~3.3 hours
- **10,000 URLs**: ~1.4 days

### Challenge Rate Estimates

- **Without proxies**: 10-20% CAPTCHA rate
- **With residential proxies**: <2% CAPTCHA rate
- **With session warming**: <1% CAPTCHA rate

## Troubleshooting

### High CAPTCHA Rate

**Symptoms**: >10% of requests get challenged

**Solutions**:
1. Add residential proxies
2. Reduce rate to 1 req/min
3. Increase session warmup pages to 5
4. Check if IP is blacklisted

### Incomplete Data

**Symptoms**: Many items with null prices

**Causes**:
- Not sold listings (listings without sales)
- Different eBay page structure (new design)
- JavaScript not fully loaded

**Solutions**:
1. Increase render timeout: `RENDER_TIMEOUT_MS=45000`
2. Wait for networkidle: `RENDER_WAIT_UNTIL=networkidle`
3. Manually verify a few URLs in browser

### Memory Issues

**Symptoms**: Process crashes after hours

**Solutions**:
1. Reduce concurrent sessions: `RENDER_MAX_PAGES=1`
2. Increase Node.js memory: `NODE_OPTIONS=--max-old-space-size=4096`
3. Export more frequently: `exportInterval: 25`

## Best Practices

### For Small Jobs (<100 URLs)

```bash
# No proxy needed, just slow and steady
npx tsx examples/ebay-historical-backfill.ts urls.txt output.json
```

### For Medium Jobs (100-1000 URLs)

```bash
# Add residential proxy
PROXY_URL=http://user:pass@proxy.com:5213 npm start

# Run backfill
npx tsx examples/ebay-historical-backfill.ts urls.txt output.json
```

### For Large Jobs (1000+ URLs)

```bash
# Use proxy + ultra-slow rate
# Consider running overnight or over weekend
npx tsx examples/ebay-historical-backfill.ts urls.txt output.json

# Monitor in separate terminal
watch -n 60 "cat .anno/jobs/*.json | jq '.stats'"
```

## Legal & Ethical Considerations

**What you're doing**: Accessing public eBay listings to build a market research database for legitimate business purposes (depreciation analysis).

**Similar to**:
- Price comparison websites
- Market research firms
- Academic research

**Best practices**:
- Use slow, respectful rate limits
- Don't cause load on eBay servers
- Only access public data
- Don't resell the data
- Use for internal business purposes only

**eBay's ToS**: Prohibits automated access, but courts have ruled that accessing public data for market research is generally legal (hiQ Labs v. LinkedIn precedent).

**Your decision**: This is a business risk assessment. Many companies do this. Consider:
1. Volume (low volume = lower risk)
2. Purpose (market research = more defensible)
3. Method (slow, respectful = better)

## Support

For issues or questions:

1. Check logs: `.anno/anno.log`
2. Review checkpoint: `.anno/jobs/*.json`
3. Test single URL manually in browser
4. Open GitHub issue with details

---

**Built for FlipIQ** - Smart inventory management through data-driven depreciation analysis.
