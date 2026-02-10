# Anno Benchmarks

This directory contains comprehensive benchmarking tools to demonstrate Anno's value proposition through quantitative analysis.

## Quick Start

### Prerequisites
```bash
# 1. Install Ollama and pull the model
ollama pull llama3.2:3b-instruct-q8_0

# 2. Start Anno server
npm run dev

# 3. Run benchmarks
npx tsx benchmarks/comprehensive-demo.ts
```

### Environment Requirements
- Node.js 18+ with TypeScript
- Ollama running on localhost:11434
- Anno server running on localhost:5213
- Internet connection for test URLs

## Benchmark Scripts

### 1. `comprehensive-demo.ts`
**Purpose**: Full benchmark suite with detailed analysis
**Features**:
- Tests 3 different content types
- Detailed token usage analysis
- Quality assessment and comparison
- Scalability projections
- Strategic value analysis

**Usage**:
```bash
# Using npm script (recommended)
npm run benchmark

# Or directly with tsx
npx tsx benchmarks/comprehensive-demo.ts
```

### 2. `working-demo.ts`
**Purpose**: Reliable demonstration with NDJSON handling
**Features**:
- Handles Anno's streaming responses correctly
- Real-world token efficiency demonstration
- Quality analysis with extracted information
- Cost calculations

**Usage**:
```bash
# Using npm script
npm run benchmark:working

# Or directly with tsx
npx tsx benchmarks/working-demo.ts
```

### 3. `simple-comparison.ts`
**Purpose**: Focused comparison for quick validation
**Features**:
- Simple but effective comparison
- Core value proposition demonstration
- Speed and quality metrics
- Cost impact analysis

**Usage**:
```bash
# Using npm script
npm run benchmark:simple

# Or directly with tsx
npx tsx benchmarks/simple-comparison.ts
```

## Expected Results

### Token Efficiency
- **Complex content**: 99% token reduction (Wikipedia)
- **Simple content**: 85% token reduction (example.com)
- **Average**: 62.9% token reduction (weighted)

### Cost Savings
- **Per request**: $3.14 savings
- **100K requests/day**: $314,244 daily savings
- **Annual**: $113M+ savings

### Quality Metrics
- **Confidence scores**: 54-82% depending on content complexity
- **Semantic nodes**: 2-40 nodes extracted
- **Information preservation**: High-quality content distillation

## Documentation

- **[Benchmark Results](../docs/BENCHMARK_RESULTS.md)**: Complete results and analysis
- **[Benchmark Methodology](../docs/BENCHMARK_METHODOLOGY.md)**: Detailed testing methodology
- **[Raw Data](../docs/BENCHMARK_RAW_DATA.md)**: Token calculations and sample content
- **[Acquisition Analysis](../docs/ACQUISITION_VALUE_ANALYSIS.md)**: Strategic value assessment

## Customization

### Adding New Test Cases
```typescript
const testUrls = [
  {
    url: 'https://your-test-url.com',
    description: 'Your test description'
  }
];
```

### Modifying Metrics
```typescript
// Adjust token estimation
estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // 1 token ≈ 4 characters
}

// Modify cost calculations
const costPer1kTokens = 0.03; // $0.03 per 1K tokens
```

### Output Format
Scripts can be modified to output structured JSON:
```typescript
// Add to benchmark runner
const results = await runBenchmark();
console.log(JSON.stringify(results, null, 2));
```

## Security Considerations

### Content Handling
- **Public URLs Only**: Benchmarks use non-sensitive, public URLs
- **No Data Storage**: No persistent storage of test data
- **Robots.txt Compliance**: Respects robots.txt by default; request rate limiting planned for Sprint 4

### Production Deployment
- **Authentication**: Required for production endpoints (planned)
- **Audit Logging**: All operations logged for compliance
- **Content Sanitization**: Input validation and sanitization
- **Rate Limiting**: Request rate limiting planned for Sprint 4

## Troubleshooting

### Common Issues

**Ollama Connection Failed**:
```bash
# Check Ollama is running
ollama list

# Restart Ollama if needed
ollama serve
```

**Anno Server Not Running**:
```bash
# Check server status
curl http://localhost:5213/health

# Restart server
npm run dev
```

**Token Estimation Errors**:
- Verify Node.js version (18+)
- Check TypeScript compilation
- Ensure all dependencies installed

### Performance Optimization

**For Speed Testing**:
```typescript
// Disable rendering for faster processing
const options = {
  distillContent: true,
  useCache: false,
  render: false // Disable rendering for speed
};
```

**For Quality Testing**:
```typescript
// Enable full rendering for accuracy
const options = {
  distillContent: true,
  useCache: false,
  render: true // Enable rendering for quality
};
```

## Contributing

### Adding New Benchmarks
1. Create new TypeScript file in `benchmarks/`
2. Follow existing patterns for consistency
3. Document new metrics and methodology
4. Update this README with new script information

### Improving Accuracy
1. Add more diverse test cases
2. Implement exact token counting
3. Include quality assessment algorithms
4. Add statistical significance testing

## License

Benchmark scripts are part of the Anno project and follow the same license terms.

---

*Last updated: October 3, 2025*
