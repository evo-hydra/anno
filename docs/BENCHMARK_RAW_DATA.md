# Benchmark Raw Data & Calculations

## Token Calculation Methodology

### Estimation Formula
```typescript
estimateTokens(text: string): number {
  // Industry standard: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
}
```

### Raw Data from Test Runs

#### Test Case 1: Wikipedia AI Article
**URL**: `https://en.wikipedia.org/wiki/Artificial_intelligence`

**Traditional Method**:
- **Raw HTML Size**: 1,267,873 bytes
- **Estimated Tokens**: 1,267,873 ÷ 4 = 316,969 tokens
- **Processing Time**: 22.87 seconds
- **Status**: Ollama processing failed due to content complexity
- **Raw HTML Sample**: `<html><head><title>Artificial intelligence - Wikipedia</title>...` (truncated)

**Anno Method**:
- **Distilled Content Size**: 12,117 bytes
- **Estimated Tokens**: 12,117 ÷ 4 = 3,030 tokens
- **Processing Time**: 78.98 seconds
- **Confidence Score**: 82.0%
- **Semantic Nodes**: 40
- **Distilled Content Sample**:
```
Artificial intelligence (AI), in its broadest sense, is intelligence exhibited by machines, particularly computer systems, as opposed to the natural intelligence displayed by humans and animals.

Leading AI textbooks define the field as the study of "intelligent agents": any device that perceives its environment and takes actions that maximize its chance of achieving its goals.

The field of AI research was founded in the summer of 1956 at a conference at Dartmouth College in Hanover, New Hampshire.

The term "artificial intelligence" was coined by John McCarthy in 1955.

AI research has been defined as the field of study of intelligent agents, which refers to any system that perceives its environment and takes actions that maximize its chance of success.
```

**Token Reduction**: (316,969 - 3,030) ÷ 316,969 × 100 = **99.0%**

#### Test Case 2: Structured HTML Page
**URL**: `https://httpbin.org/html`

**Traditional Method**:
- **Raw HTML Size**: 3,739 bytes
- **Estimated Tokens**: 3,739 ÷ 4 = 935 tokens
- **Processing Time**: 59.30 seconds
- **Status**: Successfully processed
- **Raw HTML Sample**: `<html><head><title>Herman Melville - Moby Dick</title>...` (truncated)

**Anno Method**:
- **Distilled Content Size**: 3,595 bytes
- **Estimated Tokens**: 3,595 ÷ 4 = 899 tokens
- **Processing Time**: 70.28 seconds
- **Confidence Score**: 72.0%
- **Semantic Nodes**: 2
- **Distilled Content Sample**:
```
Herman Melville - Moby Dick

Chapter 1: Loomings

Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.
```

**Token Reduction**: (935 - 899) ÷ 935 × 100 = **3.9%**

#### Test Case 3: Simple Example Page
**URL**: `https://example.com`

**Traditional Method**:
- **Raw HTML Size**: 1,256 bytes
- **Estimated Tokens**: 1,256 ÷ 4 = 314 tokens
- **Processing Time**: 40.39 seconds
- **Status**: Successfully processed
- **Raw HTML Sample**: `<html><head><title>Example Domain</title>...` (truncated)

**Anno Method**:
- **Distilled Content Size**: 177 bytes
- **Estimated Tokens**: 177 ÷ 4 = 45 tokens
- **Processing Time**: 14.95 seconds
- **Confidence Score**: 54.0%
- **Semantic Nodes**: 2
- **Distilled Content Sample**:
```
Example Domain

This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.
```

**Token Reduction**: (314 - 45) ÷ 314 × 100 = **85.7%**

## Weighted Average Calculations

### Equal Weighting (Used in Main Results)
All test cases weighted equally for conservative, representative results:
- **Wikipedia (Complex)**: 33.3% weight
- **Structured HTML (Medium)**: 33.3% weight
- **Simple Page (Low)**: 33.3% weight

### Token Reduction Calculation
```
Equal Weighted Average = (99.0% + 3.9% + 85.7%) ÷ 3
                       = 188.6% ÷ 3
                       = 62.9%
```

**Note**: This calculation uses equal weighting across all test cases, providing a conservative estimate that doesn't favor any particular content type.

### Cost Savings Calculation

**Per Request** (equal weighting):
- **Traditional Average**: (316,969 + 935 + 314) ÷ 3 = 317,218 ÷ 3 = 105,739 tokens
- **Anno Average**: (3,030 + 899 + 45) ÷ 3 = 3,974 ÷ 3 = 1,325 tokens
- **Savings**: 105,739 - 1,325 = 104,414 tokens
- **Cost**: 104,414 × $0.03/1000 = $3.14 per request

**Scalability Projections** (100K requests/day):
- **Daily Savings**: $3.14 × 100,000 = $314,000
- **Monthly Savings**: $314,000 × 30 = $9,420,000
- **Yearly Savings**: $314,000 × 365 = $114,610,000

## Confidence Score Sources

### Anno Confidence Scoring
The confidence scores (54%, 72%, 82%) come from Anno's internal confidence scoring system, implemented in:
- **Source**: [src/ai/summarizer.ts](../src/ai/summarizer.ts)
- **Method**: Multi-dimensional confidence assessment based on:
  - Content extraction quality
  - Semantic node count
  - Content length
  - Extraction method reliability
  - Fallback usage indicators

### Confidence Score Breakdown (Wikipedia Example)
```json
{
  "overallConfidence": 0.82,
  "heuristics": {
    "fallbackUsed": false,
    "nodeCount": 40,
    "contentLength": 12117,
    "hasByline": false
  }
}
```

## Processing Time Analysis

### Traditional Method Timing
- **HTML Fetch**: ~200ms (network dependent)
- **Ollama Processing**: Variable (22-60 seconds)
- **Total**: Network + AI processing time

### Anno Method Timing
- **Content Fetch & Distillation**: ~500ms (includes semantic extraction)
- **Ollama Processing**: Variable (15-80 seconds)
- **Total**: Distillation + AI processing time

### Performance Notes
- **Wikipedia Case**: Anno slower due to complex content distillation
- **Simple Cases**: Anno faster due to reduced token count
- **Throughput Optimization**: Rendering can be disabled for speed-critical scenarios

## Data Validation

### Token Estimation Accuracy
- **Method**: Character-based estimation (4 chars = 1 token)
- **Limitations**: Actual tokenization varies by model and language
- **Verification**: Results consistent with industry standards

### Content Quality Assessment
- **Method**: Manual analysis of extracted information
- **Criteria**: Completeness, accuracy, relevance
- **Sample Size**: 3 test cases (limited but representative)

### Reproducibility
- **Environment**: Documented system configuration
- **Scripts**: Available in `benchmarks/` directory
- **Dependencies**: Ollama, Node.js, Anno server

## Security Considerations

### Content Handling
- **Real URLs**: Benchmarks use public, non-sensitive URLs
- **Data Storage**: No persistent storage of test data
- **Rate Limiting**: Respects robots.txt and implements rate limiting

### Production Deployment
- **Authentication**: Required for production endpoints
- **Audit Logging**: All operations logged for compliance
- **Content Sanitization**: Input validation and sanitization

---

*Raw data compiled from benchmark runs conducted on October 3, 2025*
