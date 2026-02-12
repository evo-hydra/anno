import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger to avoid noise in test output
// ---------------------------------------------------------------------------

vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock fs to avoid real filesystem operations
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockReadFile = vi.fn().mockResolvedValue('{}');
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
}));

import { DiffEngine } from '../services/diff-engine';
import type { ContentSnapshot } from '../services/diff-engine';

describe('DiffEngine', () => {
  let engine: DiffEngine;
  const testDataDir = '/tmp/anno-test-snapshots';

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new DiffEngine(testDataDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // takeSnapshot
  // -----------------------------------------------------------------------

  describe('takeSnapshot()', () => {
    it('creates a snapshot with correct fields', async () => {
      const snapshot = await engine.takeSnapshot('https://example.com', 'Hello World');

      expect(snapshot.url).toBe('https://example.com');
      expect(snapshot.content).toBe('Hello World');
      expect(snapshot.contentHash).toBeTruthy();
      expect(snapshot.urlHash).toBeTruthy();
      expect(snapshot.timestamp).toBeTruthy();
      expect(new Date(snapshot.timestamp).getTime()).not.toBeNaN();
    });

    it('persists snapshot to disk via mkdir and writeFile', async () => {
      await engine.takeSnapshot('https://example.com', 'content');

      expect(mockMkdir).toHaveBeenCalledTimes(1);
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(testDataDir), { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.json'),
        expect.any(String),
        'utf8'
      );
    });

    it('includes title from metadata', async () => {
      const snapshot = await engine.takeSnapshot('https://example.com', 'content', {
        title: 'My Page Title',
      });

      expect(snapshot.title).toBe('My Page Title');
    });

    it('includes extra metadata', async () => {
      const snapshot = await engine.takeSnapshot('https://example.com', 'content', {
        title: 'Page',
        author: 'Test',
      });

      expect(snapshot.metadata).toEqual({ title: 'Page', author: 'Test' });
    });

    it('produces deterministic content hashes for same content', async () => {
      const snap1 = await engine.takeSnapshot('https://example.com', 'same content');
      const snap2 = await engine.takeSnapshot('https://example.com', 'same content');

      expect(snap1.contentHash).toBe(snap2.contentHash);
    });

    it('produces different content hashes for different content', async () => {
      const snap1 = await engine.takeSnapshot('https://example.com', 'content A');
      const snap2 = await engine.takeSnapshot('https://example.com', 'content B');

      expect(snap1.contentHash).not.toBe(snap2.contentHash);
    });

    it('normalizes URL for urlHash (case-insensitive, trailing slash)', async () => {
      const snap1 = await engine.takeSnapshot('https://EXAMPLE.COM/', 'content');
      const snap2 = await engine.takeSnapshot('https://example.com', 'content');

      expect(snap1.urlHash).toBe(snap2.urlHash);
    });
  });

  // -----------------------------------------------------------------------
  // diff
  // -----------------------------------------------------------------------

  describe('diff()', () => {
    it('returns zero changes for identical content', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'line 1\nline 2\nline 3',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash1',
      };

      const result = engine.diff(snapshotA, snapshotB);

      expect(result.addedCount).toBe(0);
      expect(result.removedCount).toBe(0);
      expect(result.unchangedCount).toBe(3);
      expect(result.changePercent).toBe(0);
    });

    it('detects added lines', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'line 1\nline 2',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: 'line 1\nline 2\nline 3',
      };

      const result = engine.diff(snapshotA, snapshotB);

      expect(result.addedCount).toBe(1);
      expect(result.removedCount).toBe(0);
      expect(result.unchangedCount).toBe(2);
      expect(result.changePercent).toBeGreaterThan(0);
    });

    it('detects removed lines', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'line 1\nline 2\nline 3',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: 'line 1\nline 3',
      };

      const result = engine.diff(snapshotA, snapshotB);

      expect(result.removedCount).toBe(1);
      expect(result.unchangedCount).toBe(2);
      expect(result.changePercent).toBeGreaterThan(0);
    });

    it('handles completely different content', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'alpha\nbeta\ngamma',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: 'one\ntwo\nthree',
      };

      const result = engine.diff(snapshotA, snapshotB);

      expect(result.addedCount).toBe(3);
      expect(result.removedCount).toBe(3);
      expect(result.unchangedCount).toBe(0);
      // changePercent = (added + removed) / max(oldLen, newLen) * 100 = (3+3)/3 * 100 = 200
      expect(result.changePercent).toBe(200);
    });

    it('handles empty old content', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: '',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: 'new content',
      };

      const result = engine.diff(snapshotA, snapshotB);
      expect(result.addedCount).toBeGreaterThan(0);
    });

    it('handles empty new content', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'existing content',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: '',
      };

      const result = engine.diff(snapshotA, snapshotB);
      expect(result.removedCount).toBeGreaterThan(0);
    });

    it('assigns line numbers to diff lines', () => {
      const snapshotA: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'line 1\nline 2',
        timestamp: new Date().toISOString(),
      };
      const snapshotB: ContentSnapshot = {
        ...snapshotA,
        contentHash: 'hash2',
        content: 'line 1\nnew line\nline 2',
      };

      const result = engine.diff(snapshotA, snapshotB);

      for (const line of result.lines) {
        expect(line.lineNumber).toBeDefined();
        expect(typeof line.lineNumber).toBe('number');
      }
    });
  });

  // -----------------------------------------------------------------------
  // detectChanges
  // -----------------------------------------------------------------------

  describe('detectChanges()', () => {
    it('returns 100% change on first capture (no previous snapshot)', async () => {
      mockReaddir.mockResolvedValue([]);

      const result = await engine.detectChanges('https://example.com', 'Hello World');

      expect(result.hasChanged).toBe(true);
      expect(result.changePercent).toBe(100);
      expect(result.summary).toContain('Initial snapshot');
      expect(result.previousSnapshot).toBeUndefined();
      expect(result.currentSnapshot).toBeDefined();
    });

    it('returns hasChanged=false when content is identical', async () => {
      const existingSnapshot: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: '',
        content: 'Same content',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      // We need the content hash to match what the engine would produce.
      // Take a snapshot first to get the actual hash.
      mockReaddir.mockResolvedValue([]);
      const firstCapture = await engine.takeSnapshot('https://example.com', 'Same content');

      // Now mock readdir/readFile to return that snapshot
      existingSnapshot.contentHash = firstCapture.contentHash;
      mockReaddir.mockResolvedValue(['2024-01-01T00-00-00.000Z_0000.json']);
      mockReadFile.mockResolvedValue(JSON.stringify(existingSnapshot));

      const result = await engine.detectChanges('https://example.com', 'Same content');

      expect(result.hasChanged).toBe(false);
      expect(result.changePercent).toBe(0);
      expect(result.summary).toBe('No changes detected');
      expect(result.previousSnapshot).toBeDefined();
    });

    it('detects changes when content differs', async () => {
      const existingSnapshot: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'old-hash-that-wont-match',
        content: 'Old content here',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['2024-01-01T00-00-00.000Z_0000.json']);
      mockReadFile.mockResolvedValue(JSON.stringify(existingSnapshot));

      const result = await engine.detectChanges('https://example.com', 'Completely new content');

      expect(result.hasChanged).toBe(true);
      expect(result.changePercent).toBeGreaterThan(0);
      expect(result.summary).not.toBe('No changes detected');
      expect(result.previousSnapshot).toBeDefined();
      expect(result.currentSnapshot).toBeDefined();
    });

    it('provides a meaningful summary for additions', async () => {
      const existingSnapshot: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'old-hash',
        content: 'line 1\nline 2',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['2024-01-01T00-00-00.000Z_0000.json']);
      mockReadFile.mockResolvedValue(JSON.stringify(existingSnapshot));

      const result = await engine.detectChanges('https://example.com', 'line 1\nline 2\nline 3\nline 4');

      expect(result.hasChanged).toBe(true);
      expect(result.summary).toBeTruthy();
      expect(typeof result.summary).toBe('string');
    });
  });

  // -----------------------------------------------------------------------
  // getSnapshots
  // -----------------------------------------------------------------------

  describe('getSnapshots()', () => {
    it('returns empty array when directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const snapshots = await engine.getSnapshots('https://example.com');

      expect(snapshots).toEqual([]);
    });

    it('returns snapshots sorted by filename', async () => {
      const snap1: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h1',
        content: 'first',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const snap2: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h2',
        content: 'second',
        timestamp: '2024-01-02T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue([
        '2024-01-02T00-00-00.000Z_0000.json',
        '2024-01-01T00-00-00.000Z_0000.json',
      ]);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(snap1))
        .mockResolvedValueOnce(JSON.stringify(snap2));

      const snapshots = await engine.getSnapshots('https://example.com');

      expect(snapshots).toHaveLength(2);
    });

    it('skips non-JSON files', async () => {
      const snap: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h1',
        content: 'data',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['snapshot.json', 'readme.txt', 'data.csv']);
      mockReadFile.mockResolvedValue(JSON.stringify(snap));

      const snapshots = await engine.getSnapshots('https://example.com');

      expect(snapshots).toHaveLength(1);
    });

    it('skips unreadable snapshot files gracefully', async () => {
      mockReaddir.mockResolvedValue(['good.json', 'bad.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify({
          url: 'https://example.com',
          urlHash: 'abc',
          contentHash: 'h1',
          content: 'ok',
          timestamp: '2024-01-01T00:00:00.000Z',
        }))
        .mockRejectedValueOnce(new Error('Permission denied'));

      const snapshots = await engine.getSnapshots('https://example.com');

      expect(snapshots).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // getLatestSnapshot
  // -----------------------------------------------------------------------

  describe('getLatestSnapshot()', () => {
    it('returns null when no snapshots exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const latest = await engine.getLatestSnapshot('https://example.com');

      expect(latest).toBeNull();
    });

    it('returns the last snapshot in sorted order', async () => {
      const snap1: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h1',
        content: 'first',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const snap2: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h2',
        content: 'second',
        timestamp: '2024-01-02T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue([
        '2024-01-01T00-00-00.000Z_0000.json',
        '2024-01-02T00-00-00.000Z_0001.json',
      ]);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(snap1))
        .mockResolvedValueOnce(JSON.stringify(snap2));

      const latest = await engine.getLatestSnapshot('https://example.com');

      expect(latest).not.toBeNull();
      expect(latest!.contentHash).toBe('h2');
    });
  });

  // -----------------------------------------------------------------------
  // pruneSnapshots
  // -----------------------------------------------------------------------

  describe('pruneSnapshots()', () => {
    it('returns 0 when directory does not exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const deleted = await engine.pruneSnapshots('https://example.com', 5);

      expect(deleted).toBe(0);
    });

    it('returns 0 when fewer snapshots than keepCount', async () => {
      mockReaddir.mockResolvedValue(['a.json', 'b.json']);

      const deleted = await engine.pruneSnapshots('https://example.com', 5);

      expect(deleted).toBe(0);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('deletes oldest snapshots beyond keepCount', async () => {
      mockReaddir.mockResolvedValue([
        '2024-01-01.json',
        '2024-01-02.json',
        '2024-01-03.json',
        '2024-01-04.json',
        '2024-01-05.json',
      ]);

      const deleted = await engine.pruneSnapshots('https://example.com', 2);

      expect(deleted).toBe(3);
      expect(mockUnlink).toHaveBeenCalledTimes(3);
    });

    it('handles unlink failures gracefully', async () => {
      mockReaddir.mockResolvedValue([
        '2024-01-01.json',
        '2024-01-02.json',
        '2024-01-03.json',
      ]);
      mockUnlink.mockRejectedValue(new Error('Permission denied'));

      const deleted = await engine.pruneSnapshots('https://example.com', 1);

      // Should return 0 since all deletes failed
      expect(deleted).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // getHistory
  // -----------------------------------------------------------------------

  describe('getHistory()', () => {
    it('returns empty array when no snapshots exist', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const history = await engine.getHistory('https://example.com');

      expect(history).toEqual([]);
    });

    it('returns single entry for first snapshot at 100%', async () => {
      const snap: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'h1',
        content: 'initial',
        timestamp: '2024-01-01T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['2024-01-01.json']);
      mockReadFile.mockResolvedValue(JSON.stringify(snap));

      const history = await engine.getHistory('https://example.com');

      expect(history).toHaveLength(1);
      expect(history[0].changePercent).toBe(100);
      expect(history[0].summary).toBe('Initial snapshot');
    });

    it('reports 0% change for identical consecutive snapshots', async () => {
      const snap1: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'same-hash',
        content: 'same',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const snap2: ContentSnapshot = {
        ...snap1,
        timestamp: '2024-01-02T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['2024-01-01.json', '2024-01-02.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(snap1))
        .mockResolvedValueOnce(JSON.stringify(snap2));

      const history = await engine.getHistory('https://example.com');

      expect(history).toHaveLength(2);
      expect(history[0].changePercent).toBe(100); // first snapshot
      expect(history[1].changePercent).toBe(0);   // no change
      expect(history[1].summary).toBe('No changes detected');
    });

    it('reports change percentage for different consecutive snapshots', async () => {
      const snap1: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash1',
        content: 'old content',
        timestamp: '2024-01-01T00:00:00.000Z',
      };
      const snap2: ContentSnapshot = {
        url: 'https://example.com',
        urlHash: 'abc',
        contentHash: 'hash2',
        content: 'new content',
        timestamp: '2024-01-02T00:00:00.000Z',
      };

      mockReaddir.mockResolvedValue(['2024-01-01.json', '2024-01-02.json']);
      mockReadFile
        .mockResolvedValueOnce(JSON.stringify(snap1))
        .mockResolvedValueOnce(JSON.stringify(snap2));

      const history = await engine.getHistory('https://example.com');

      expect(history).toHaveLength(2);
      expect(history[1].changePercent).toBeGreaterThan(0);
      expect(history[1].summary).toBeTruthy();
    });
  });
});
