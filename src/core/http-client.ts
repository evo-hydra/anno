/**
 * Anno - AI-Native Web Browser
 * Copyright (c) 2025 Evolving Intelligence AI. All rights reserved.
 *
 * PROPRIETARY AND CONFIDENTIAL
 * This code is proprietary to Evolving Intelligence AI and may not be copied, modified,
 * or distributed without explicit written permission.
 *
 * HTTP Client with Protocol Negotiation
 *
 * Uses native fetch() with HTTP/2 support and graceful fallback to HTTP/1.1.
 * Future: Add QUIC/HTTP3 when Node.js support stabilizes.
 *
 * @module http-client
 */

import { logger, startSpan } from '../utils/logger';
import { config } from '../config/env';

export interface HttpClientOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface HttpClientResponse {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  protocol: string; // 'http/2', 'http/1.1', etc.
  durationMs: number;
  etag?: string;
  lastModified?: string;
  wasNotModified?: boolean; // True for 304 responses
}

export class HttpClient {
  private readonly defaultTimeout: number;
  private readonly userAgent: string;

  constructor(timeout?: number, userAgent?: string) {
    this.defaultTimeout = timeout || config.fetch.timeoutMs;
    this.userAgent = userAgent || config.fetch.userAgent;
  }

  /**
   * Make HTTP request with automatic protocol negotiation
   */
  async request(options: HttpClientOptions): Promise<HttpClientResponse> {
    const span = startSpan('http-client-request');
    const startTime = Date.now();

    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = this.defaultTimeout
    } = options;

    try {
      logger.debug('HTTP request starting', { url, method });

      // Build headers
      const requestHeaders = {
        'User-Agent': this.userAgent,
        ...headers
      };

      // Make request with timeout
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body,
        signal: AbortSignal.timeout(timeout),
        // Note: fetch() in Node 18+ automatically uses HTTP/2 when available
      });

      // Read response body (empty for 304)
      const responseBody = response.status === 304 ? '' : await response.text();
      const durationMs = Date.now() - startTime;

      // Extract protocol from response (Node fetch doesn't expose this directly)
      // We'll infer from headers or connection
      const protocol = this.detectProtocol(response.headers);

      // Convert headers to object
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Extract cache validation headers
      const etag = response.headers.get('etag') || undefined;
      const lastModified = response.headers.get('last-modified') || undefined;
      const wasNotModified = response.status === 304;

      logger.info('HTTP request complete', {
        url,
        status: response.status,
        protocol,
        durationMs,
        bodyLength: responseBody.length,
        etag: etag ? etag.slice(0, 16) : undefined,
        wasNotModified
      });

      span.end({ status: response.status, protocol, durationMs, wasNotModified });

      return {
        url,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        protocol,
        durationMs,
        etag,
        lastModified,
        wasNotModified
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (error instanceof Error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
          logger.error('HTTP request timeout', { url, timeout, durationMs });
          span.end({ error: 'timeout', durationMs });
          throw new Error(`Request timeout after ${timeout}ms: ${url}`);
        }

        logger.error('HTTP request failed', {
          url,
          error: error.message,
          durationMs
        });
        span.end({ error: error.message, durationMs });
        throw error;
      }

      logger.error('HTTP request failed with unknown error', { url, durationMs });
      span.end({ error: 'unknown', durationMs });
      throw new Error(`Request failed: ${url}`);
    }
  }

  /**
   * Detect HTTP protocol from response headers
   */
  private detectProtocol(headers: Headers): string {
    // Note: Native fetch doesn't expose protocol directly in Node.js
    // HTTP/2 pseudo-headers (:status, :method) are not accessible via Headers.has()
    // They cause errors when checked

    // We can check for alt-svc header which indicates HTTP/2 support
    const altSvc = headers.get('alt-svc');
    if (altSvc && altSvc.includes('h2')) {
      return 'http/2';
    }

    // Default assumption: HTTP/1.1
    // In practice, modern servers use HTTP/2 but Node fetch doesn't expose this
    return 'http/1.1';
  }

  /**
   * GET request helper
   */
  async get(url: string, headers?: Record<string, string>): Promise<HttpClientResponse> {
    return this.request({ url, method: 'GET', headers });
  }

  /**
   * POST request helper
   */
  async post(
    url: string,
    body: string,
    headers?: Record<string, string>
  ): Promise<HttpClientResponse> {
    return this.request({ url, method: 'POST', body, headers });
  }
}

// Global singleton
export const httpClient = new HttpClient();
