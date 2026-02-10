/**
 * Anno TypeScript SDK
 *
 * Official TypeScript client for the Anno API
 */

// Types
export interface AnnoConfig {
  /** API endpoint URL */
  endpoint: string;

  /** API key for authentication */
  apiKey?: string;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Custom headers */
  headers?: Record<string, string>;
}

export interface FetchOptions {
  /** Whether to use cached content */
  useCache?: boolean;

  /** Maximum nodes to extract */
  maxNodes?: number;

  /** Use Playwright rendering */
  render?: boolean;
}

export interface BatchFetchOptions extends FetchOptions {
  /** Number of parallel requests */
  parallel?: number;
}

export interface StreamEvent {
  type: 'metadata' | 'node' | 'confidence' | 'provenance' | 'done' | 'error';
  payload: Record<string, unknown>;
}

export interface MetadataEvent extends StreamEvent {
  type: 'metadata';
  payload: {
    url: string;
    finalUrl: string;
    status: number;
    contentType: string | null;
    fetchTimestamp: number;
    durationMs: number;
    fromCache: boolean;
    rendered: boolean;
  };
}

export interface NodeEvent extends StreamEvent {
  type: 'node';
  payload: {
    tag: string;
    text: string;
    confidence?: number;
    sourceSpans?: Array<{ start: number; end: number }>;
  };
}

export interface ConfidenceEvent extends StreamEvent {
  type: 'confidence';
  payload: {
    overallConfidence: number;
    heuristics?: Record<string, unknown>;
  };
}

export interface ProvenanceEvent extends StreamEvent {
  type: 'provenance';
  payload: {
    contentHash: string;
    algorithm: string;
    verificationUrl?: string;
  };
}

export interface DoneEvent extends StreamEvent {
  type: 'done';
  payload: {
    reason?: string;
    nodes: number;
  };
}

export interface ErrorEvent extends StreamEvent {
  type: 'error';
  payload: {
    message: string;
    code?: string;
  };
}

export interface FetchResult {
  metadata: MetadataEvent['payload'];
  nodes: NodeEvent['payload'][];
  confidence: ConfidenceEvent['payload'];
  provenance?: ProvenanceEvent['payload'];
}

export interface SemanticSearchOptions {
  /** Number of results to return */
  k?: number;

  /** Optional session ID for context */
  sessionId?: string;
}

export interface SemanticSearchResult {
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version?: string;
  uptime?: number;
  metrics?: Record<string, unknown>;
}

// Main client
export class AnnoClient {
  private readonly config: Required<AnnoConfig>;

  constructor(config: AnnoConfig) {
    this.config = {
      endpoint: config.endpoint,
      apiKey: config.apiKey || '',
      timeout: config.timeout || 30000,
      headers: config.headers || {},
    };
  }

  /**
   * Fetch and distill a URL
   *
   * @example
   * ```typescript
   * const result = await client.fetch('https://example.com/article');
   * console.log(result.nodes);
   * ```
   */
  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const events: StreamEvent[] = [];

    for await (const event of this.fetchStream(url, options)) {
      events.push(event);
    }

    return this.assembleResult(events);
  }

  /**
   * Fetch a URL as a stream of events
   *
   * @example
   * ```typescript
   * for await (const event of client.fetchStream('https://example.com')) {
   *   if (event.type === 'node') {
   *     console.log(event.payload.text);
   *   }
   * }
   * ```
   */
  async *fetchStream(url: string, options: FetchOptions = {}): AsyncGenerator<StreamEvent> {
    const response = await this.request('/v1/content/fetch', {
      method: 'POST',
      body: JSON.stringify({ url, options }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new AnnoError(error.message || 'Request failed', response.status, error.error);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AnnoError('No response body', 500);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as StreamEvent;
              yield event;
            } catch (e) {
              console.error('Failed to parse event:', line, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Batch fetch multiple URLs
   *
   * @example
   * ```typescript
   * const urls = ['https://example.com/1', 'https://example.com/2'];
   * const results = await client.batchFetch(urls);
   * ```
   */
  async batchFetch(urls: string[], options: BatchFetchOptions = {}): Promise<FetchResult[]> {
    const results = new Map<string, StreamEvent[]>();

    for await (const event of this.batchFetchStream(urls, options)) {
      if ((event as any).type === 'source_event') {
        const { url, event: sourceEvent } = (event as any).payload as { url: string; event: StreamEvent };
        if (!results.has(url)) {
          results.set(url, []);
        }
        results.get(url)!.push(sourceEvent);
      }
    }

    return Array.from(results.values()).map(events => this.assembleResult(events));
  }

  /**
   * Batch fetch as a stream
   */
  async *batchFetchStream(urls: string[], options: BatchFetchOptions = {}): AsyncGenerator<StreamEvent> {
    const response = await this.request('/v1/content/batch-fetch', {
      method: 'POST',
      body: JSON.stringify({ urls, options }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new AnnoError(error.message || 'Request failed', response.status, error.error);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new AnnoError('No response body', 500);
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as StreamEvent;
              yield event;
            } catch (e) {
              console.error('Failed to parse event:', line, e);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Semantic search across cached content
   *
   * @example
   * ```typescript
   * const results = await client.search('machine learning', { k: 5 });
   * ```
   */
  async search(query: string, options: SemanticSearchOptions = {}): Promise<SemanticSearchResult[]> {
    const response = await this.request('/v1/semantic/search', {
      method: 'POST',
      body: JSON.stringify({ query, ...options }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new AnnoError(error.message || 'Search failed', response.status, error.error);
    }

    const data = await response.json();
    return data.results;
  }

  /**
   * Check API health
   */
  async health(): Promise<HealthResponse> {
    const response = await this.request('/health', { method: 'GET' });

    if (!response.ok) {
      throw new AnnoError('Health check failed', response.status);
    }

    return response.json();
  }

  /**
   * Make a request to the Anno API
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.config.endpoint}${path}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    if (this.config.apiKey) {
      headers['X-API-Key'] = this.config.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: controller.signal,
      });

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new AnnoError('Request timeout', 408);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Assemble stream events into a result object
   */
  private assembleResult(events: StreamEvent[]): FetchResult {
    let metadata: MetadataEvent['payload'] | null = null;
    const nodes: NodeEvent['payload'][] = [];
    let confidence: ConfidenceEvent['payload'] | null = null;
    let provenance: ProvenanceEvent['payload'] | undefined;

    for (const event of events) {
      switch (event.type) {
        case 'metadata':
          metadata = event.payload as MetadataEvent['payload'];
          break;
        case 'node':
          nodes.push(event.payload as NodeEvent['payload']);
          break;
        case 'confidence':
          confidence = event.payload as ConfidenceEvent['payload'];
          break;
        case 'provenance':
          provenance = event.payload as ProvenanceEvent['payload'];
          break;
        case 'error':
          throw new AnnoError(
            (event.payload as ErrorEvent['payload']).message,
            500,
            (event.payload as ErrorEvent['payload']).code
          );
      }
    }

    if (!metadata || !confidence) {
      throw new AnnoError('Incomplete response', 500);
    }

    return {
      metadata,
      nodes,
      confidence,
      provenance,
    };
  }
}

// Error class
export class AnnoError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'AnnoError';
  }
}

// Re-export for convenience
export default AnnoClient;
