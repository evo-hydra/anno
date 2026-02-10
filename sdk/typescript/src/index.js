"use strict";
/**
 * Anno TypeScript SDK
 *
 * Official TypeScript client for the Anno API
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnnoError = exports.AnnoClient = void 0;
// Main client
class AnnoClient {
    constructor(config) {
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
    async fetch(url, options = {}) {
        const events = [];
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
    async *fetchStream(url, options = {}) {
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
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const event = JSON.parse(line);
                            yield event;
                        }
                        catch (e) {
                            console.error('Failed to parse event:', line, e);
                        }
                    }
                }
            }
        }
        finally {
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
    async batchFetch(urls, options = {}) {
        const results = new Map();
        for await (const event of this.batchFetchStream(urls, options)) {
            if (event.type === 'source_event') {
                const { url, event: sourceEvent } = event.payload;
                if (!results.has(url)) {
                    results.set(url, []);
                }
                results.get(url).push(sourceEvent);
            }
        }
        return Array.from(results.values()).map(events => this.assembleResult(events));
    }
    /**
     * Batch fetch as a stream
     */
    async *batchFetchStream(urls, options = {}) {
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
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (line.trim()) {
                        try {
                            const event = JSON.parse(line);
                            yield event;
                        }
                        catch (e) {
                            console.error('Failed to parse event:', line, e);
                        }
                    }
                }
            }
        }
        finally {
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
    async search(query, options = {}) {
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
    async health() {
        const response = await this.request('/health', { method: 'GET' });
        if (!response.ok) {
            throw new AnnoError('Health check failed', response.status);
        }
        return response.json();
    }
    /**
     * Make a request to the Anno API
     */
    async request(path, init) {
        const url = `${this.config.endpoint}${path}`;
        const headers = {
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
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new AnnoError('Request timeout', 408);
            }
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Assemble stream events into a result object
     */
    assembleResult(events) {
        let metadata = null;
        const nodes = [];
        let confidence = null;
        let provenance;
        for (const event of events) {
            switch (event.type) {
                case 'metadata':
                    metadata = event.payload;
                    break;
                case 'node':
                    nodes.push(event.payload);
                    break;
                case 'confidence':
                    confidence = event.payload;
                    break;
                case 'provenance':
                    provenance = event.payload;
                    break;
                case 'error':
                    throw new AnnoError(event.payload.message, 500, event.payload.code);
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
exports.AnnoClient = AnnoClient;
// Error class
class AnnoError extends Error {
    constructor(message, statusCode, code) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.name = 'AnnoError';
    }
}
exports.AnnoError = AnnoError;
// Re-export for convenience
exports.default = AnnoClient;
