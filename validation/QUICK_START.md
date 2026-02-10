# Validation Quick Start

Run this **BEFORE** building AI features. Takes ~10 minutes.

---

## Step 1: Start Anno

```bash
cd /home/evo-nirvana/dev/projects/anno
npm start
```

Wait for: `Anno MVP service listening { port: 5213 }`

---

## Step 2: Run Validation

**Open a new terminal:**

```bash
cd /home/evo-nirvana/dev/projects/anno
npx tsx validation/test-real-world.ts
```

You'll see:

```
🚀 Anno Real-World Validation Suite
==================================================
📍 Endpoint: http://localhost:5213
📦 Products to test: 8

✅ Anno is healthy

==================================================
📦 Analyzing: Nintendo Switch OLED
==================================================
🌐 Fetching: https://www.ebay.com/sch/i.html?_nkw=Nintendo%20Switch%20OLED
⏳ This may take 10-20 seconds (rendering enabled)...

✅ Status: 200
⚡ Duration: 12.34s
🎯 Confidence: 85.2%
...
```

**Time:** ~10 minutes total (8 products × ~1 min each)

---

## Step 3: Read the Report

```bash
cat validation/OBSERVATIONS.md
```

Look for:

### 1. Data Completeness

```
Average Data Completeness: 85%  ← Good! ✅
```

- **>70%** = Good, ready to build AI
- **50-70%** = Moderate, build with caution
- **<50%** = Poor, improve extraction first

### 2. Critical Features

```
✅ Price extraction is working well - build RAG pipeline
✅ Good price density - build price comparison agent
```

**These are must-build features.**

### 3. Questions Users Will Ask

```
- "What's the average price for Nintendo Switch?"
- "Which listing has the best deal?"
- "Show me only free shipping items"
```

**Build AI to answer these questions.**

### 4. Suggested Agents

```
- PriceComparisonAgent
- ProductResearchAgent
- DealFinderAgent
```

**These are the agents to build.**

---

## Step 4: Build AI Features

Based on the report recommendations:

### If Completeness > 70% ✅

**You're ready!** Build in this order:

```bash
# Day 1: RAG Pipeline (4h)
# - Answer price queries
# - Extract statistics
# - Generate citations

# Day 2: Price Agent (2h)
# - Compare listings
# - Find deals
# - Track trends

# Day 3: Router (2h)
# - Intent classification
# - Route to agents
# - Test end-to-end
```

### If Completeness 50-70% ⚠️

**Build but improve extraction:**

1. Build core RAG pipeline with current data
2. Document extraction gaps
3. Improve heuristics
4. Re-run validation

### If Completeness < 50% ❌

**Fix extraction first:**

1. Check Anno logs for errors
2. Inspect sample nodes in report
3. Add better patterns
4. Re-run validation
5. **Then** build AI

---

## Example: Read the Report

```bash
cat validation/OBSERVATIONS.md
```

```markdown
# Anno Real-World Validation Report

**Generated:** 2025-10-07T...
**Products Tested:** 8
**Endpoint:** http://localhost:5213

---

## Executive Summary

- **Average Confidence:** 85.2%
- **Average Data Completeness:** 75.0%
- **Average Fetch Time:** 12.45s
- **Cache Hit Rate:** 12%

## 🤖 AI Feature Recommendations

### Critical Features (Build First)

- ✅ Price extraction is working well - build RAG pipeline for price queries
- ✅ Good price density - build price comparison agent

### Questions Users Will Ask

- "What's the average price for [product]?"
- "Which listing has the best deal?"
- "Has the price changed in the last week?"

### Suggested Agents to Build

- `PriceComparisonAgent`
- `ProductResearchAgent`
- `DealFinderAgent`

## 🎯 Implementation Guide

### Phase 1: Core RAG Pipeline (4 hours)

```typescript
// src/ai/rag-pipeline.ts
export class RAGPipeline {
  async query(question: string): Promise<Answer> {
    // 1. Parse question
    // 2. Semantic search
    // 3. Extract data
    // 4. Answer question
  }
}
```

...
```

---

## What to Look For

### ✅ Good Signs

- High confidence scores (>80%)
- Good price extraction (>15 prices per page)
- Completeness >70%
- Clear patterns in data

**→ Build AI features with confidence**

### ⚠️ Warning Signs

- Low confidence (<60%)
- Few prices extracted (<5)
- Completeness <50%
- Inconsistent data

**→ Improve extraction, then build AI**

### ❌ Red Flags

- Errors during extraction
- No prices found
- Completeness <30%
- Empty nodes

**→ Fix extraction before building AI**

---

## Next Steps by Score

### Score: 90-100% 🏆

**Status:** Excellent

**Action:** Build all AI features
```bash
# Build everything in recommended order
# You have high-quality data
```

### Score: 70-89% ✅

**Status:** Good

**Action:** Build core features, improve extraction in parallel
```bash
# Focus on critical features first
# Iterate on data quality
```

### Score: 50-69% ⚠️

**Status:** Moderate

**Action:** Build RAG pipeline only, improve extraction
```bash
# Start with simple RAG
# Fix extraction issues
# Re-validate
# Then build agents
```

### Score: <50% ❌

**Status:** Poor

**Action:** Fix extraction before building AI
```bash
# Don't build AI yet
# Debug extraction
# Improve heuristics
# Re-run validation
```

---

## Customize for FlipIQ

Edit `validation/test-real-world.ts`:

```typescript
const TEST_PRODUCTS = [
  // Replace with actual FlipIQ products
  { name: 'Your Product 1', category: 'Gaming' },
  { name: 'Your Product 2', category: 'Electronics' },
  // Add 6-8 products for good coverage
];
```

Then re-run:

```bash
npx tsx validation/test-real-world.ts
```

---

## Common Issues

### "Cannot connect to Anno"

```bash
# Make sure Anno is running in another terminal
cd /home/evo-nirvana/dev/projects/anno
npm start
```

### Timeout errors

The script uses 60s timeout. If pages are slow:

```typescript
// Edit test-real-world.ts
const anno = new AnnoClient({
  endpoint: ANNO_ENDPOINT,
  timeout: 120000, // 2 minutes
});
```

### Low prices found

Check if rendering is working:

```bash
# In Anno logs, look for:
✅ renderer prelaunch successful

# If not, enable rendering:
export RENDERING_ENABLED=true
npm start
```

---

## Time Budget

- **Setup:** 2 minutes (start Anno)
- **Validation:** 10 minutes (8 products)
- **Read report:** 5 minutes
- **Total:** ~15-20 minutes

**Then you'll know exactly what AI features to build.**

---

## The Payoff

After validation, you'll have:

1. ✅ **Concrete data quality metrics**
2. ✅ **List of features to build (prioritized)**
3. ✅ **Questions users will actually ask**
4. ✅ **Confidence that AI features will work**

**vs. building AI blindly and hoping it works** ❌

---

## Ready?

```bash
# Terminal 1
cd /home/evo-nirvana/dev/projects/anno
npm start

# Terminal 2
cd /home/evo-nirvana/dev/projects/anno
npx tsx validation/test-real-world.ts

# Read report
cat validation/OBSERVATIONS.md

# Build AI features based on recommendations 🚀
```

---

**Questions?** Check `validation/README.md` for details.
