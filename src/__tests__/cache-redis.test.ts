import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock redis and logger before importing
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Track event handlers registered on the mock client
const eventHandlers: Map<string, (...args: unknown[]) => unknown> = new Map();

const mockRedisClient = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    eventHandlers.set(event, handler);
    return mockRedisClient;
  }),
  connect: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  set: vi.fn(),
  exists: vi.fn(),
  del: vi.fn(),
  flushDb: vi.fn(),
  quit: vi.fn().mockResolvedValue(undefined),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockRedisClient),
}));

import { RedisCacheAdapter } from '../services/cache-redis';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  mockRedisClient.connect.mockResolvedValue(undefined);
  mockRedisClient.get.mockReset();
  mockRedisClient.set.mockReset();
  mockRedisClient.exists.mockReset();
  mockRedisClient.del.mockReset();
  mockRedisClient.flushDb.mockReset();
  mockRedisClient.quit.mockResolvedValue(undefined);
});

/**
 * Create an adapter and simulate a successful Redis connection.
 */
function createConnectedAdapter(ttl = 60000): RedisCacheAdapter {
  const adapter = new RedisCacheAdapter({ enabled: true, ttl, url: 'redis://localhost:6379' });

  // Simulate the 'connect' event firing
  const connectHandler = eventHandlers.get('connect');
  if (connectHandler) connectHandler();

  return adapter;
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('RedisCacheAdapter constructor', () => {
  it('does not connect when disabled', () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });

    expect(mockRedisClient.connect).not.toHaveBeenCalled();
    expect(adapter.isReady()).toBe(false);
  });

  it('connects when enabled', () => {
    new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    expect(mockRedisClient.connect).toHaveBeenCalled();
  });

  it('registers event handlers on the client', () => {
    new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    expect(mockRedisClient.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mockRedisClient.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(mockRedisClient.on).toHaveBeenCalledWith('ready', expect.any(Function));
    expect(mockRedisClient.on).toHaveBeenCalledWith('reconnecting', expect.any(Function));
  });

  it('handles connection failure gracefully', async () => {
    mockRedisClient.connect.mockRejectedValueOnce(new Error('Connection refused'));

    new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    // Wait for the async connect to settle
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to connect'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

describe('RedisCacheAdapter event handlers', () => {
  it('sets isConnected on "connect" event', () => {
    const adapter = new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    const connectHandler = eventHandlers.get('connect');
    expect(connectHandler).toBeDefined();
    connectHandler!();

    expect(adapter.isReady()).toBe(true);
  });

  it('clears isConnected on "error" event', () => {
    const adapter = createConnectedAdapter();
    expect(adapter.isReady()).toBe(true);

    const errorHandler = eventHandlers.get('error');
    errorHandler!(new Error('Redis connection lost'));

    expect(adapter.isReady()).toBe(false);
  });

  it('logs on "ready" event', () => {
    new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    const readyHandler = eventHandlers.get('ready');
    readyHandler!();

    expect(logger.info).toHaveBeenCalledWith('Redis: Client ready');
  });

  it('increments reconnectAttempts on "reconnecting" event', () => {
    const adapter = new RedisCacheAdapter({ enabled: true, ttl: 60000 });

    const reconnectHandler = eventHandlers.get('reconnecting');
    reconnectHandler!();
    reconnectHandler!();

    const status = adapter.getStatus();
    expect(status.reconnectAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('get()', () => {
  it('returns undefined when not connected', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    const result = await adapter.get('key1');
    expect(result).toBeUndefined();
  });

  it('returns undefined when key does not exist', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.get.mockResolvedValue(null);

    const result = await adapter.get('missing-key');
    expect(result).toBeUndefined();
  });

  it('returns parsed CacheEntry when key exists', async () => {
    const adapter = createConnectedAdapter();
    const entry = { value: { data: 'hello' }, insertedAt: Date.now() };
    mockRedisClient.get.mockResolvedValue(JSON.stringify(entry));

    const result = await adapter.get('existing-key');
    expect(result).toEqual(entry);
    expect(result!.value).toEqual({ data: 'hello' });
  });

  it('returns undefined and logs error on Redis failure', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.get.mockRejectedValue(new Error('Read timeout'));

    const result = await adapter.get('key');
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get key'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// set()
// ---------------------------------------------------------------------------

describe('set()', () => {
  it('does nothing when not connected', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    await adapter.set('key', 'value');
    expect(mockRedisClient.set).not.toHaveBeenCalled();
  });

  it('stores value with TTL in seconds', async () => {
    const adapter = createConnectedAdapter(120000); // 120s TTL
    mockRedisClient.set.mockResolvedValue('OK');

    await adapter.set('my-key', { data: 'test' });

    expect(mockRedisClient.set).toHaveBeenCalledWith(
      'my-key',
      expect.any(String),
      { EX: 120 }
    );

    // Verify the stored JSON contains value and insertedAt
    const storedJson = mockRedisClient.set.mock.calls[0][1];
    const parsed = JSON.parse(storedJson);
    expect(parsed.value).toEqual({ data: 'test' });
    expect(parsed.insertedAt).toBeTypeOf('number');
  });

  it('logs error on Redis failure', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.set.mockRejectedValue(new Error('Write failed'));

    await adapter.set('key', 'value');

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to set key'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// has()
// ---------------------------------------------------------------------------

describe('has()', () => {
  it('returns false when not connected', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    const result = await adapter.has('key');
    expect(result).toBe(false);
  });

  it('returns true when key exists', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.exists.mockResolvedValue(1);

    const result = await adapter.has('existing');
    expect(result).toBe(true);
  });

  it('returns false when key does not exist', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.exists.mockResolvedValue(0);

    const result = await adapter.has('missing');
    expect(result).toBe(false);
  });

  it('returns false and logs error on Redis failure', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.exists.mockRejectedValue(new Error('Check failed'));

    const result = await adapter.has('key');
    expect(result).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to check key'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe('delete()', () => {
  it('does nothing when not connected', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    await adapter.delete('key');
    expect(mockRedisClient.del).not.toHaveBeenCalled();
  });

  it('deletes the key from Redis', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.del.mockResolvedValue(1);

    await adapter.delete('remove-me');
    expect(mockRedisClient.del).toHaveBeenCalledWith('remove-me');
  });

  it('logs error on Redis failure', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.del.mockRejectedValue(new Error('Delete failed'));

    await adapter.delete('key');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete key'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('clear()', () => {
  it('does nothing when not connected', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    await adapter.clear();
    expect(mockRedisClient.flushDb).not.toHaveBeenCalled();
  });

  it('flushes the database', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.flushDb.mockResolvedValue('OK');

    await adapter.clear();
    expect(mockRedisClient.flushDb).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Redis: Cache cleared');
  });

  it('logs error on Redis failure', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.flushDb.mockRejectedValue(new Error('Flush failed'));

    await adapter.clear();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clear cache'),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// disconnect()
// ---------------------------------------------------------------------------

describe('disconnect()', () => {
  it('does nothing when client is null (disabled)', async () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });
    await adapter.disconnect();
    expect(mockRedisClient.quit).not.toHaveBeenCalled();
  });

  it('quits the client gracefully', async () => {
    const adapter = createConnectedAdapter();
    await adapter.disconnect();

    expect(mockRedisClient.quit).toHaveBeenCalled();
    expect(adapter.isReady()).toBe(false);
  });

  it('logs error if quit fails', async () => {
    const adapter = createConnectedAdapter();
    mockRedisClient.quit.mockRejectedValueOnce(new Error('Quit failed'));

    await adapter.disconnect();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error during disconnect'),
      expect.anything()
    );
    expect(adapter.isReady()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getStatus() / isReady()
// ---------------------------------------------------------------------------

describe('getStatus() and isReady()', () => {
  it('returns disconnected status for disabled adapter', () => {
    const adapter = new RedisCacheAdapter({ enabled: false, ttl: 60000 });

    expect(adapter.isReady()).toBe(false);
    expect(adapter.getStatus()).toEqual({
      connected: false,
      reconnectAttempts: 0,
    });
  });

  it('returns connected status after connect event', () => {
    const adapter = createConnectedAdapter();

    expect(adapter.isReady()).toBe(true);
    expect(adapter.getStatus()).toEqual({
      connected: true,
      reconnectAttempts: 0,
    });
  });
});
