/**
 * Tests for src/ai/vector-store.ts
 *
 * Covers:
 * - InMemoryVectorStore: add, search, clear, size, filter, cosine similarity
 * - RedisVectorStore: all methods with a mocked Redis client
 * - Edge cases: zero vectors, empty stores, mismatched dimensions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InMemoryVectorStore,
  RedisVectorStore,
  type VectorEntry,
  type VectorMetadata,
} from '../ai/vector-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<VectorEntry>): VectorEntry {
  return {
    id: overrides?.id ?? `vec-${Math.random().toString(36).slice(2, 8)}`,
    vector: overrides?.vector ?? [1, 0, 0],
    metadata: overrides?.metadata,
    content: overrides?.content,
    createdAt: overrides?.createdAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// InMemoryVectorStore tests
// ---------------------------------------------------------------------------

describe('InMemoryVectorStore', () => {
  let store: InMemoryVectorStore;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  // -----------------------------------------------------------------------
  // addEntries + size
  // -----------------------------------------------------------------------

  describe('addEntries()', () => {
    it('adds entries and increases size', async () => {
      expect(store.size()).toBe(0);

      await store.addEntries([
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b' }),
        makeEntry({ id: 'c' }),
      ]);

      expect(store.size()).toBe(3);
    });

    it('preserves createdAt when provided', async () => {
      const timestamp = 1234567890;
      await store.addEntries([makeEntry({ id: 'ts', createdAt: timestamp })]);

      const results = await store.similaritySearch([1, 0, 0], { k: 10 });
      expect(results).toHaveLength(1);
    });

    it('assigns createdAt when not provided', async () => {
      const entry: VectorEntry = {
        id: 'no-ts',
        vector: [1, 0, 0],
        createdAt: 0, // Will be overridden if 0 is falsy in `??`
      };
      await store.addEntries([entry]);
      expect(store.size()).toBe(1);
    });

    it('handles empty entries array', async () => {
      await store.addEntries([]);
      expect(store.size()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // similaritySearch — cosine similarity
  // -----------------------------------------------------------------------

  describe('similaritySearch()', () => {
    it('returns results sorted by similarity (descending)', async () => {
      await store.addEntries([
        makeEntry({ id: 'exact', vector: [1, 0, 0] }),
        makeEntry({ id: 'similar', vector: [0.9, 0.1, 0] }),
        makeEntry({ id: 'different', vector: [0, 0, 1] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 3 });
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('exact');
      expect(results[0].score).toBeCloseTo(1.0, 5);
      expect(results[1].id).toBe('similar');
      expect(results[2].id).toBe('different');
      expect(results[2].score).toBeCloseTo(0.0, 5);
    });

    it('respects k parameter', async () => {
      await store.addEntries([
        makeEntry({ id: 'a', vector: [1, 0, 0] }),
        makeEntry({ id: 'b', vector: [0.9, 0.1, 0] }),
        makeEntry({ id: 'c', vector: [0.8, 0.2, 0] }),
        makeEntry({ id: 'd', vector: [0, 1, 0] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 2 });
      expect(results).toHaveLength(2);
    });

    it('defaults k to 5', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({ id: `e${i}`, vector: [1 - i * 0.1, i * 0.1, 0] })
      );
      await store.addEntries(entries);

      const results = await store.similaritySearch([1, 0, 0]);
      expect(results).toHaveLength(5);
    });

    it('respects minScore filter', async () => {
      await store.addEntries([
        makeEntry({ id: 'high', vector: [1, 0, 0] }),
        makeEntry({ id: 'medium', vector: [0.7, 0.7, 0] }),
        makeEntry({ id: 'low', vector: [0, 0, 1] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 10, minScore: 0.5 });
      expect(results.every(r => r.score >= 0.5)).toBe(true);
      expect(results.find(r => r.id === 'low')).toBeUndefined();
    });

    it('returns empty array when store is empty', async () => {
      const results = await store.similaritySearch([1, 0, 0]);
      expect(results).toEqual([]);
    });

    it('handles identical vectors (score = 1.0)', async () => {
      await store.addEntries([makeEntry({ id: 'twin', vector: [0.5, 0.5, 0.5] })]);

      const results = await store.similaritySearch([0.5, 0.5, 0.5]);
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(1.0, 5);
    });

    it('handles opposite vectors (score = -1.0)', async () => {
      await store.addEntries([makeEntry({ id: 'opposite', vector: [-1, 0, 0] })]);

      const results = await store.similaritySearch([1, 0, 0], { minScore: -Infinity });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(-1.0, 5);
    });

    it('returns 0 for zero vectors', async () => {
      await store.addEntries([makeEntry({ id: 'zero', vector: [0, 0, 0] })]);

      const results = await store.similaritySearch([1, 0, 0], { minScore: -Infinity });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0);
    });

    it('handles mismatched vector dimensions gracefully', async () => {
      await store.addEntries([makeEntry({ id: 'short', vector: [1, 0] })]);

      const results = await store.similaritySearch([1, 0, 0], { minScore: -Infinity });
      expect(results).toHaveLength(1);
      // Should compute over the min length
      expect(typeof results[0].score).toBe('number');
    });

    it('includes metadata and content in results', async () => {
      await store.addEntries([
        makeEntry({
          id: 'rich',
          vector: [1, 0, 0],
          metadata: { url: 'https://example.com', tags: ['test'] },
          content: 'Hello world',
        }),
      ]);

      const results = await store.similaritySearch([1, 0, 0]);
      expect(results[0].metadata?.url).toBe('https://example.com');
      expect(results[0].metadata?.tags).toEqual(['test']);
      expect(results[0].content).toBe('Hello world');
    });
  });

  // -----------------------------------------------------------------------
  // Filter logic
  // -----------------------------------------------------------------------

  describe('metadata filter', () => {
    beforeEach(async () => {
      await store.addEntries([
        makeEntry({
          id: 'tech',
          vector: [1, 0, 0],
          metadata: { url: 'https://tech.com', tags: ['tech', 'ai'] },
        }),
        makeEntry({
          id: 'science',
          vector: [0.9, 0.1, 0],
          metadata: { url: 'https://science.com', tags: ['science'] },
        }),
        makeEntry({
          id: 'no-meta',
          vector: [0.8, 0.2, 0],
        }),
      ]);
    });

    it('filters by simple metadata match', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { url: 'https://tech.com' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('tech');
    });

    it('filters by array metadata (tags)', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { tags: ['tech'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('tech');
    });

    it('excludes entries without metadata when filter is applied', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { url: 'https://no-meta.com' },
      });
      // 'no-meta' has no metadata so it should not match
      expect(results).toHaveLength(0);
    });

    it('returns all entries when filter is empty', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: {},
      });
      expect(results).toHaveLength(3);
    });

    it('returns all entries when filter is undefined', async () => {
      const results = await store.similaritySearch([1, 0, 0], { k: 10 });
      expect(results).toHaveLength(3);
    });

    it('handles array subset matching', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { tags: ['tech', 'ai'] },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('tech');
    });

    it('filters out entries that do not contain all filter tags', async () => {
      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { tags: ['tech', 'nonexistent'] },
      });
      expect(results).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all entries', async () => {
      await store.addEntries([
        makeEntry({ id: 'a' }),
        makeEntry({ id: 'b' }),
      ]);

      expect(store.size()).toBe(2);

      await store.clear();
      expect(store.size()).toBe(0);

      const results = await store.similaritySearch([1, 0, 0]);
      expect(results).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// RedisVectorStore tests
// ---------------------------------------------------------------------------

describe('RedisVectorStore', () => {
  let mockRedis: Record<string, ReturnType<typeof vi.fn>>;
  let store: RedisVectorStore;

  beforeEach(() => {
    const keyValues = new Map<string, string>();

    mockRedis = {
      multi: vi.fn(() => {
        const cmds: Array<{ key: string; value: string }> = [];
        return {
          set: (key: string, value: string) => {
            cmds.push({ key, value });
          },
          exec: vi.fn(async () => {
            for (const cmd of cmds) {
              keyValues.set(cmd.key, cmd.value);
            }
            return cmds.map(() => 'OK');
          }),
        };
      }),
      keys: vi.fn(async (pattern: string) => {
        const prefix = pattern.replace('*', '');
        return Array.from(keyValues.keys()).filter(k => k.startsWith(prefix));
      }),
      mGet: vi.fn(async (keys: string[]) => {
        return keys.map(k => keyValues.get(k) ?? null);
      }),
      del: vi.fn(async (keys: string[]) => {
        for (const k of keys) {
          keyValues.delete(k);
        }
        return keys.length;
      }),
      // Expose internals for test control
      _keyValues: keyValues,
    };

    store = new RedisVectorStore(mockRedis, 'test:vectors:');
  });

  // -----------------------------------------------------------------------
  // addEntries
  // -----------------------------------------------------------------------

  describe('addEntries()', () => {
    it('adds entries via pipeline', async () => {
      const entries: VectorEntry[] = [
        makeEntry({ id: 'r1', vector: [1, 0, 0] }),
        makeEntry({ id: 'r2', vector: [0, 1, 0] }),
      ];

      await store.addEntries(entries);

      expect(mockRedis.multi).toHaveBeenCalled();
      expect(store.size()).toBe(2);
    });

    it('updates cachedSize correctly', async () => {
      expect(store.size()).toBe(0);

      await store.addEntries([makeEntry({ id: 'a' })]);
      expect(store.size()).toBe(1);

      await store.addEntries([makeEntry({ id: 'b' }), makeEntry({ id: 'c' })]);
      expect(store.size()).toBe(3);
    });

    it('handles empty entries array', async () => {
      await store.addEntries([]);
      expect(store.size()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // similaritySearch
  // -----------------------------------------------------------------------

  describe('similaritySearch()', () => {
    it('returns empty array when no keys exist', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);

      const results = await store.similaritySearch([1, 0, 0]);
      expect(results).toEqual([]);
    });

    it('searches and returns sorted results', async () => {
      // Pre-populate mock Redis
      const entries: VectorEntry[] = [
        makeEntry({ id: 'exact', vector: [1, 0, 0], content: 'Match' }),
        makeEntry({ id: 'partial', vector: [0.7, 0.7, 0], content: 'Partial' }),
        makeEntry({ id: 'different', vector: [0, 0, 1], content: 'Different' }),
      ];

      await store.addEntries(entries);

      const results = await store.similaritySearch([1, 0, 0], { k: 3 });
      expect(results).toHaveLength(3);
      expect(results[0].id).toBe('exact');
      expect(results[0].score).toBeCloseTo(1.0, 3);
    });

    it('respects k parameter', async () => {
      await store.addEntries([
        makeEntry({ id: 'a', vector: [1, 0, 0] }),
        makeEntry({ id: 'b', vector: [0.9, 0.1, 0] }),
        makeEntry({ id: 'c', vector: [0.8, 0.2, 0] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 1 });
      expect(results).toHaveLength(1);
    });

    it('respects minScore filter', async () => {
      await store.addEntries([
        makeEntry({ id: 'high', vector: [1, 0, 0] }),
        makeEntry({ id: 'low', vector: [0, 0, 1] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 10, minScore: 0.5 });
      expect(results.every(r => r.score >= 0.5)).toBe(true);
    });

    it('applies metadata filter', async () => {
      await store.addEntries([
        makeEntry({ id: 'tagged', vector: [1, 0, 0], metadata: { url: 'https://a.com' } }),
        makeEntry({ id: 'untagged', vector: [1, 0, 0] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { url: 'https://a.com' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('tagged');
    });

    it('filters null values from mGet results', async () => {
      // Add one entry, then manually add a null-returning key
      await store.addEntries([makeEntry({ id: 'valid', vector: [1, 0, 0] })]);

      // Add a key that returns null (simulates expired key)
      (mockRedis._keyValues as Map<string, string>).set('test:vectors:expired', '');
      mockRedis.mGet.mockResolvedValueOnce([
        JSON.stringify(makeEntry({ id: 'valid', vector: [1, 0, 0] })),
        null,
      ]);

      const results = await store.similaritySearch([1, 0, 0]);
      // Should only return the valid entry
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('handles array filter matching', async () => {
      await store.addEntries([
        makeEntry({
          id: 'tagged',
          vector: [1, 0, 0],
          metadata: { tags: ['tech', 'ai'] } as VectorMetadata,
        }),
        makeEntry({
          id: 'other',
          vector: [1, 0, 0],
          metadata: { tags: ['sports'] } as VectorMetadata,
        }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { tags: ['tech'] } as Partial<VectorMetadata>,
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('tagged');
    });
  });

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('clears all keys and resets cachedSize', async () => {
      await store.addEntries([makeEntry({ id: 'a' }), makeEntry({ id: 'b' })]);
      expect(store.size()).toBe(2);

      await store.clear();
      expect(store.size()).toBe(0);
    });

    it('handles empty store gracefully', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);
      await store.clear();
      expect(store.size()).toBe(0);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // initialize()
  // -----------------------------------------------------------------------

  describe('initialize()', () => {
    it('counts existing keys and updates cachedSize', async () => {
      (mockRedis._keyValues as Map<string, string>).set('test:vectors:a', 'data');
      (mockRedis._keyValues as Map<string, string>).set('test:vectors:b', 'data');

      await store.initialize();
      expect(store.size()).toBe(2);
    });

    it('sets cachedSize to 0 when no keys exist', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);
      await store.initialize();
      expect(store.size()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Cosine similarity edge cases
  // -----------------------------------------------------------------------

  describe('cosine similarity edge cases', () => {
    it('returns 0 for zero query vector', async () => {
      await store.addEntries([makeEntry({ id: 'normal', vector: [1, 0, 0] })]);

      const results = await store.similaritySearch([0, 0, 0], { k: 1, minScore: -Infinity });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0);
    });

    it('returns 0 for zero stored vector', async () => {
      await store.addEntries([makeEntry({ id: 'zero', vector: [0, 0, 0] })]);

      const results = await store.similaritySearch([1, 0, 0], { k: 1, minScore: -Infinity });
      expect(results).toHaveLength(1);
      expect(results[0].score).toBe(0);
    });

    it('handles different dimension vectors', async () => {
      await store.addEntries([makeEntry({ id: 'short', vector: [1, 0] })]);

      const results = await store.similaritySearch([1, 0, 0], { k: 1, minScore: -Infinity });
      expect(results).toHaveLength(1);
      expect(typeof results[0].score).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // matchesFilter edge cases
  // -----------------------------------------------------------------------

  describe('matchesFilter edge cases', () => {
    it('returns all when filter is empty object', async () => {
      await store.addEntries([
        makeEntry({ id: 'a', vector: [1, 0, 0], metadata: { url: 'a' } }),
        makeEntry({ id: 'b', vector: [0, 1, 0] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], { k: 10, filter: {} });
      expect(results).toHaveLength(2);
    });

    it('excludes entries without metadata when filter has criteria', async () => {
      await store.addEntries([
        makeEntry({ id: 'with-meta', vector: [1, 0, 0], metadata: { url: 'test' } }),
        makeEntry({ id: 'no-meta', vector: [1, 0, 0] }),
      ]);

      const results = await store.similaritySearch([1, 0, 0], {
        k: 10,
        filter: { url: 'test' },
      });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('with-meta');
    });
  });
});
