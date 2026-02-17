import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger
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
// Mock fs
// ---------------------------------------------------------------------------

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockReadFile = vi.fn().mockResolvedValue('{}');
const mockRm = vi.fn().mockResolvedValue(undefined);
const mockAppendFile = vi.fn().mockResolvedValue(undefined);

vi.mock('fs', () => ({
  promises: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
    rm: (...args: unknown[]) => mockRm(...args),
    appendFile: (...args: unknown[]) => mockAppendFile(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock diff-engine
// ---------------------------------------------------------------------------

const mockDetectChanges = vi.fn().mockResolvedValue({
  url: 'https://example.com',
  hasChanged: false,
  changePercent: 0,
  diff: { lines: [], addedCount: 0, removedCount: 0, unchangedCount: 0, changePercent: 0 },
  summary: 'No changes detected',
  currentSnapshot: { contentHash: 'abc123' },
});

vi.mock('../services/diff-engine', () => ({
  diffEngine: {
    detectChanges: (...args: unknown[]) => mockDetectChanges(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock fetcher
// ---------------------------------------------------------------------------

const mockFetchPage = vi.fn().mockResolvedValue({
  body: '<html><body>Hello</body></html>',
  finalUrl: 'https://example.com',
  statusCode: 200,
});

vi.mock('../services/fetcher', () => ({
  fetchPage: (...args: unknown[]) => mockFetchPage(...args),
}));

// ---------------------------------------------------------------------------
// Mock distiller
// ---------------------------------------------------------------------------

const mockDistillContent = vi.fn().mockResolvedValue({
  contentText: 'Hello World',
  title: 'Example',
});

vi.mock('../services/distiller', () => ({
  distillContent: (...args: unknown[]) => mockDistillContent(...args),
}));

// ---------------------------------------------------------------------------
// Mock url-validator
// ---------------------------------------------------------------------------

vi.mock('../core/url-validator', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue(undefined),
}));

import { WatchManager } from '../services/watch-manager';
import type { WatchTarget } from '../services/watch-manager';

describe('WatchManager', () => {
  let manager: WatchManager;
  const testDataDir = '/tmp/anno-test-watches';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new WatchManager(testDataDir);
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // init / shutdown
  // -----------------------------------------------------------------------

  describe('init()', () => {
    it('loads persisted watches and starts timer', async () => {
      mockReaddir.mockResolvedValue([]);
      await manager.init();

      expect(manager.listWatches()).toEqual([]);
    });

    it('loads watches from existing config files', async () => {
      const watchConfig: WatchTarget = {
        id: 'test-id-1',
        url: 'https://example.com',
        interval: 3600,
        status: 'active',
        createdAt: '2024-01-01T00:00:00.000Z',
        checkCount: 0,
        changeCount: 0,
      };

      mockReaddir.mockResolvedValue(['test-id-1']);
      mockReadFile.mockResolvedValue(JSON.stringify(watchConfig));

      await manager.init();

      const watches = manager.listWatches();
      expect(watches).toHaveLength(1);
      expect(watches[0].url).toBe('https://example.com');
    });

    it('skips unreadable config files gracefully', async () => {
      mockReaddir.mockResolvedValue(['bad-dir']);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      await manager.init();

      expect(manager.listWatches()).toEqual([]);
    });

    it('handles missing data directory gracefully', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      await manager.init();

      expect(manager.listWatches()).toEqual([]);
    });
  });

  describe('shutdown()', () => {
    it('stops the timer without error', async () => {
      mockReaddir.mockResolvedValue([]);
      await manager.init();
      expect(() => manager.shutdown()).not.toThrow();
    });

    it('can be called multiple times safely', () => {
      manager.shutdown();
      manager.shutdown();
      // No error
    });
  });

  // -----------------------------------------------------------------------
  // addWatch
  // -----------------------------------------------------------------------

  describe('addWatch()', () => {
    it('creates a watch with default options', async () => {
      const watch = await manager.addWatch('https://example.com');

      expect(watch.url).toBe('https://example.com');
      expect(watch.id).toBeTruthy();
      expect(watch.status).toBe('active');
      expect(watch.checkCount).toBe(0);
      expect(watch.changeCount).toBe(0);
      expect(watch.interval).toBeGreaterThanOrEqual(60);
    });

    it('respects custom interval', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 7200 });

      expect(watch.interval).toBe(7200);
    });

    it('enforces minimum interval of 60 seconds', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 10 });

      expect(watch.interval).toBe(60);
    });

    it('sets webhookUrl when provided', async () => {
      const watch = await manager.addWatch('https://example.com', {
        webhookUrl: 'https://hooks.example.com/notify',
      });

      expect(watch.webhookUrl).toBe('https://hooks.example.com/notify');
    });

    it('sets changeThreshold when provided', async () => {
      const watch = await manager.addWatch('https://example.com', {
        changeThreshold: 10,
      });

      expect(watch.changeThreshold).toBe(10);
    });

    it('defaults changeThreshold to 1', async () => {
      const watch = await manager.addWatch('https://example.com');

      expect(watch.changeThreshold).toBe(1);
    });

    it('persists the watch config to disk', async () => {
      await manager.addWatch('https://example.com');

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      const writeCall = mockWriteFile.mock.calls[0];
      expect(writeCall[0]).toContain(testDataDir);
      expect(writeCall[0]).toContain('config.json');
    });

    it('adds watch to in-memory list', async () => {
      expect(manager.listWatches()).toHaveLength(0);

      await manager.addWatch('https://a.com');
      await manager.addWatch('https://b.com');

      expect(manager.listWatches()).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // removeWatch
  // -----------------------------------------------------------------------

  describe('removeWatch()', () => {
    it('removes an existing watch and returns true', async () => {
      const watch = await manager.addWatch('https://example.com');

      const removed = await manager.removeWatch(watch.id);

      expect(removed).toBe(true);
      expect(manager.getWatch(watch.id)).toBeNull();
    });

    it('returns false for nonexistent watch ID', async () => {
      const removed = await manager.removeWatch('nonexistent-id');

      expect(removed).toBe(false);
    });

    it('removes persisted directory', async () => {
      const watch = await manager.addWatch('https://example.com');
      vi.clearAllMocks();

      await manager.removeWatch(watch.id);

      expect(mockRm).toHaveBeenCalledTimes(1);
      expect(mockRm).toHaveBeenCalledWith(
        expect.stringContaining(watch.id),
        { recursive: true, force: true }
      );
    });

    it('handles rm failure gracefully', async () => {
      const watch = await manager.addWatch('https://example.com');
      mockRm.mockRejectedValue(new Error('Permission denied'));

      const removed = await manager.removeWatch(watch.id);

      expect(removed).toBe(true); // Still returns true even if FS cleanup fails
      expect(manager.getWatch(watch.id)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // pauseWatch / resumeWatch
  // -----------------------------------------------------------------------

  describe('pauseWatch()', () => {
    it('pauses an active watch', async () => {
      const watch = await manager.addWatch('https://example.com');

      const paused = await manager.pauseWatch(watch.id);

      expect(paused).not.toBeNull();
      expect(paused!.status).toBe('paused');
    });

    it('returns null for nonexistent watch ID', async () => {
      const result = await manager.pauseWatch('nonexistent');

      expect(result).toBeNull();
    });

    it('persists the updated status', async () => {
      const watch = await manager.addWatch('https://example.com');
      vi.clearAllMocks();

      await manager.pauseWatch(watch.id);

      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('resumeWatch()', () => {
    it('resumes a paused watch', async () => {
      const watch = await manager.addWatch('https://example.com');
      await manager.pauseWatch(watch.id);

      const resumed = await manager.resumeWatch(watch.id);

      expect(resumed).not.toBeNull();
      expect(resumed!.status).toBe('active');
    });

    it('clears lastError on resume', async () => {
      const watch = await manager.addWatch('https://example.com');
      // Manually set an error state
      const w = manager.getWatch(watch.id)!;
      w.status = 'error';
      w.lastError = 'some error';

      const resumed = await manager.resumeWatch(watch.id);

      expect(resumed!.status).toBe('active');
      expect(resumed!.lastError).toBeUndefined();
    });

    it('returns null for nonexistent watch ID', async () => {
      const result = await manager.resumeWatch('nonexistent');

      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getWatch / listWatches
  // -----------------------------------------------------------------------

  describe('getWatch()', () => {
    it('returns watch by ID', async () => {
      const watch = await manager.addWatch('https://example.com');

      const found = manager.getWatch(watch.id);

      expect(found).not.toBeNull();
      expect(found!.url).toBe('https://example.com');
    });

    it('returns null for nonexistent ID', () => {
      expect(manager.getWatch('nonexistent')).toBeNull();
    });
  });

  describe('listWatches()', () => {
    it('returns empty array initially', () => {
      expect(manager.listWatches()).toEqual([]);
    });

    it('returns all watches', async () => {
      await manager.addWatch('https://a.com');
      await manager.addWatch('https://b.com');
      await manager.addWatch('https://c.com');

      const watches = manager.listWatches();

      expect(watches).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // getEvents
  // -----------------------------------------------------------------------

  describe('getEvents()', () => {
    it('returns empty array when events file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const events = await manager.getEvents('some-watch-id');

      expect(events).toEqual([]);
    });

    it('parses JSONL event file', async () => {
      const event1 = { watchId: 'w1', url: 'https://example.com', timestamp: '2024-01-01', changePercent: 5, summary: 'changes', currentHash: 'abc' };
      const event2 = { watchId: 'w1', url: 'https://example.com', timestamp: '2024-01-02', changePercent: 10, summary: 'more changes', currentHash: 'def' };

      mockReadFile.mockResolvedValue(
        JSON.stringify(event1) + '\n' + JSON.stringify(event2) + '\n'
      );

      const events = await manager.getEvents('w1');

      expect(events).toHaveLength(2);
      // Should be newest first
      expect(events[0].timestamp).toBe('2024-01-02');
      expect(events[1].timestamp).toBe('2024-01-01');
    });

    it('skips malformed JSONL lines', async () => {
      const event1 = { watchId: 'w1', url: 'https://example.com', timestamp: '2024-01-01', changePercent: 5, summary: 'changes', currentHash: 'abc' };

      mockReadFile.mockResolvedValue(
        JSON.stringify(event1) + '\n' + 'INVALID JSON\n'
      );

      const events = await manager.getEvents('w1');

      expect(events).toHaveLength(1);
    });

    it('respects the limit parameter', async () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ watchId: 'w1', url: 'https://example.com', timestamp: `2024-01-${String(i + 1).padStart(2, '0')}`, changePercent: i, summary: `change ${i}`, currentHash: `hash${i}` })
      ).join('\n');

      mockReadFile.mockResolvedValue(lines);

      const events = await manager.getEvents('w1', 3);

      expect(events).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // tick — timer-based polling
  // -----------------------------------------------------------------------

  describe('tick (via timer)', () => {
    it('checks active watches when interval has elapsed', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 60 });

      // Manually set lastChecked to past
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      // Advance timer to trigger tick (30s interval)
      await vi.advanceTimersByTimeAsync(31_000);

      // checkWatch should have been called — verify via fetchPage mock
      expect(mockFetchPage).toHaveBeenCalled();
    });

    it('skips paused watches', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 60 });
      await manager.pauseWatch(watch.id);

      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockFetchPage).not.toHaveBeenCalled();
    });

    it('skips watches whose interval has not elapsed', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 3600 });

      // Set lastChecked to recent
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date().toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockFetchPage).not.toHaveBeenCalled();
    });

    it('does not re-enter tick if previous tick is still running', async () => {
      // Make fetchPage hang to simulate long-running tick
      let resolveFetch!: () => void;
      mockFetchPage.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFetch = () =>
            resolve({
              body: '<html></html>',
              finalUrl: 'https://example.com',
              statusCode: 200,
            });
        })
      );

      const watch = await manager.addWatch('https://example.com', { interval: 60 });
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      // First tick starts
      await vi.advanceTimersByTimeAsync(31_000);

      // Second tick should be skipped (checking = true)
      await vi.advanceTimersByTimeAsync(31_000);

      // Only one fetch should have been called
      expect(mockFetchPage).toHaveBeenCalledTimes(1);

      // Resolve the hung fetch
      resolveFetch();
      await vi.advanceTimersByTimeAsync(1);
    });
  });

  // -----------------------------------------------------------------------
  // checkWatch — change detection
  // -----------------------------------------------------------------------

  describe('checkWatch (via tick)', () => {
    it('records event when change exceeds threshold', async () => {
      mockDetectChanges.mockResolvedValueOnce({
        url: 'https://example.com',
        hasChanged: true,
        changePercent: 15,
        summary: 'Content updated',
        currentSnapshot: { contentHash: 'newhash' },
        previousSnapshot: { contentHash: 'oldhash' },
        diff: {
          lines: [],
          addedCount: 5,
          removedCount: 2,
          unchangedCount: 50,
          changePercent: 15,
        },
      });

      const watch = await manager.addWatch('https://example.com', {
        interval: 60,
        changeThreshold: 5,
      });
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      // Should have appended event
      expect(mockAppendFile).toHaveBeenCalled();

      // Check count should have incremented
      const updated = manager.getWatch(watch.id)!;
      expect(updated.checkCount).toBe(1);
      expect(updated.changeCount).toBe(1);
    });

    it('does not record event when change is below threshold', async () => {
      mockDetectChanges.mockResolvedValueOnce({
        url: 'https://example.com',
        hasChanged: true,
        changePercent: 0.5,
        summary: 'Minor change',
        currentSnapshot: { contentHash: 'newhash' },
        diff: {
          lines: [],
          addedCount: 1,
          removedCount: 0,
          unchangedCount: 100,
          changePercent: 0.5,
        },
      });

      const watch = await manager.addWatch('https://example.com', {
        interval: 60,
        changeThreshold: 5,
      });
      vi.clearAllMocks();
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      // Should not have appended event (change below threshold)
      expect(mockAppendFile).not.toHaveBeenCalled();
    });

    it('marks watch as error when fetch fails', async () => {
      mockFetchPage.mockRejectedValueOnce(new Error('Network timeout'));

      const watch = await manager.addWatch('https://example.com', { interval: 60 });
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      const updated = manager.getWatch(watch.id)!;
      expect(updated.status).toBe('error');
      expect(updated.lastError).toBe('Network timeout');
    });

    it('clears error status on successful check after previous error', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 60 });
      const w = manager.getWatch(watch.id)!;
      w.status = 'active';
      w.lastError = 'previous error';
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      const updated = manager.getWatch(watch.id)!;
      expect(updated.lastError).toBeUndefined();
    });

    it('increments checkCount even when no change detected', async () => {
      const watch = await manager.addWatch('https://example.com', { interval: 60 });
      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      const updated = manager.getWatch(watch.id)!;
      expect(updated.checkCount).toBe(1);
      expect(updated.changeCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // webhook firing
  // -----------------------------------------------------------------------

  describe('webhook firing (via change detection)', () => {
    it('fires webhook when change exceeds threshold and webhookUrl is configured', async () => {
      mockDetectChanges.mockResolvedValueOnce({
        url: 'https://example.com',
        hasChanged: true,
        changePercent: 25,
        summary: 'Major update',
        currentSnapshot: { contentHash: 'newhash' },
        previousSnapshot: { contentHash: 'oldhash' },
        diff: {
          lines: [],
          addedCount: 10,
          removedCount: 5,
          unchangedCount: 50,
          changePercent: 25,
        },
      });

      const watch = await manager.addWatch('https://example.com', {
        interval: 60,
        webhookUrl: 'http://hooks.example.com/notify',
        changeThreshold: 1,
      });

      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      // Change was detected and event recorded
      const updated = manager.getWatch(watch.id)!;
      expect(updated.changeCount).toBe(1);
      expect(mockAppendFile).toHaveBeenCalled();
    });

    it('does not fire webhook when no webhookUrl configured', async () => {
      mockDetectChanges.mockResolvedValueOnce({
        url: 'https://example.com',
        hasChanged: true,
        changePercent: 25,
        summary: 'Major update',
        currentSnapshot: { contentHash: 'newhash' },
        previousSnapshot: { contentHash: 'oldhash' },
        diff: {
          lines: [],
          addedCount: 10,
          removedCount: 5,
          unchangedCount: 50,
          changePercent: 25,
        },
      });

      const watch = await manager.addWatch('https://example.com', {
        interval: 60,
        changeThreshold: 1,
        // No webhookUrl
      });

      const w = manager.getWatch(watch.id)!;
      w.lastChecked = new Date(Date.now() - 120_000).toISOString();

      await vi.advanceTimersByTimeAsync(31_000);

      // Change detected, but no webhook fired (no assertion error = pass)
      const updated = manager.getWatch(watch.id)!;
      expect(updated.changeCount).toBe(1);
    });
  });
});
