# Anno SDK Usage Guide

Complete guide for using the Anno TypeScript SDK in your projects, including FlipIQ integration.

## Installation

### Option 1: Use Local SDK (Development)

```bash
# From your project directory (e.g., FlipIQ)
cd /path/to/flipiq
npm install /home/evo-nirvana/dev/projects/anno/sdk/typescript
```

### Option 2: Publish to npm (Production)

```bash
cd /home/evo-nirvana/dev/projects/anno/sdk/typescript
npm publish --access public
```

Then install in your project:

```bash
npm install @anno/sdk
```

---

## Quick Start

### Basic Usage

```typescript
import { AnnoClient } from '@anno/sdk';

// Initialize client
const anno = new AnnoClient({
  endpoint: 'http://localhost:5213',
  apiKey: 'your-api-key', // Optional in dev mode
  timeout: 30000,
});

// Fetch and distill a URL
const result = await anno.fetch('https://example.com/article');

console.log('Metadata:', result.metadata);
console.log('Nodes:', result.nodes);
console.log('Confidence:', result.confidence.overallConfidence);
```

---

## FlipIQ Integration Examples

### Example 1: eBay Price Research

```typescript
import { AnnoClient } from '@anno/sdk';

// FlipIQ eBay price checker
async function checkEbayPrices(productName: string) {
  const anno = new AnnoClient({
    endpoint: process.env.ANNO_ENDPOINT || 'http://localhost:5213',
    apiKey: process.env.ANNO_API_KEY,
  });

  // Search eBay
  const searchUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(productName)}`;

  const result = await anno.fetch(searchUrl, {
    render: true, // Use Playwright for JavaScript-heavy page
    maxNodes: 100,
  });

  // Extract prices from nodes
  const prices = result.nodes
    .filter(node => node.text.includes('$'))
    .map(node => {
      const match = node.text.match(/\$(\d+\.?\d*)/);
      return match ? parseFloat(match[1]) : null;
    })
    .filter(price => price !== null);

  return {
    product: productName,
    prices,
    avgPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    url: searchUrl,
    confidence: result.confidence.overallConfidence,
  };
}

// Usage
const priceData = await checkEbayPrices('iPhone 14 Pro');
console.log(`Average price: $${priceData.avgPrice.toFixed(2)}`);
console.log(`Price range: $${priceData.minPrice} - $${priceData.maxPrice}`);
```

---

### Example 2: Competitor Product Monitoring

```typescript
import { AnnoClient } from '@anno/sdk';

interface Product {
  name: string;
  price: number;
  url: string;
  inStock: boolean;
}

async function monitorCompetitors(urls: string[]): Promise<Product[]> {
  const anno = new AnnoClient({
    endpoint: process.env.ANNO_ENDPOINT || 'http://localhost:5213',
    apiKey: process.env.ANNO_API_KEY,
  });

  // Batch fetch all competitor URLs
  const results = await anno.batchFetch(urls, {
    render: true,
    parallel: 5,
  });

  const products: Product[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const url = urls[i];

    // Extract product info
    const titleNode = result.nodes.find(n => n.tag === 'h1');
    const priceNodes = result.nodes.filter(n => n.text.includes('$'));
    const stockNodes = result.nodes.filter(n =>
      n.text.toLowerCase().includes('in stock') ||
      n.text.toLowerCase().includes('available')
    );

    if (titleNode && priceNodes.length > 0) {
      products.push({
        name: titleNode.text,
        price: extractPrice(priceNodes[0].text),
        url,
        inStock: stockNodes.length > 0,
      });
    }
  }

  return products;
}

function extractPrice(text: string): number {
  const match = text.match(/\$(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : 0;
}

// Usage in FlipIQ
const competitorUrls = [
  'https://competitor1.com/product',
  'https://competitor2.com/product',
  'https://competitor3.com/product',
];

const products = await monitorCompetitors(competitorUrls);
console.log('Competitor Products:', products);
```

---

### Example 3: Real-time Streaming for Live Updates

```typescript
import { AnnoClient } from '@anno/sdk';

async function streamProductPage(url: string) {
  const anno = new AnnoClient({
    endpoint: process.env.ANNO_ENDPOINT || 'http://localhost:5213',
    apiKey: process.env.ANNO_API_KEY,
  });

  console.log(`Fetching ${url}...`);

  // Stream events as they come
  for await (const event of anno.fetchStream(url, { render: true })) {
    switch (event.type) {
      case 'metadata':
        console.log('Status:', event.payload.status);
        console.log('From cache:', event.payload.fromCache);
        break;

      case 'node':
        // Process nodes in real-time
        if (event.payload.tag === 'h1') {
          console.log('Title:', event.payload.text);
        }
        if (event.payload.text.includes('$')) {
          console.log('Price found:', event.payload.text);
        }
        break;

      case 'confidence':
        console.log('Confidence:', event.payload.overallConfidence);
        break;

      case 'done':
        console.log('Total nodes:', event.payload.nodes);
        break;

      case 'error':
        console.error('Error:', event.payload.message);
        break;
    }
  }
}

// Usage
await streamProductPage('https://www.ebay.com/itm/123456789');
```

---

### Example 4: Semantic Search for Product Research

```typescript
import { AnnoClient } from '@anno/sdk';

async function researchProduct(query: string) {
  const anno = new AnnoClient({
    endpoint: process.env.ANNO_ENDPOINT || 'http://localhost:5213',
    apiKey: process.env.ANNO_API_KEY,
  });

  // First, fetch some product pages to build the knowledge base
  const urls = [
    'https://www.amazon.com/dp/B09PRODUCT1',
    'https://www.ebay.com/itm/PRODUCT2',
    'https://www.bestbuy.com/product-3',
  ];

  console.log('Building knowledge base...');
  await anno.batchFetch(urls, { render: true });

  // Now perform semantic search
  console.log('Searching for:', query);
  const results = await anno.search(query, { k: 5 });

  console.log('Search Results:');
  for (const result of results) {
    console.log(`- ${result.content} (score: ${result.score.toFixed(3)})`);
  }

  return results;
}

// Usage
await researchProduct('best price for iPhone 14 Pro');
```

---

### Example 5: Full FlipIQ Workflow

```typescript
import { AnnoClient } from '@anno/sdk';

class FlipIQPriceTracker {
  private anno: AnnoClient;

  constructor(annoEndpoint: string, apiKey?: string) {
    this.anno = new AnnoClient({
      endpoint: annoEndpoint,
      apiKey,
      timeout: 60000, // 60 second timeout for complex pages
    });
  }

  /**
   * Track a product across multiple platforms
   */
  async trackProduct(productName: string) {
    const platforms = [
      { name: 'eBay', url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(productName)}` },
      { name: 'Amazon', url: `https://www.amazon.com/s?k=${encodeURIComponent(productName)}` },
      { name: 'Walmart', url: `https://www.walmart.com/search?q=${encodeURIComponent(productName)}` },
    ];

    const urls = platforms.map(p => p.url);
    const results = await this.anno.batchFetch(urls, {
      render: true,
      parallel: 3,
      maxNodes: 100,
    });

    const priceData = results.map((result, index) => {
      const prices = this.extractPrices(result.nodes);

      return {
        platform: platforms[index].name,
        url: platforms[index].url,
        prices,
        avgPrice: prices.length > 0
          ? prices.reduce((a, b) => a + b, 0) / prices.length
          : null,
        confidence: result.confidence.overallConfidence,
      };
    });

    return {
      product: productName,
      platforms: priceData,
      lowestPrice: Math.min(...priceData.map(p => p.avgPrice || Infinity)),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Monitor price changes over time
   */
  async monitorPriceChanges(url: string, intervalMinutes: number = 60) {
    const priceHistory: Array<{ price: number; timestamp: string }> = [];

    const check = async () => {
      try {
        const result = await this.anno.fetch(url, { render: true });
        const prices = this.extractPrices(result.nodes);

        if (prices.length > 0) {
          const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
          priceHistory.push({
            price: avgPrice,
            timestamp: new Date().toISOString(),
          });

          console.log(`[${new Date().toLocaleTimeString()}] Price: $${avgPrice.toFixed(2)}`);

          // Alert if price drops significantly
          if (priceHistory.length > 1) {
            const prevPrice = priceHistory[priceHistory.length - 2].price;
            const change = ((avgPrice - prevPrice) / prevPrice) * 100;

            if (change < -10) {
              console.log(`🚨 ALERT: Price dropped ${Math.abs(change).toFixed(1)}%!`);
            }
          }
        }
      } catch (error) {
        console.error('Error checking price:', error);
      }
    };

    // Initial check
    await check();

    // Set up interval
    const interval = setInterval(check, intervalMinutes * 60 * 1000);

    // Return cleanup function
    return () => clearInterval(interval);
  }

  /**
   * Extract prices from nodes
   */
  private extractPrices(nodes: any[]): number[] {
    const prices: number[] = [];

    for (const node of nodes) {
      const matches = node.text.matchAll(/\$(\d+\.?\d*)/g);
      for (const match of matches) {
        const price = parseFloat(match[1]);
        if (price > 0 && price < 10000) { // Reasonable price range
          prices.push(price);
        }
      }
    }

    return prices;
  }
}

// Usage in FlipIQ
const tracker = new FlipIQPriceTracker(
  process.env.ANNO_ENDPOINT || 'http://localhost:5213',
  process.env.ANNO_API_KEY
);

// Track product across platforms
const data = await tracker.trackProduct('Nintendo Switch OLED');
console.log('Lowest price:', data.lowestPrice);

// Monitor specific listing for price changes
const stopMonitoring = await tracker.monitorPriceChanges(
  'https://www.ebay.com/itm/123456789',
  30 // Check every 30 minutes
);

// Stop after 24 hours
setTimeout(stopMonitoring, 24 * 60 * 60 * 1000);
```

---

## API Reference

### `AnnoClient`

#### Constructor

```typescript
new AnnoClient(config: AnnoConfig)
```

**Parameters:**
- `endpoint`: Anno API endpoint URL
- `apiKey?`: Optional API key for authentication
- `timeout?`: Request timeout in milliseconds (default: 30000)
- `headers?`: Custom headers

#### Methods

##### `fetch(url: string, options?: FetchOptions): Promise<FetchResult>`

Fetch and distill a single URL.

##### `fetchStream(url: string, options?: FetchOptions): AsyncGenerator<StreamEvent>`

Fetch as a stream of events.

##### `batchFetch(urls: string[], options?: BatchFetchOptions): Promise<FetchResult[]>`

Fetch multiple URLs in parallel.

##### `search(query: string, options?: SemanticSearchOptions): Promise<SemanticSearchResult[]>`

Semantic search across cached content.

##### `health(): Promise<HealthResponse>`

Check API health.

---

## Environment Variables

Create a `.env` file in your FlipIQ project:

```bash
# Anno API Configuration
ANNO_ENDPOINT=http://localhost:5213
ANNO_API_KEY=your-api-key-here

# Optional: Custom timeout
ANNO_TIMEOUT=60000
```

---

## Error Handling

```typescript
import { AnnoClient, AnnoError } from '@anno/sdk';

const anno = new AnnoClient({ endpoint: 'http://localhost:5213' });

try {
  const result = await anno.fetch('https://example.com');
  console.log(result.nodes);
} catch (error) {
  if (error instanceof AnnoError) {
    console.error(`Anno Error [${error.statusCode}]:`, error.message);
    if (error.code) {
      console.error('Error code:', error.code);
    }
  } else {
    console.error('Unexpected error:', error);
  }
}
```

---

## Best Practices

### 1. Use Caching

```typescript
// Enable caching for repeated requests
const result = await anno.fetch(url, { useCache: true });
```

### 2. Render Only When Needed

```typescript
// Use render: false for simple pages (faster)
const simpleResult = await anno.fetch(url, { render: false });

// Use render: true for JavaScript-heavy pages (e.g., eBay, Amazon)
const jsResult = await anno.fetch(url, { render: true });
```

### 3. Batch When Possible

```typescript
// Instead of multiple individual requests
const urls = [url1, url2, url3];
const results = await anno.batchFetch(urls, { parallel: 3 });
```

### 4. Handle Rate Limits

```typescript
// Respect rate limit headers
try {
  await anno.fetch(url);
} catch (error) {
  if (error instanceof AnnoError && error.statusCode === 429) {
    console.log('Rate limited, waiting...');
    await new Promise(resolve => setTimeout(resolve, 60000));
  }
}
```

---

## Testing

```bash
# Build SDK
cd /home/evo-nirvana/dev/projects/anno/sdk/typescript
npm install
npm run build

# Test in FlipIQ
cd /path/to/flipiq
npm install /home/evo-nirvana/dev/projects/anno/sdk/typescript

# Create test file
cat > test-anno.ts << 'EOF'
import { AnnoClient } from '@anno/sdk';

const anno = new AnnoClient({ endpoint: 'http://localhost:5213' });

(async () => {
  const result = await anno.fetch('https://example.com');
  console.log('Success!', result.nodes.length, 'nodes extracted');
})();
EOF

npx tsx test-anno.ts
```

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/your-org/anno/issues
- Documentation: https://docs.anno.example.com
- Discord: https://discord.gg/anno
