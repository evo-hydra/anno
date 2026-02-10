# Anno TypeScript SDK

Official TypeScript client for the Anno API.

## Installation

### Local Development

```bash
npm install /path/to/anno/sdk/typescript
```

### From npm (when published)

```bash
npm install @anno/sdk
```

## Quick Start

```typescript
import { AnnoClient } from '@anno/sdk';

const anno = new AnnoClient({
  endpoint: 'http://localhost:5213',
  apiKey: 'your-api-key', // Optional in dev
});

// Fetch and distill a URL
const result = await anno.fetch('https://example.com/article');
console.log(result.nodes); // Extracted content nodes
console.log(result.confidence.overallConfidence); // Quality score
```

## Features

- ✅ **Full TypeScript support** - Complete type definitions
- ✅ **Streaming** - Real-time NDJSON event processing
- ✅ **Batch fetching** - Parallel URL processing
- ✅ **Semantic search** - Search cached content
- ✅ **Error handling** - Custom error types
- ✅ **Configurable** - Timeouts, headers, authentication

## API Reference

### `AnnoClient`

#### Constructor

```typescript
new AnnoClient(config: AnnoConfig)
```

Options:
- `endpoint` (required): Anno API endpoint URL
- `apiKey` (optional): API key for authentication
- `timeout` (optional): Request timeout in ms (default: 30000)
- `headers` (optional): Custom HTTP headers

#### Methods

##### `fetch(url, options?)`

Fetch and distill a single URL.

```typescript
const result = await anno.fetch('https://example.com', {
  useCache: true,
  maxNodes: 60,
  render: false, // Use Playwright rendering
});
```

Returns: `Promise<FetchResult>`

##### `fetchStream(url, options?)`

Stream events in real-time.

```typescript
for await (const event of anno.fetchStream('https://example.com')) {
  if (event.type === 'node') {
    console.log(event.payload.text);
  }
}
```

Returns: `AsyncGenerator<StreamEvent>`

##### `batchFetch(urls, options?)`

Fetch multiple URLs in parallel.

```typescript
const results = await anno.batchFetch(
  ['https://url1.com', 'https://url2.com'],
  { parallel: 3 }
);
```

Returns: `Promise<FetchResult[]>`

##### `search(query, options?)`

Semantic search across cached content.

```typescript
const results = await anno.search('machine learning', { k: 5 });
```

Returns: `Promise<SemanticSearchResult[]>`

##### `health()`

Check API health status.

```typescript
const health = await anno.health();
console.log(health.status); // 'healthy' | 'degraded' | 'unhealthy'
```

Returns: `Promise<HealthResponse>`

## Types

### `FetchResult`

```typescript
interface FetchResult {
  metadata: {
    url: string;
    finalUrl: string;
    status: number;
    fromCache: boolean;
    rendered: boolean;
    durationMs: number;
  };
  nodes: Array<{
    tag: string;
    text: string;
    confidence?: number;
  }>;
  confidence: {
    overallConfidence: number;
  };
  provenance?: {
    contentHash: string;
    algorithm: string;
  };
}
```

### `StreamEvent`

```typescript
type StreamEvent =
  | { type: 'metadata'; payload: { ... } }
  | { type: 'node'; payload: { ... } }
  | { type: 'confidence'; payload: { ... } }
  | { type: 'provenance'; payload: { ... } }
  | { type: 'done'; payload: { ... } }
  | { type: 'error'; payload: { ... } };
```

## Examples

### Basic Fetch

```typescript
const result = await anno.fetch('https://news.ycombinator.com');

console.log('Title:', result.nodes.find(n => n.tag === 'h1')?.text);
console.log('Paragraphs:', result.nodes.filter(n => n.tag === 'p').length);
```

### eBay Product Scraping

```typescript
const result = await anno.fetch('https://www.ebay.com/itm/123456', {
  render: true, // Enable JavaScript rendering
  maxNodes: 100,
});

// Extract prices
const prices = result.nodes
  .filter(n => n.text.includes('$'))
  .map(n => n.text.match(/\$(\d+\.?\d*)/)?.[1])
  .map(Number)
  .filter(n => !isNaN(n));

console.log('Prices found:', prices);
```

### Real-time Streaming

```typescript
for await (const event of anno.fetchStream('https://example.com')) {
  switch (event.type) {
    case 'metadata':
      console.log('Status:', event.payload.status);
      break;
    case 'node':
      console.log('Node:', event.payload.tag, event.payload.text);
      break;
    case 'confidence':
      console.log('Confidence:', event.payload.overallConfidence);
      break;
    case 'done':
      console.log('Complete! Nodes:', event.payload.nodes);
      break;
  }
}
```

### Batch Processing

```typescript
const urls = [
  'https://news.ycombinator.com',
  'https://lobste.rs',
  'https://reddit.com/r/programming',
];

const results = await anno.batchFetch(urls, {
  render: false,
  parallel: 3,
  useCache: true,
});

results.forEach((result, i) => {
  console.log(`\nURL ${i + 1}: ${urls[i]}`);
  console.log(`Nodes: ${result.nodes.length}`);
  console.log(`Confidence: ${result.confidence.overallConfidence}`);
});
```

### Error Handling

```typescript
import { AnnoClient, AnnoError } from '@anno/sdk';

try {
  const result = await anno.fetch('https://example.com');
} catch (error) {
  if (error instanceof AnnoError) {
    console.error(`Error [${error.statusCode}]:`, error.message);

    if (error.statusCode === 429) {
      console.log('Rate limited, retrying in 60s...');
      await new Promise(r => setTimeout(r, 60000));
    }
  }
}
```

## Environment Variables

```bash
# .env file
ANNO_ENDPOINT=http://localhost:5213
ANNO_API_KEY=your-secret-key
ANNO_TIMEOUT=60000
```

Usage:

```typescript
const anno = new AnnoClient({
  endpoint: process.env.ANNO_ENDPOINT!,
  apiKey: process.env.ANNO_API_KEY,
  timeout: Number(process.env.ANNO_TIMEOUT),
});
```

## Development

### Build SDK

```bash
npm install
npm run build
```

### Test SDK

```bash
# Create test file
cat > test.ts << 'EOF'
import { AnnoClient } from './src/index';
const anno = new AnnoClient({ endpoint: 'http://localhost:5213' });
(async () => {
  const result = await anno.fetch('https://example.com');
  console.log('Nodes:', result.nodes.length);
})();
EOF

# Run test
npx tsx test.ts
```

## License

MIT

## Support

- **Documentation:** [docs/SDK_USAGE.md](../../docs/SDK_USAGE.md)
- **Issues:** https://github.com/your-org/anno/issues
- **Discord:** https://discord.gg/anno
