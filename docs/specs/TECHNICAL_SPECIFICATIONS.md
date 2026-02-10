# Anno Technical Specifications

This document provides detailed technical specifications for implementing each layer of the Anno architecture. It serves as the definitive guide for engineers building the system.

## Table of Contents

1. [Layer A: Web Fetching & Transport](#layer-a-web-fetching--transport)
2. [Layer B: Site Adaptation](#layer-b-site-adaptation)
3. [Layer C: Content Delivery](#layer-c-content-delivery)
4. [Layer D: Semantic Intelligence](#layer-d-semantic-intelligence)
5. [Layer E: Multi-Agent Swarm](#layer-e-multi-agent-swarm)
6. [Layer F: Probabilistic Truth](#layer-f-probabilistic-truth)
7. [Layer G: Temporal Intelligence](#layer-g-temporal-intelligence)
8. [Layer H: Reasoning Engine](#layer-h-reasoning-engine)
9. [Cross-Layer Communication](#cross-layer-communication)
10. [Performance Requirements](#performance-requirements)

---

## Layer A: Web Fetching & Transport

### Overview
Layer A handles all web content retrieval, caching, and deterministic processing. It provides the foundation for all higher-level semantic processing.

### Components

#### A1: Transport Manager

**Interface Definition**:
```typescript
interface TransportManager {
  fetch(url: string, options: FetchOptions): Promise<RawContent>;
  getCapabilities(): TransportCapabilities;
  configureTrasport(config: TransportConfig): void;
}

interface FetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  timeout?: number;          // Max 60 seconds
  retries?: number;          // Max 3 retries
  userAgent?: string;
  followRedirects?: boolean; // Default: true, max 5 redirects
}

interface RawContent {
  url: string;
  finalUrl: string;         // After redirects
  statusCode: number;
  headers: Record<string, string>;
  body: string | Buffer;
  contentType: string;
  encoding: string;
  fetchTimestamp: number;   // Unix timestamp
  duration: number;         // Fetch duration in ms
  fromCache: boolean;
  contentHash: string;      // SHA-256 hash
}
```

**Technical Requirements**:

1. **QUIC Transport Implementation**:
   ```typescript
   class QUICTransport implements Transport {
     private connection: QuicConnection;

     async connect(hostname: string, port: number): Promise<void> {
       this.connection = await quic.connect({
         hostname,
         port: port || 443,
         alpn: ['h3', 'h3-32', 'h3-31', 'h3-30', 'h3-29'],
         ciphers: ['CHACHA20-POLY1305', 'AES-256-GCM', 'AES-128-GCM']
       });
     }

     async request(options: RequestOptions): Promise<Response> {
       const stream = await this.connection.createStream();
       // HTTP/3 request implementation
     }
   }
   ```

2. **Fallback Cascade**:
   - Primary: QUIC (HTTP/3)
   - Secondary: HTTP/2 over TLS 1.3
   - Tertiary: HTTP/1.1 over TLS 1.2
   - Fallback detection timeout: 2 seconds

3. **Connection Pooling**:
   - Max connections per host: 6
   - Connection timeout: 30 seconds
   - Keep-alive timeout: 60 seconds
   - Pool cleanup interval: 5 minutes

#### A2: Content Addressing System

**Interface Definition**:
```typescript
interface ContentAddressingSystem {
  generateHash(content: string, metadata: ContentMetadata): string;
  verify(content: string, hash: string): boolean;
  canonicalize(content: string, contentType: string): string;
}

interface ContentMetadata {
  url: string;
  contentType: string;
  lastModified?: string;
  etag?: string;
  cacheControl?: string;
}
```

**Hash Generation Algorithm**:
```typescript
function generateContentHash(content: string, metadata: ContentMetadata): string {
  const canonical = canonicalize(content, metadata.contentType);
  const metaString = `${metadata.url}|${metadata.contentType}|${metadata.lastModified || ''}`;
  const fullContent = canonical + metaString;
  return `sha256:${crypto.createHash('sha256').update(fullContent, 'utf8').digest('hex')}`;
}

function canonicalize(content: string, contentType: string): string {
  if (contentType.includes('text/html')) {
    return content
      .replace(/<!--[\s\S]*?-->/g, '')           // Remove comments
      .replace(/\s+/g, ' ')                      // Normalize whitespace
      .replace(/\s*([<>])\s*/g, '$1')           // Remove space around tags
      .trim();
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.stringify(JSON.parse(content)); // Normalize JSON
    } catch {
      return content;
    }
  }

  return content;
}
```

#### A3: Deterministic JavaScript Engine

**Interface Definition**:
```typescript
interface DeterministicJSEngine {
  execute(script: string, context: ExecutionContext): Promise<ExecutionResult>;
  createSandbox(options: SandboxOptions): Sandbox;
}

interface ExecutionContext {
  initialDOM: DOMSnapshot;
  globals: Record<string, any>;
  timeLimit: number;      // Max execution time in ms
  memoryLimit: number;    // Max memory in bytes
  stepLimit: number;      // Max instruction count
}

interface ExecutionResult {
  success: boolean;
  result?: any;
  error?: Error;
  domMutations: DOMMutation[];
  networkRequests: NetworkRequest[];
  duration: number;
  memoryUsed: number;
  instructionsExecuted: number;
}
```

**QuickJS Integration**:
```typescript
class DeterministicJSEngine {
  private quickjs: QuickJS;

  constructor() {
    this.quickjs = new QuickJS({
      memoryLimit: 64 * 1024 * 1024,  // 64MB
      enableDateNow: false,            // Disable Date.now()
      enableMathRandom: false,         // Disable Math.random()
      enableConsole: false,            // Disable console output
      enableTimers: false              // Disable setTimeout/setInterval
    });
  }

  async execute(script: string, context: ExecutionContext): Promise<ExecutionResult> {
    const sandbox = this.quickjs.newContext();

    // Inject deterministic APIs
    sandbox.setProp(sandbox.global, 'Date', this.createDeterministicDate(context.timestamp));
    sandbox.setProp(sandbox.global, 'Math', this.createDeterministicMath(context.seed));

    // Set resource limits
    sandbox.setInterruptHandler(() => {
      return performance.now() - startTime > context.timeLimit;
    });

    const startTime = performance.now();

    try {
      const result = sandbox.evalCode(script);
      const mutations = this.captureDOMMutations(context.initialDOM);

      return {
        success: true,
        result: sandbox.dump(result),
        domMutations: mutations,
        networkRequests: this.captureNetworkRequests(),
        duration: performance.now() - startTime,
        memoryUsed: sandbox.computeMemoryUsage(),
        instructionsExecuted: sandbox.getInstructionCount()
      };
    } catch (error) {
      return {
        success: false,
        error,
        domMutations: [],
        networkRequests: [],
        duration: performance.now() - startTime,
        memoryUsed: 0,
        instructionsExecuted: 0
      };
    } finally {
      sandbox.dispose();
    }
  }
}
```

#### A4: Cache System

**Interface Definition**:
```typescript
interface CacheSystem {
  get(hash: string): Promise<CachedContent | null>;
  set(hash: string, content: RawContent, ttl?: number): Promise<void>;
  invalidate(pattern: string | RegExp): Promise<number>;
  getStats(): CacheStats;
}

interface CachedContent extends RawContent {
  cachedAt: number;
  accessCount: number;
  lastAccessed: number;
}
```

**Redis Implementation**:
```typescript
class RedisCacheSystem implements CacheSystem {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      keyPrefix: 'anno:cache:',
      serializer: 'msgpack',
      compression: 'gzip'
    });
  }

  async get(hash: string): Promise<CachedContent | null> {
    const cached = await this.redis.hgetall(hash);
    if (!cached.content) return null;

    // Update access statistics
    await this.redis.multi()
      .hincrby(hash, 'accessCount', 1)
      .hset(hash, 'lastAccessed', Date.now())
      .exec();

    return {
      ...JSON.parse(cached.content),
      accessCount: parseInt(cached.accessCount) + 1,
      lastAccessed: Date.now()
    };
  }

  async set(hash: string, content: RawContent, ttl = 3600): Promise<void> {
    const cached: CachedContent = {
      ...content,
      cachedAt: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now()
    };

    await this.redis.multi()
      .hset(hash, 'content', JSON.stringify(content))
      .hset(hash, 'cachedAt', cached.cachedAt)
      .hset(hash, 'accessCount', 0)
      .hset(hash, 'lastAccessed', cached.lastAccessed)
      .expire(hash, ttl)
      .exec();
  }
}
```

### Performance Requirements

- **Response Time**: 95th percentile < 2 seconds
- **Throughput**: 100+ requests per second per core
- **Cache Hit Ratio**: > 85% for repeated content
- **Memory Usage**: < 512MB per worker process
- **CPU Usage**: < 80% average utilization

---

## Layer B: Site Adaptation

### Overview
Layer B learns site-specific extraction patterns and adapts to changes in website structure over time.

### Components

#### B1: Adaptive Selector Engine

**Interface Definition**:
```typescript
interface AdaptiveSelectorEngine {
  extract(url: string, intent: ExtractionIntent): Promise<ExtractionResult>;
  learn(example: ExtractionExample): Promise<void>;
  repair(pattern: SitePattern, currentDOM: DOMSnapshot): Promise<RepairResult>;
}

interface ExtractionIntent {
  target: 'title' | 'content' | 'author' | 'date' | 'links' | 'custom';
  customFields?: string[];
  confidenceThreshold: number; // 0.0 to 1.0
  maxResults?: number;
}

interface ExtractionResult {
  success: boolean;
  data: ExtractedData[];
  confidence: number;
  selectors: string[];
  method: 'css' | 'xpath' | 'accessibility' | 'heuristic';
  fallbacks: ExtractionResult[];
}
```

**Pattern Learning Algorithm**:
```typescript
class AdaptiveSelectorEngine {
  private patterns: Map<string, SitePattern> = new Map();
  private trainingData: ExtractionExample[] = [];

  async extract(url: string, intent: ExtractionIntent): Promise<ExtractionResult> {
    const domain = this.extractDomain(url);
    const pattern = this.patterns.get(domain);

    if (pattern && pattern.confidence > intent.confidenceThreshold) {
      const result = await this.tryExistingPattern(pattern, intent);
      if (result.success && result.confidence > intent.confidenceThreshold) {
        await this.updatePatternStats(pattern, true);
        return result;
      }
    }

    // Pattern failed or doesn't exist, learn new one
    return await this.learnAndExtract(url, intent);
  }

  private async learnAndExtract(url: string, intent: ExtractionIntent): Promise<ExtractionResult> {
    const strategies = [
      this.cssHeuristicExtraction,
      this.xpathPatternExtraction,
      this.accessibilityTreeExtraction,
      this.textualPatternMatching,
      this.structuralAnalysis
    ];

    const candidates = await Promise.all(
      strategies.map(strategy => strategy(url, intent))
    );

    // Score candidates using ensemble method
    const scored = candidates.map(candidate => ({
      ...candidate,
      score: this.scoreExtractionResult(candidate, intent)
    }));

    const best = scored.reduce((prev, curr) =>
      curr.score > prev.score ? curr : prev
    );

    // Learn from successful extraction
    if (best.confidence > 0.7) {
      await this.updateSitePattern(url, intent, best);
    }

    return best;
  }

  private scoreExtractionResult(result: ExtractionResult, intent: ExtractionIntent): number {
    let score = result.confidence;

    // Boost score for more specific selectors
    const selectorSpecificity = this.calculateSelectorSpecificity(result.selectors);
    score *= (1 + selectorSpecificity * 0.1);

    // Boost score for accessibility-based extraction
    if (result.method === 'accessibility') {
      score *= 1.2;
    }

    // Penalize overly complex selectors
    const complexity = result.selectors.reduce((sum, sel) => sum + sel.length, 0);
    if (complexity > 100) {
      score *= 0.9;
    }

    return Math.min(score, 1.0);
  }
}
```

#### B2: API Discovery Engine

**Interface Definition**:
```typescript
interface APIDiscoveryEngine {
  discoverAPIs(url: string): Promise<APIEndpoint[]>;
  analyzeEndpoint(endpoint: APIEndpoint): Promise<EndpointAnalysis>;
  trackEndpointStability(endpoint: APIEndpoint): Promise<StabilityMetrics>;
}

interface APIEndpoint {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  parameters: Parameter[];
  responseSchema: JSONSchema;
  authentication?: AuthMethod;
  rateLimit?: RateLimit;
  stability: number; // 0.0 to 1.0
}
```

**API Discovery Implementation**:
```typescript
class APIDiscoveryEngine {
  private networkMonitor: NetworkMonitor;
  private endpointHistory: Map<string, EndpointHistory> = new Map();

  async discoverAPIs(url: string): Promise<APIEndpoint[]> {
    // Monitor network traffic during page load
    const requests = await this.networkMonitor.captureRequests(url, {
      includeTypes: ['xhr', 'fetch', 'websocket'],
      minDuration: 100, // Filter out very fast requests
      maxDuration: 30000 // Filter out very slow requests
    });

    const apiCandidates = requests
      .filter(req => this.isAPIRequest(req))
      .map(req => this.analyzeRequest(req));

    // Score candidates based on stability and usefulness
    const scoredCandidates = await Promise.all(
      apiCandidates.map(async candidate => ({
        ...candidate,
        score: await this.scoreEndpoint(candidate)
      }))
    );

    return scoredCandidates
      .filter(candidate => candidate.score > 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10); // Return top 10 endpoints
  }

  private isAPIRequest(request: NetworkRequest): boolean {
    // Check if request looks like an API call
    const contentType = request.responseHeaders['content-type'] || '';
    const isJSON = contentType.includes('application/json');
    const isXML = contentType.includes('application/xml') || contentType.includes('text/xml');

    // Check URL patterns
    const hasApiInPath = /\/api\/|\/v\d+\/|\/rest\/|\/graphql/i.test(request.url);

    // Check for structured data response
    const hasStructuredResponse = isJSON || isXML || hasApiInPath;

    return hasStructuredResponse && request.statusCode >= 200 && request.statusCode < 300;
  }
}
```

#### B3: Drift Detection System

**Interface Definition**:
```typescript
interface DriftDetectionSystem {
  detectDrift(url: string, currentDOM: DOMSnapshot, historicalPattern: SitePattern): Promise<DriftAnalysis>;
  generateRepairSuggestions(analysis: DriftAnalysis): Promise<RepairSuggestion[]>;
  updateDriftModel(domain: string, driftEvents: DriftEvent[]): Promise<void>;
}

interface DriftAnalysis {
  drifted: boolean;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  driftScore: number; // 0.0 to 1.0
  affectedSelectors: string[];
  structuralChanges: StructuralChange[];
  confidenceImpact: number;
}
```

**Structural Feature Extraction**:
```typescript
class DriftDetectionSystem {
  detectDrift(url: string, currentDOM: DOMSnapshot, historicalPattern: SitePattern): Promise<DriftAnalysis> {
    // Extract structural features
    const currentFeatures = this.extractStructuralFeatures(currentDOM);
    const historicalFeatures = historicalPattern.structuralFeatures;

    // Calculate structural distance
    const driftScore = this.computeStructuralDistance(currentFeatures, historicalFeatures);

    if (driftScore > this.DRIFT_THRESHOLD) {
      return {
        drifted: true,
        severity: this.categorizeDriftSeverity(driftScore),
        driftScore,
        affectedSelectors: this.identifyAffectedSelectors(historicalPattern, currentFeatures),
        structuralChanges: this.analyzeStructuralChanges(historicalFeatures, currentFeatures),
        confidenceImpact: this.estimateConfidenceImpact(driftScore)
      };
    }

    return { drifted: false, severity: 'none', driftScore: 0, affectedSelectors: [], structuralChanges: [], confidenceImpact: 0 };
  }

  private extractStructuralFeatures(dom: DOMSnapshot): StructuralFeatures {
    return {
      tagDistribution: this.calculateTagDistribution(dom),
      depthDistribution: this.calculateDepthDistribution(dom),
      classPatterns: this.extractClassPatterns(dom),
      idPatterns: this.extractIdPatterns(dom),
      textContentPatterns: this.extractTextPatterns(dom),
      linkStructure: this.analyzeLinkStructure(dom)
    };
  }

  private computeStructuralDistance(current: StructuralFeatures, historical: StructuralFeatures): number {
    // Use weighted combination of different distance metrics
    const tagDist = this.jensenShannonDistance(current.tagDistribution, historical.tagDistribution);
    const depthDist = this.wasersteinDistance(current.depthDistribution, historical.depthDistribution);
    const classDist = this.jaccardDistance(current.classPatterns, historical.classPatterns);
    const idDist = this.jaccardDistance(current.idPatterns, historical.idPatterns);

    return (tagDist * 0.3) + (depthDist * 0.2) + (classDist * 0.3) + (idDist * 0.2);
  }
}
```

### Performance Requirements

- **Pattern Learning**: < 5 seconds for new site analysis
- **Extraction Speed**: < 500ms for cached patterns
- **Drift Detection**: < 200ms for structural comparison
- **Memory Usage**: < 256MB for pattern storage
- **Accuracy**: > 90% precision for extraction confidence > 0.8

---

## Layer C: Content Delivery

### Overview
Layer C converts raw HTML to structured JSONL streams and provides human-readable proxy pages.

### Components

#### C1: JSONL Stream Generator

**Interface Definition**:
```typescript
interface JSONLStreamGenerator {
  generateStream(content: RawContent, extractedData: ExtractionResult[]): AsyncIterable<JSONLEvent>;
  processChunked(content: RawContent, chunkSize?: number): AsyncIterable<JSONLEvent>;
}

type JSONLEvent = MetadataEvent | NodeEvent | EntityEvent | LinkEvent | RelationEvent | DoneEvent;

interface MetadataEvent {
  type: 'metadata';
  url: string;
  title: string;
  language: string;
  timestamp: number;
  contentHash: string;
  processingTime: number;
}

interface NodeEvent {
  type: 'node';
  id: string;
  selector: string;
  tagName: string;
  textContent: string;
  attributes: Record<string, string>;
  semanticValue: number; // 0.0 to 1.0
  provenance: ProvenanceInfo;
}
```

**Stream Generation Implementation**:
```typescript
class JSONLStreamGenerator {
  async* generateStream(content: RawContent, extractedData: ExtractionResult[]): AsyncIterable<JSONLEvent> {
    const startTime = performance.now();

    // Emit metadata first
    yield {
      type: 'metadata',
      url: content.url,
      title: this.extractTitle(content),
      language: this.detectLanguage(content),
      timestamp: content.fetchTimestamp,
      contentHash: content.contentHash,
      processingTime: 0 // Will be updated at the end
    };

    // Parse DOM and emit semantic nodes
    const dom = this.parseDOM(content.body);
    const walker = this.createSemanticWalker(dom);

    let nodeId = 0;
    for (const node of walker) {
      if (this.hasSemanticValue(node)) {
        yield {
          type: 'node',
          id: `node_${nodeId++}`,
          selector: this.generateSelector(node),
          tagName: node.tagName.toLowerCase(),
          textContent: this.extractCleanText(node),
          attributes: this.filterRelevantAttributes(node),
          semanticValue: this.calculateSemanticValue(node),
          provenance: this.generateProvenance(node, content)
        };
      }
    }

    // Emit extracted entities
    for (const extraction of extractedData) {
      if (extraction.success) {
        for (const entity of extraction.data) {
          yield {
            type: 'entity',
            text: entity.text,
            entityType: entity.type,
            confidence: entity.confidence,
            boundingNodes: entity.sourceNodes,
            provenance: entity.provenance
          };
        }
      }
    }

    // Emit processing completion
    yield {
      type: 'done',
      processingTime: performance.now() - startTime,
      totalNodes: nodeId,
      totalEntities: extractedData.reduce((sum, r) => sum + (r.success ? r.data.length : 0), 0)
    };
  }

  private calculateSemanticValue(node: Node): number {
    let score = 0;

    // Content-based scoring
    const textLength = node.textContent?.trim().length || 0;
    if (textLength > 10) score += 0.3;
    if (textLength > 50) score += 0.2;
    if (textLength > 200) score += 0.2;

    // Structural importance
    const tagName = node.tagName?.toLowerCase();
    const semanticTags = ['article', 'section', 'header', 'main', 'h1', 'h2', 'h3', 'p', 'li'];
    if (semanticTags.includes(tagName)) score += 0.4;

    // Link analysis
    if (tagName === 'a' && node.getAttribute('href')) score += 0.3;

    // Rich attributes
    if (node.hasAttribute('itemscope')) score += 0.2;
    if (node.hasAttribute('data-testid')) score += 0.1;

    return Math.min(score, 1.0);
  }
}
```

#### C2: Reader Mode Distillation

**Interface Definition**:
```typescript
interface ReaderModeDistiller {
  distill(html: string, url: string): Promise<DistilledContent>;
  configureDistiller(options: DistillationOptions): void;
  getDistillationMethods(): string[];
}

interface DistilledContent {
  title: string;
  content: string;
  author?: string;
  publishDate?: Date;
  mainImage?: string;
  readingTime: number; // in minutes
  wordCount: number;
  confidence: number;
  method: string;
  provenance: ProvenanceRecord;
}
```

**Multi-Method Distillation**:
```typescript
class ReaderModeDistiller {
  private readability: Readability;
  private trafilatura: Trafilatura;

  async distill(html: string, url: string): Promise<DistilledContent> {
    // Try multiple distillation approaches in parallel
    const distillationPromises = [
      this.readabilityDistillation(html, url),
      this.trafilaturaDistillation(html, url),
      this.customHeuristicDistillation(html, url),
      this.accessibilityTreeDistillation(html, url)
    ];

    const candidates = await Promise.allSettled(distillationPromises);
    const successful = candidates
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<DistilledContent>).value);

    if (successful.length === 0) {
      throw new Error('All distillation methods failed');
    }

    // Score and select best distillation
    const scored = successful.map(candidate => ({
      ...candidate,
      score: this.scoreDistillation(candidate)
    }));

    const best = scored.reduce((prev, curr) =>
      curr.score > prev.score ? curr : prev
    );

    return best;
  }

  private scoreDistillation(content: DistilledContent): number {
    let score = content.confidence;

    // Penalize very short content
    if (content.wordCount < 100) score *= 0.7;
    if (content.wordCount < 50) score *= 0.5;

    // Boost complete articles
    if (content.author && content.publishDate) score *= 1.1;
    if (content.mainImage) score *= 1.05;

    // Penalize suspicious patterns
    if (this.hasSuspiciousPatterns(content.content)) score *= 0.8;

    return Math.min(score, 1.0);
  }

  private async readabilityDistillation(html: string, url: string): Promise<DistilledContent> {
    const doc = new JSDOM(html).window.document;
    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article) {
      throw new Error('Readability extraction failed');
    }

    return {
      title: article.title,
      content: article.content,
      author: article.byline,
      publishDate: this.extractPublishDate(article.content),
      readingTime: Math.ceil(article.length / 200), // ~200 WPM reading speed
      wordCount: article.length,
      confidence: this.calculateReadabilityConfidence(article),
      method: 'readability',
      provenance: this.generateProvenance('readability', html, article)
    };
  }
}
```

### Performance Requirements

- **JSONL Generation**: < 100ms per MB of input HTML
- **Distillation**: < 500ms per article
- **Memory Usage**: < 128MB per processing task
- **Stream Throughput**: 1000+ events per second
- **Accuracy**: > 95% for content extraction confidence > 0.8

---

## Layer D: Semantic Intelligence

### Overview
Layer D builds knowledge graphs from web content and performs entity resolution and relationship extraction.

### Components

#### D1: Knowledge Graph Builder

**Interface Definition**:
```typescript
interface KnowledgeGraphBuilder {
  processPage(events: AsyncIterable<JSONLEvent>): Promise<SemanticPage>;
  buildKnowledgeGraph(pages: SemanticPage[]): Promise<KnowledgeGraph>;
  queryGraph(query: GraphQuery): Promise<QueryResult>;
}

interface SemanticPage {
  url: string;
  entities: Entity[];
  relationships: Relationship[];
  claims: Claim[];
  temporalBounds: TemporalBounds;
  contradictions: Contradiction[];
}

interface Entity {
  id: string;
  text: string;
  type: EntityType;
  confidence: number;
  canonicalId?: string; // Wikidata/DBpedia ID
  aliases: string[];
  properties: Record<string, any>;
  provenance: ProvenanceInfo[];
}
```

**Entity Resolution Implementation**:
```typescript
class EntityResolver {
  private wikidataClient: WikidataClient;
  private dbpediaClient: DBpediaClient;
  private localCache: EntityCache;

  async resolve(entity: RawEntity): Promise<ResolvedEntity> {
    // Check local cache first
    const cacheKey = this.generateCacheKey(entity);
    const cached = await this.localCache.get(cacheKey);

    if (cached && cached.confidence > 0.9) {
      return cached;
    }

    // Parallel resolution against multiple knowledge bases
    const resolutionPromises = [
      this.resolveWithWikidata(entity),
      this.resolveWithDBpedia(entity),
      this.resolveWithCustomKB(entity)
    ];

    const resolutions = await Promise.allSettled(resolutionPromises);
    const successful = resolutions
      .filter(result => result.status === 'fulfilled')
      .map(result => (result as PromiseFulfilledResult<EntityResolution>).value);

    if (successful.length === 0) {
      return {
        ...entity,
        canonicalId: null,
        confidence: 0.3, // Low confidence for unresolved entities
        resolution_method: 'none'
      };
    }

    // Use consensus-based resolution
    const consensus = this.buildConsensusResolution(successful);

    // Cache high-confidence resolutions
    if (consensus.confidence > 0.8) {
      await this.localCache.set(cacheKey, consensus);
    }

    return consensus;
  }

  private async resolveWithWikidata(entity: RawEntity): Promise<EntityResolution> {
    const searchQuery = this.buildWikidataQuery(entity);
    const candidates = await this.wikidataClient.search(searchQuery);

    if (candidates.length === 0) {
      throw new Error('No Wikidata candidates found');
    }

    // Score candidates based on multiple factors
    const scored = candidates.map(candidate => ({
      ...candidate,
      score: this.scoreWikidataCandidate(candidate, entity)
    }));

    const best = scored.reduce((prev, curr) =>
      curr.score > prev.score ? curr : prev
    );

    return {
      canonicalId: best.id,
      confidence: best.score,
      aliases: best.aliases,
      properties: best.claims,
      resolution_method: 'wikidata'
    };
  }

  private buildConsensusResolution(resolutions: EntityResolution[]): ResolvedEntity {
    // Weighted voting based on resolution method confidence
    const weights = {
      'wikidata': 0.4,
      'dbpedia': 0.3,
      'custom': 0.3
    };

    // Find most confident resolution
    const best = resolutions.reduce((prev, curr) =>
      (curr.confidence * weights[curr.resolution_method]) >
      (prev.confidence * weights[prev.resolution_method]) ? curr : prev
    );

    // Combine aliases from all resolutions
    const allAliases = new Set<string>();
    resolutions.forEach(res => res.aliases?.forEach(alias => allAliases.add(alias)));

    return {
      ...best,
      aliases: Array.from(allAliases),
      consensus_score: this.calculateConsensusScore(resolutions),
      resolution_sources: resolutions.map(r => r.resolution_method)
    };
  }
}
```

#### D2: Relationship Extraction

**Interface Definition**:
```typescript
interface RelationshipExtractor {
  extractRelationships(entities: Entity[], context: string): Promise<Relationship[]>;
  classifyRelationship(subject: Entity, object: Entity, context: string): Promise<RelationshipType>;
  validateRelationship(relationship: Relationship): Promise<ValidationResult>;
}

interface Relationship {
  id: string;
  subject: string;   // Entity ID
  predicate: string; // Relationship type
  object: string;    // Entity ID
  confidence: number;
  evidence: string[];
  temporalScope?: TemporalBounds;
  provenance: ProvenanceInfo;
}
```

**Neural Relationship Extraction**:
```typescript
class NeuralRelationshipExtractor {
  private model: TransformerModel;
  private relationshipTypes: RelationshipType[];

  constructor() {
    // Load pre-trained relation extraction model
    this.model = new TransformerModel('relation-extraction-bert-base');
    this.relationshipTypes = this.loadRelationshipOntology();
  }

  async extractRelationships(entities: Entity[], context: string): Promise<Relationship[]> {
    const relationships: Relationship[] = [];

    // Generate all entity pairs
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const subject = entities[i];
        const object = entities[j];

        // Skip if entities are too far apart in text
        if (this.calculateTextDistance(subject, object, context) > 100) {
          continue;
        }

        const relationship = await this.extractRelationship(subject, object, context);
        if (relationship && relationship.confidence > 0.5) {
          relationships.push(relationship);
        }
      }
    }

    // Post-process to remove redundant relationships
    return this.deduplicateRelationships(relationships);
  }

  private async extractRelationship(subject: Entity, object: Entity, context: string): Promise<Relationship | null> {
    // Prepare input for the model
    const input = this.prepareModelInput(subject, object, context);

    // Run inference
    const prediction = await this.model.predict(input);

    if (prediction.confidence < 0.5) {
      return null;
    }

    return {
      id: `rel_${subject.id}_${object.id}`,
      subject: subject.id,
      predicate: prediction.relation_type,
      object: object.id,
      confidence: prediction.confidence,
      evidence: this.extractEvidence(subject, object, context),
      temporalScope: this.extractTemporalScope(context),
      provenance: this.generateProvenance(input, prediction)
    };
  }

  private prepareModelInput(subject: Entity, object: Entity, context: string): ModelInput {
    // Extract sentence containing both entities
    const sentence = this.extractContainingSentence(subject, object, context);

    // Mark entity positions
    const markedSentence = this.markEntityPositions(sentence, subject, object);

    return {
      text: markedSentence,
      subject_type: subject.type,
      object_type: object.type,
      subject_start: this.findEntityPosition(sentence, subject.text),
      subject_end: this.findEntityPosition(sentence, subject.text) + subject.text.length,
      object_start: this.findEntityPosition(sentence, object.text),
      object_end: this.findEntityPosition(sentence, object.text) + object.text.length
    };
  }
}
```

### Performance Requirements

- **Entity Resolution**: < 200ms per entity (with cache)
- **Relationship Extraction**: < 500ms per entity pair
- **Knowledge Graph Query**: < 100ms for simple queries
- **Memory Usage**: < 1GB for knowledge graph storage
- **Accuracy**: > 85% for entity resolution, > 80% for relationships

---

## Layer E: Multi-Agent Swarm

### Overview
Layer E coordinates specialized agents to perform complex research tasks collaboratively.

### Components

#### E1: Agent Orchestra

**Interface Definition**:
```typescript
interface AgentOrchestra {
  research(query: ResearchQuery): Promise<ResearchResult>;
  registerAgent(agent: SpecializedAgent): void;
  coordinateAgents(task: ComplexTask): Promise<CoordinationResult>;
}

interface ResearchQuery {
  question: string;
  domain?: string;
  depth: 'surface' | 'comprehensive' | 'exhaustive';
  timeLimit?: number;
  sources?: string[];
  verificationLevel: 'basic' | 'enhanced' | 'rigorous';
}

interface ResearchResult {
  answer: string;
  confidence: number;
  evidence: Evidence[];
  sources: Source[];
  reasoning: ReasoningChain;
  agents: string[]; // Which agents contributed
}
```

**Task Decomposition Algorithm**:
```typescript
class AgentOrchestra {
  private agents: Map<string, SpecializedAgent> = new Map();
  private taskQueue: TaskQueue;
  private coordinationEngine: CoordinationEngine;

  async research(query: ResearchQuery): Promise<ResearchResult> {
    // Decompose query into sub-tasks
    const tasks = await this.decomposeQuery(query);

    // Assign tasks to specialized agents
    const assignments = await this.assignTasks(tasks);

    // Execute tasks with coordination
    const results = await this.executeWithCoordination(assignments);

    // Synthesize final result
    return await this.synthesizeResults(results, query);
  }

  private async decomposeQuery(query: ResearchQuery): Promise<Task[]> {
    const decomposer = new TaskDecomposer();

    // Analyze query complexity and domain
    const analysis = await decomposer.analyzeQuery(query);

    if (analysis.complexity === 'simple') {
      return [{
        type: 'direct_answer',
        query: query.question,
        domain: query.domain,
        priority: 'high'
      }];
    }

    // Complex query decomposition
    const tasks: Task[] = [];

    // Information gathering tasks
    if (analysis.requiresFactualInfo) {
      tasks.push({
        type: 'fact_gathering',
        query: this.extractFactualQuestions(query.question),
        domain: query.domain,
        priority: 'high'
      });
    }

    // Analysis tasks
    if (analysis.requiresAnalysis) {
      tasks.push({
        type: 'analysis',
        query: this.extractAnalyticalQuestions(query.question),
        domain: query.domain,
        priority: 'medium',
        dependencies: ['fact_gathering']
      });
    }

    // Synthesis task
    tasks.push({
      type: 'synthesis',
      query: query.question,
      domain: query.domain,
      priority: 'low',
      dependencies: tasks.map(t => t.type)
    });

    return tasks;
  }

  private async assignTasks(tasks: Task[]): Promise<TaskAssignment[]> {
    const assignments: TaskAssignment[] = [];

    for (const task of tasks) {
      // Find agents capable of handling this task
      const capableAgents = Array.from(this.agents.values())
        .filter(agent => agent.canHandle(task))
        .sort((a, b) => b.getCapabilityScore(task) - a.getCapabilityScore(task));

      if (capableAgents.length === 0) {
        throw new Error(`No agent capable of handling task: ${task.type}`);
      }

      // Assign primary agent
      const primaryAgent = capableAgents[0];

      // Assign verification agents if required
      const verificationAgents = capableAgents.slice(1, 3);

      assignments.push({
        task,
        primaryAgent: primaryAgent.getId(),
        verificationAgents: verificationAgents.map(a => a.getId()),
        timeout: this.calculateTaskTimeout(task),
        retries: task.priority === 'high' ? 3 : 1
      });
    }

    return assignments;
  }
}
```

#### E2: Specialized Agents

**Base Agent Architecture**:
```typescript
abstract class SpecializedAgent {
  abstract readonly id: string;
  abstract readonly specialization: string[];
  abstract readonly skills: string[];
  abstract readonly version: string;

  abstract canHandle(task: Task): boolean;
  abstract getCapabilityScore(task: Task): number;
  abstract executeTask(task: Task, context: AgentContext): Promise<AgentResult>;

  protected async preProcess(task: Task): Promise<Task> {
    // Common preprocessing steps
    return {
      ...task,
      preprocessed: true,
      timestamp: Date.now()
    };
  }

  protected async postProcess(result: AgentResult): Promise<AgentResult> {
    // Common postprocessing steps
    return {
      ...result,
      postprocessed: true,
      agentId: this.id,
      agentVersion: this.version
    };
  }
}

class AcademicResearchAgent extends SpecializedAgent {
  readonly id = 'academic-research-agent-v1';
  readonly specialization = ['arxiv.org', 'scholar.google.com', 'pubmed.ncbi.nlm.nih.gov', 'ieee.org'];
  readonly skills = ['citation_analysis', 'peer_review_assessment', 'methodology_evaluation', 'research_synthesis'];
  readonly version = '1.0.0';

  canHandle(task: Task): boolean {
    return task.domain === 'academic' ||
           task.type === 'research_synthesis' ||
           task.sources?.some(source => this.specialization.some(domain => source.includes(domain)));
  }

  getCapabilityScore(task: Task): number {
    let score = 0.5; // Base score

    // Boost for academic domain
    if (task.domain === 'academic') score += 0.3;

    // Boost for research-type tasks
    if (['research_synthesis', 'literature_review', 'citation_analysis'].includes(task.type)) {
      score += 0.4;
    }

    // Boost for recognized sources
    const recognizedSources = task.sources?.filter(source =>
      this.specialization.some(domain => source.includes(domain))
    ).length || 0;
    score += recognizedSources * 0.1;

    return Math.min(score, 1.0);
  }

  async executeTask(task: Task, context: AgentContext): Promise<AgentResult> {
    const processedTask = await this.preProcess(task);

    try {
      // Academic-specific processing
      const papers = await this.findRelevantPapers(processedTask.query);
      const citationNetwork = await this.buildCitationNetwork(papers);
      const qualityAssessment = await this.assessPaperQuality(papers);

      const claims = await this.extractAcademicClaims(papers);
      const evidence = await this.buildEvidenceChain(citationNetwork, qualityAssessment);

      const result: AgentResult = {
        success: true,
        data: {
          claims,
          evidence,
          papers: papers.map(p => p.metadata),
          citationMetrics: citationNetwork.metrics
        },
        confidence: this.calculateAcademicConfidence(qualityAssessment),
        processingTime: Date.now() - processedTask.timestamp,
        metadata: {
          totalPapers: papers.length,
          avgCitationCount: citationNetwork.avgCitations,
          peerReviewedRatio: qualityAssessment.peerReviewedRatio
        }
      };

      return await this.postProcess(result);

    } catch (error) {
      return await this.postProcess({
        success: false,
        error: error.message,
        confidence: 0,
        processingTime: Date.now() - processedTask.timestamp,
        data: null,
        metadata: { error: true }
      });
    }
  }

  private async findRelevantPapers(query: string): Promise<AcademicPaper[]> {
    // Use multiple academic search engines
    const searchPromises = [
      this.searchArxiv(query),
      this.searchPubMed(query),
      this.searchGoogleScholar(query),
      this.searchIEEE(query)
    ];

    const searchResults = await Promise.allSettled(searchPromises);

    // Combine and deduplicate results
    const allPapers = searchResults
      .filter(result => result.status === 'fulfilled')
      .flatMap(result => (result as PromiseFulfilledResult<AcademicPaper[]>).value);

    return this.deduplicateByDOI(allPapers)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 50); // Top 50 most relevant papers
  }
}
```

#### E3: Collective Memory System

**Interface Definition**:
```typescript
interface CollectiveMemorySystem {
  store(knowledge: Knowledge): Promise<void>;
  retrieve(query: KnowledgeQuery): Promise<Knowledge[]>;
  update(knowledge: Knowledge): Promise<void>;
  consolidate(): Promise<ConsolidationResult>;
}

interface Knowledge {
  id: string;
  content: any;
  type: 'fact' | 'pattern' | 'strategy' | 'relationship';
  domain: string;
  confidence: number;
  sources: string[];
  timestamp: number;
  agentId: string;
  validatedBy: string[];
}
```

### Performance Requirements

- **Task Decomposition**: < 1 second for complex queries
- **Agent Coordination**: < 5 seconds for task assignment
- **Concurrent Agents**: Support 50+ active agents
- **Memory Usage**: < 2GB for collective memory
- **Throughput**: 100+ tasks per minute across all agents

---

## Cross-Layer Communication

### Event Bus Architecture

**Interface Definition**:
```typescript
interface EventBus {
  publish<T>(event: Event<T>): Promise<void>;
  subscribe<T>(eventType: string, handler: EventHandler<T>): Subscription;
  unsubscribe(subscription: Subscription): void;
}

interface Event<T = any> {
  type: string;
  payload: T;
  timestamp: number;
  source: string;
  correlationId?: string;
}

interface EventHandler<T = any> {
  handle(event: Event<T>): Promise<void>;
}
```

**Implementation with Redis Pub/Sub**:
```typescript
class RedisEventBus implements EventBus {
  private redis: Redis;
  private subscriptions: Map<string, EventHandler[]> = new Map();

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async publish<T>(event: Event<T>): Promise<void> {
    const serialized = JSON.stringify(event);
    await this.redis.publish(`anno:events:${event.type}`, serialized);

    // Also handle local subscribers
    const handlers = this.subscriptions.get(event.type) || [];
    await Promise.all(handlers.map(handler => handler.handle(event)));
  }

  subscribe<T>(eventType: string, handler: EventHandler<T>): Subscription {
    const handlers = this.subscriptions.get(eventType) || [];
    handlers.push(handler);
    this.subscriptions.set(eventType, handlers);

    // Subscribe to Redis channel
    this.redis.subscribe(`anno:events:${eventType}`);

    return {
      eventType,
      handler,
      unsubscribe: () => this.unsubscribe({ eventType, handler })
    };
  }
}
```

### Performance Requirements

- **Event Latency**: < 10ms for local events, < 100ms for distributed
- **Throughput**: 10,000+ events per second
- **Memory Usage**: < 64MB for event bus
- **Reliability**: > 99.9% event delivery
- **Scalability**: Support for 100+ subscribers per event type

---

## System-Wide Performance Requirements

### Latency Requirements
```yaml
Response Times (95th percentile):
  - Simple queries: < 2 seconds
  - Complex research: < 30 seconds
  - Entity resolution: < 200ms
  - Content extraction: < 500ms
  - Knowledge graph queries: < 100ms

Processing Times:
  - Page distillation: < 1 second
  - Multi-agent coordination: < 5 seconds
  - Drift detection: < 200ms
  - Confidence calculation: < 100ms
```

### Throughput Requirements
```yaml
System Capacity:
  - Concurrent users: 1,000+
  - Pages per second: 100+
  - API calls per second: 500+
  - Agent tasks per minute: 100+

Database Performance:
  - Knowledge graph queries: 1,000+ QPS
  - Cache hit ratio: > 85%
  - Write throughput: 500+ writes/sec
```

### Resource Requirements
```yaml
Memory Usage:
  - Core system: < 2GB per instance
  - Agent processes: < 512MB per agent
  - Knowledge graph: < 4GB for 10M entities
  - Cache system: < 8GB for hot data

CPU Usage:
  - Average utilization: < 60%
  - Peak utilization: < 85%
  - Multi-core scaling: Linear up to 16 cores

Storage:
  - Knowledge graph: 100GB for 50M facts
  - Content cache: 500GB for 1M pages
  - Logs and metrics: 10GB per month
```

### Availability Requirements
```yaml
Service Level Objectives:
  - System uptime: 99.9%
  - Data durability: 99.999%
  - Response time SLA: 95% under 2 seconds
  - Error rate: < 0.1%

Recovery Requirements:
  - Recovery Time Objective (RTO): 15 minutes
  - Recovery Point Objective (RPO): 5 minutes
  - Backup frequency: Every 6 hours
  - Cross-region replication: < 1 second
```

This technical specification provides the foundation for implementing a production-ready Anno system that meets the performance and reliability requirements for AI-native web browsing.