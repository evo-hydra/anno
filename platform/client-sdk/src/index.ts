/**
 * Anno Enterprise Platform Client SDK
 * Future-Proof, Modular, Dynamic, and Consistent API client
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import WebSocket from 'ws';

// Types and Interfaces
export interface AnnoConfig {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  debug?: boolean;
}

export interface FetchRequest {
  url: string;
  options?: {
    render?: boolean;
    maxNodes?: number;
    useCache?: boolean;
    timeout?: number;
    userAgent?: string;
    headers?: Record<string, string>;
  };
}

export interface FetchResponse {
  url: string;
  title?: string;
  excerpt?: string;
  nodes: SemanticNode[];
  metadata?: Record<string, any>;
  confidence: number;
  processingTime: number;
  fromCache: boolean;
}

export interface SemanticNode {
  id: string;
  text: string;
  type: string;
  confidence: number;
  metadata?: Record<string, any>;
}

export interface BatchFetchRequest {
  urls: string[];
  options?: {
    render?: boolean;
    maxNodes?: number;
    useCache?: boolean;
    parallel?: number;
  };
}

export interface BatchFetchResponse {
  results: Array<{
    url: string;
    success: boolean;
    data?: FetchResponse;
    error?: string;
  }>;
  totalUrls: number;
  successfulUrls: number;
  failedUrls: number;
  processingTime: number;
}

export interface TenantInfo {
  id: string;
  name: string;
  plan: string;
  limits: {
    requestsPerMinute: number;
    requestsPerDay: number;
    concurrentRequests: number;
  };
  usage: {
    requestsPerMinute: number;
    requestsPerDay: number;
    concurrentRequests: number;
  };
}

export interface UsageStats {
  requestsPerMinute: number;
  requestsPerDay: number;
  requestsPerMonth: number;
  storageUsedGB: number;
  limits: {
    requestsPerMinute: number;
    requestsPerDay: number;
    requestsPerMonth: number;
    storageQuotaGB: number;
  };
}

export interface WebSocketMessage {
  type: 'progress' | 'data' | 'error' | 'complete';
  payload: any;
}

export class AnnoError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: any
  ) {
    super(message);
    this.name = 'AnnoError';
  }
}

export class RateLimitError extends AnnoError {
  constructor(
    message: string,
    public retryAfter?: number,
    response?: any
  ) {
    super(message, 429, response);
    this.name = 'RateLimitError';
  }
}

export class AuthenticationError extends AnnoError {
  constructor(message: string = 'Invalid or missing API key', response?: any) {
    super(message, 401, response);
    this.name = 'AuthenticationError';
  }
}

/**
 * Main Anno Enterprise Platform Client
 */
export class AnnoClient {
  private http: AxiosInstance;
  private ws?: WebSocket;
  private config: Required<AnnoConfig>;

  constructor(config: AnnoConfig) {
    this.config = {
      baseURL: 'https://api.anno.ai',
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      debug: false,
      ...config
    };

    this.http = axios.create({
      baseURL: this.config.baseURL,
      timeout: this.config.timeout,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Anno-Platform-Client/1.0.0'
      }
    });

    this.setupInterceptors();
  }

  /**
   * Fetch and extract content from a single URL
   */
  async fetch(request: FetchRequest): Promise<FetchResponse> {
    try {
      const response = await this.http.post('/v1/content/fetch', {
        url: request.url,
        options: request.options
      });

      return this.parseFetchResponse(response.data);
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Fetch content from multiple URLs in parallel
   */
  async batchFetch(request: BatchFetchRequest): Promise<BatchFetchResponse> {
    try {
      const response = await this.http.post('/v1/content/batch-fetch', {
        urls: request.urls,
        options: request.options
      });

      return this.parseBatchResponse(response.data);
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Stream content processing with real-time updates
   */
  async streamFetch(
    request: FetchRequest,
    onProgress?: (data: WebSocketMessage) => void
  ): Promise<FetchResponse> {
    return new Promise((resolve, reject) => {
      try {
        const wsUrl = this.config.baseURL.replace('https://', 'wss://').replace('http://', 'ws://');
        this.ws = new WebSocket(`${wsUrl}/v1/content/stream`, {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`
          }
        });

        let result: FetchResponse | null = null;
        const nodes: SemanticNode[] = [];

        this.ws.on('open', () => {
          this.ws!.send(JSON.stringify({
            url: request.url,
            options: request.options
          }));
        });

        this.ws.on('message', (data) => {
          try {
            const message: WebSocketMessage = JSON.parse(data.toString());
            
            if (onProgress) {
              onProgress(message);
            }

            switch (message.type) {
              case 'data':
                if (message.payload.type === 'node') {
                  nodes.push(message.payload);
                }
                break;
              case 'complete':
                result = {
                  url: request.url,
                  title: message.payload.title,
                  excerpt: message.payload.excerpt,
                  nodes,
                  metadata: message.payload.metadata,
                  confidence: message.payload.confidence,
                  processingTime: message.payload.processingTime,
                  fromCache: message.payload.fromCache
                };
                this.ws!.close();
                resolve(result);
                break;
              case 'error':
                this.ws!.close();
                reject(new AnnoError(message.payload.message));
                break;
            }
          } catch (error) {
            reject(new AnnoError('Failed to parse WebSocket message'));
          }
        });

        this.ws.on('error', (error) => {
          reject(new AnnoError(`WebSocket error: ${error.message}`));
        });

        this.ws.on('close', () => {
          if (!result) {
            reject(new AnnoError('WebSocket connection closed unexpectedly'));
          }
        });

      } catch (error) {
        reject(this.handleError(error));
      }
    });
  }

  /**
   * Get current tenant information and usage
   */
  async getTenantInfo(): Promise<TenantInfo> {
    try {
      const response = await this.http.get('/v1/tenant/info');
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Get detailed usage statistics
   */
  async getUsageStats(period: 'day' | 'week' | 'month' = 'day'): Promise<UsageStats> {
    try {
      const response = await this.http.get(`/v1/tenant/usage?period=${period}`);
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Health check for the API
   */
  async healthCheck(): Promise<{ status: string; timestamp: number; version: string }> {
    try {
      const response = await this.http.get('/health');
      return response.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Close WebSocket connections
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  // Private helper methods

  private setupInterceptors(): void {
    // Request interceptor for debugging
    if (this.config.debug) {
      this.http.interceptors.request.use((config) => {
        console.log(`[Anno Client] ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      });
    }

    // Response interceptor for error handling and retries
    this.http.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 429) {
          const retryAfter = error.response.headers['retry-after'];
          throw new RateLimitError(
            'Rate limit exceeded',
            retryAfter ? parseInt(retryAfter) : undefined,
            error.response
          );
        }

        if (error.response?.status === 401) {
          throw new AuthenticationError(undefined, error.response);
        }

        // Retry logic for transient errors
        if (this.shouldRetry(error) && this.config.retries > 0) {
          await this.delay(this.config.retryDelay);
          this.config.retries--;
          return this.http.request(error.config);
        }

        throw error;
      }
    );
  }

  private shouldRetry(error: any): boolean {
    return (
      !error.response ||
      (error.response.status >= 500 && error.response.status < 600) ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT'
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private handleError(error: any): AnnoError {
    if (error instanceof AnnoError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const message = error.response?.data?.message || error.message;

      switch (statusCode) {
        case 401:
          return new AuthenticationError(message, error.response);
        case 429:
          return new RateLimitError(message, undefined, error.response);
        default:
          return new AnnoError(message, statusCode, error.response);
      }
    }

    return new AnnoError(error.message || 'Unknown error occurred');
  }

  private parseFetchResponse(data: any): FetchResponse {
    // Handle both streaming and direct responses
    if (Array.isArray(data)) {
      // Streaming response (JSONL)
      const nodes: SemanticNode[] = [];
      let metadata: any = {};
      let confidence = 0;

      for (const line of data) {
        if (line.type === 'node') {
          nodes.push(line.payload);
        } else if (line.type === 'metadata') {
          metadata = line.payload;
        } else if (line.type === 'confidence') {
          confidence = line.payload.overallConfidence;
        }
      }

      return {
        url: metadata.url || '',
        title: metadata.title,
        excerpt: metadata.excerpt,
        nodes,
        metadata,
        confidence,
        processingTime: 0, // Will be updated from response
        fromCache: false
      };
    }

    // Direct response
    return {
      url: data.url,
      title: data.title,
      excerpt: data.excerpt,
      nodes: data.nodes || [],
      metadata: data.metadata,
      confidence: data.confidence || 0,
      processingTime: data.processingTime || 0,
      fromCache: data.fromCache || false
    };
  }

  private parseBatchResponse(data: any): BatchFetchResponse {
    return {
      results: data.results || [],
      totalUrls: data.totalUrls || 0,
      successfulUrls: data.successfulUrls || 0,
      failedUrls: data.failedUrls || 0,
      processingTime: data.processingTime || 0
    };
  }
}

// Utility functions

/**
 * Create a new Anno client instance
 */
export function createClient(config: AnnoConfig): AnnoClient {
  return new AnnoClient(config);
}

/**
 * Validate API key format
 */
export function validateApiKey(apiKey: string): boolean {
  return /^anno_[a-zA-Z0-9]{40,}$/.test(apiKey);
}

/**
 * Extract tenant ID from API key
 */
export function extractTenantId(apiKey: string): string | null {
  // This is a placeholder - actual implementation would depend on your key format
  const match = apiKey.match(/^anno_([a-z0-9]+)_/);
  return match ? match[1] : null;
}

// Export everything
export * from './types';
export default AnnoClient;
