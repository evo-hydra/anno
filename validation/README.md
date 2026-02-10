# Anno Validation Suite

Evidence-based approach to building AI features.

## Purpose

**Don't build AI features blindly.** First, validate with real data to understand:

1. ✅ What Anno actually extracts from eBay
2. ✅ What data quality looks like
3. ✅ What's missing from extractions
4. ✅ What questions users will ask
5. ✅ What AI features would be most valuable

## Quick Start

### 1. Start Anno

```bash
cd /home/evo-nirvana/dev/projects/anno
npm start
```

### 2. Run Validation

```bash
cd /home/evo-nirvana/dev/projects/anno
npx tsx validation/test-real-world.ts
```

**Time:** ~10 minutes (8 products × ~1 min each)

### 3. Read the Report

```bash
cat validation/OBSERVATIONS.md
```

The report includes:
- Data quality assessment
- Extraction success rates
- AI feature recommendations
- Questions users will ask
- Implementation guide

### 4. Build AI Features

Based on the recommendations in the report:

1. Build the "Critical Features" first
2. Implement the suggested agents
3. Test with the questions users will ask

---

## What It Tests

### Data Extraction Quality

- ✅ **Prices** - Can we extract product prices?
- ✅ **Product titles** - Can we identify products?
- ✅ **Shipping info** - Can we find shipping costs?
- ✅ **Conditions** - Can we detect "new" vs "used"?
- ✅ **Seller info** - Can we extract seller data?

### Performance Metrics

- Response time (with/without rendering)
- Cache hit rates
- Confidence scores
- Data completeness

### AI Readiness

- What questions users will ask
- What agents to build
- What data is missing
- What features are critical

---

## Expected Output

```
🚀 Anno Real-World Validation Suite
==================================================

📦 Analyzing: Nintendo Switch OLED
==================================================
✅ Status: 200
⚡ Duration: 12.34s
🎯 Confidence: 85.2%
📊 Nodes extracted: 127

📈 Data Quality:
  - Completeness: 100%
  - Prices found: 24
  - Products found: 18
  - Shipping info: 12
  - Conditions: 8

💰 Price Statistics:
  - Average: $349.99
  - Range: $299.99 - $429.99
  - Std Dev: $32.45
  - Unique prices: 21

...

✅ Report saved to: validation/OBSERVATIONS.md
```

---

## Understanding the Report

### Data Completeness Score

- **100%** = All data types found (prices, products, shipping, conditions)
- **75%** = 3 out of 4 data types found
- **50%** = 2 out of 4 data types found
- **< 50%** = Extraction needs improvement

### Critical Features

These are **must-build** features based on data quality:

```
✅ Price extraction is working well - build RAG pipeline for price queries
✅ Good price density - build price comparison agent
```

### Suggested Agents

Specific agents to build:

- `PriceComparisonAgent` - Compare prices across listings
- `ProductResearchAgent` - Answer product questions
- `DealFinderAgent` - Detect price outliers/deals

### Questions Users Will Ask

Real questions your users will want to ask:

- "What's the average price for Nintendo Switch?"
- "Which listing has the best deal?"
- "Show me only free shipping items"

**Build AI features to answer these questions.**

---

## Custom Test Products

Edit `validation/test-real-world.ts`:

```typescript
const TEST_PRODUCTS = [
  { name: 'Your Product 1', category: 'Category' },
  { name: 'Your Product 2', category: 'Category' },
  // Add your FlipIQ products here
];
```

---

## Troubleshooting

### "Cannot connect to Anno"

```bash
# Make sure Anno is running
cd /home/evo-nirvana/dev/projects/anno
npm start
```

### Timeout errors

```bash
# Increase timeout in test file
const anno = new AnnoClient({
  endpoint: 'http://localhost:5213',
  timeout: 120000, // 2 minutes
});
```

### Low data quality

If completeness < 50%:

1. Check Anno logs for errors
2. Try with `render: false` to compare
3. Inspect sample nodes in report
4. May need to improve extraction heuristics

---

## What Happens Next

Based on validation results:

### Good Data Quality (>70% completeness)

✅ **Ready to build AI features**

1. Implement RAG Pipeline (4h)
2. Build suggested agents (4h)
3. Test with user questions (2h)

### Moderate Data Quality (50-70%)

⚠️ **Build AI but improve extraction**

1. Build core features with current data
2. Iterate on extraction quality
3. Add more heuristics

### Poor Data Quality (<50%)

❌ **Improve extraction first**

1. Debug why extraction is failing
2. Add better patterns
3. Re-run validation
4. Then build AI

---

## Example Workflow

```bash
# 1. Validate
npx tsx validation/test-real-world.ts

# 2. Read report
cat validation/OBSERVATIONS.md

# 3. Based on recommendations, build:
# src/ai/rag-pipeline.ts
# src/agents/price-agent.ts
# src/agents/router.ts

# 4. Test with FlipIQ
cd /path/to/flipiq
npm install /home/evo-nirvana/dev/projects/anno/sdk/typescript
# Use the SDK with your new AI features

# 5. Iterate based on real usage
```

---

## Files

| File | Purpose |
|------|---------|
| `test-real-world.ts` | Main validation suite |
| `OBSERVATIONS.md` | Generated report (after running) |
| `README.md` | This file |

---

## Pro Tips

1. **Run validation before building AI** - Don't waste time building features for data that doesn't exist

2. **Test with your actual products** - Replace TEST_PRODUCTS with items from FlipIQ

3. **Pay attention to completeness score** - This tells you how ready the data is for AI

4. **Read the "Questions Users Will Ask"** - Build features to answer these

5. **Implement in recommended order** - Critical → High → Medium priority

---

**Ready?** Run the validation and let the data guide your AI features! 🚀
