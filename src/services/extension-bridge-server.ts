/**
 * Extension Bridge Server
 *
 * Local HTTP server that receives data from the Anno browser extension.
 * Handles authentication, data normalization, and queuing for processing.
 *
 * @module services/extension-bridge-server
 * @see docs/specs/FUTURE_PROOF_DATA_ARCHITECTURE.md Phase 3
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface BridgeServerConfig {
  port: number;
  host: string;
  authToken?: string;
  allowedOrigins: string[];
  maxPayloadSize: number;
}

export interface CapturedData {
  id: string;
  marketplace: 'amazon' | 'ebay' | 'walmart' | 'etsy';
  dataType: 'orders' | 'purchases' | 'listings' | 'searches';
  items: unknown[];
  pageUrl?: string;
  capturedAt: string;
  extensionVersion: string;
  receivedAt: string;
}

export interface BridgeServerEvents {
  data: (data: CapturedData) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

// ============================================================================
// Extension Bridge Server
// ============================================================================

export class ExtensionBridgeServer extends EventEmitter {
  private server: http.Server | null = null;
  private config: BridgeServerConfig;
  private capturedData: CapturedData[] = [];
  private isRunning = false;

  constructor(config: Partial<BridgeServerConfig> = {}) {
    super();
    this.config = {
      port: config.port ?? 3847,
      host: config.host ?? '127.0.0.1',
      authToken: config.authToken ?? this.generateToken(),
      allowedOrigins: config.allowedOrigins ?? [
        'chrome-extension://*',
        'moz-extension://*',
      ],
      maxPayloadSize: config.maxPayloadSize ?? 10 * 1024 * 1024, // 10MB
    };
  }

  // =========================================================================
  // Server Lifecycle
  // =========================================================================

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Bridge server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (error) => {
        logger.error('Bridge server error', { error: error.message });
        this.emit('error', error);
        reject(error);
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        logger.info('Extension bridge server started', {
          host: this.config.host,
          port: this.config.port,
        });
        this.emit('connected');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false;
        this.server = null;
        logger.info('Extension bridge server stopped');
        this.emit('disconnected');
        resolve();
      });
    });
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getAuthToken(): string {
    return this.config.authToken!;
  }

  getPort(): number {
    return this.config.port;
  }

  // =========================================================================
  // Request Handling
  // =========================================================================

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Set CORS headers
    this.setCorsHeaders(req, res);

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      switch (path) {
        case '/api/extension/status':
          this.handleStatus(req, res);
          break;

        case '/api/extension/submit':
          await this.handleSubmit(req, res);
          break;

        case '/api/extension/auth':
          this.handleAuth(req, res);
          break;

        case '/api/extension/data':
          this.handleGetData(req, res);
          break;

        default:
          this.sendJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      logger.error('Request handler error', {
        path,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      this.sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  private handleStatus(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    this.sendJson(res, 200, {
      status: 'ok',
      version: '1.0.0',
      uptime: process.uptime(),
      capturedCount: this.capturedData.length,
    });
  }

  private async handleSubmit(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Verify auth
    if (!this.verifyAuth(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Verify method
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    // Parse body
    const body = await this.parseBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // Validate payload
    if (!this.validatePayload(body)) {
      this.sendJson(res, 400, { error: 'Invalid payload structure' });
      return;
    }

    // Create captured data record
    const capturedData: CapturedData = {
      id: this.generateId(),
      marketplace: body.marketplace as CapturedData['marketplace'],
      dataType: body.dataType as CapturedData['dataType'],
      items: body.items as unknown[],
      pageUrl: body.pageUrl as string | undefined,
      capturedAt: body.capturedAt as string,
      extensionVersion: body.extensionVersion as string,
      receivedAt: new Date().toISOString(),
    };

    this.capturedData.push(capturedData);

    // Emit event for listeners
    this.emit('data', capturedData);

    logger.info('Received captured data', {
      id: capturedData.id,
      marketplace: capturedData.marketplace,
      itemCount: capturedData.items.length,
    });

    this.sendJson(res, 200, {
      success: true,
      id: capturedData.id,
      itemsReceived: capturedData.items.length,
    });
  }

  private handleAuth(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    // For now, return a display-only token that can be copied
    // In production, this should have proper authentication flow
    this.sendJson(res, 200, {
      token: this.config.authToken,
      instructions: 'Copy this token and paste it in the extension settings',
    });
  }

  private handleGetData(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    if (!this.verifyAuth(req)) {
      this.sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const marketplace = url.searchParams.get('marketplace');
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);

    let data = this.capturedData;

    if (marketplace) {
      data = data.filter((d) => d.marketplace === marketplace);
    }

    data = data.slice(-limit);

    this.sendJson(res, 200, {
      data,
      total: data.length,
    });
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  private setCorsHeaders(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const origin = req.headers.origin;

    // Allow extension origins
    if (origin && this.isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      // Also allow localhost for testing
      res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  private isAllowedOrigin(origin: string): boolean {
    return this.config.allowedOrigins.some((pattern) => {
      if (pattern.includes('*')) {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*') + '$'
        );
        return regex.test(origin);
      }
      return pattern === origin;
    });
  }

  private verifyAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    const token = authHeader.replace('Bearer ', '');
    return token === this.config.authToken;
  }

  private async parseBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxPayloadSize) {
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });

      req.on('error', () => resolve(null));
    });
  }

  private validatePayload(body: Record<string, unknown>): boolean {
    const requiredFields = ['marketplace', 'dataType', 'items'];
    return requiredFields.every((field) => field in body);
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    data: unknown
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private generateId(): string {
    return `cap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  }

  // =========================================================================
  // Data Access
  // =========================================================================

  getCapturedData(): CapturedData[] {
    return [...this.capturedData];
  }

  getCapturedDataByMarketplace(marketplace: string): CapturedData[] {
    return this.capturedData.filter((d) => d.marketplace === marketplace);
  }

  clearCapturedData(): void {
    this.capturedData = [];
    logger.info('Cleared captured data');
  }

  popCapturedData(): CapturedData | undefined {
    return this.capturedData.shift();
  }

  getCapturedCount(): number {
    return this.capturedData.length;
  }
}

// ============================================================================
// Singleton & Factory
// ============================================================================

let bridgeServerInstance: ExtensionBridgeServer | null = null;

/**
 * Get or create the singleton bridge server instance
 */
export function getBridgeServer(
  config?: Partial<BridgeServerConfig>
): ExtensionBridgeServer {
  if (!bridgeServerInstance) {
    bridgeServerInstance = new ExtensionBridgeServer(config);
  }
  return bridgeServerInstance;
}

/**
 * Create a new bridge server instance (useful for testing)
 */
export function createBridgeServer(
  config?: Partial<BridgeServerConfig>
): ExtensionBridgeServer {
  return new ExtensionBridgeServer(config);
}
