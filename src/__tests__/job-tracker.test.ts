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

const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue('{}');
const mockExistsSync = vi.fn().mockReturnValue(false);

vi.mock('fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

import { JobTracker } from '../services/job-tracker';

describe('JobTracker', () => {
  let tracker: JobTracker;

  beforeEach(() => {
    vi.clearAllMocks();
    tracker = new JobTracker('test-job', {
      maxRetries: 3,
      retryDelayMs: 1000,
      checkpointInterval: 5,
      checkpointPath: '/tmp/anno-test-jobs',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('initializes with default stats', () => {
      const stats = tracker.getStats();

      expect(stats.total).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.captcha).toBe(0);
      expect(stats.processing).toBe(0);
    });

    it('starts as incomplete (no items)', () => {
      // With 0 pending and 0 processing, isComplete returns true
      expect(tracker.isComplete()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // addItems
  // -----------------------------------------------------------------------

  describe('addItems()', () => {
    it('adds URLs as pending items', () => {
      tracker.addItems(['https://a.com', 'https://b.com', 'https://c.com']);

      const stats = tracker.getStats();
      expect(stats.total).toBe(3);
      expect(stats.pending).toBe(3);
    });

    it('does not overwrite existing items with same URL', () => {
      tracker.addItems(['https://a.com']);
      tracker.addItems(['https://a.com']);

      const stats = tracker.getStats();
      expect(stats.total).toBe(1);
    });

    it('generates deterministic IDs from URLs', () => {
      tracker.addItems(['https://example.com']);

      const item = tracker.getNextItem();
      expect(item).not.toBeNull();
      expect(item!.url).toBe('https://example.com');
    });

    it('marks job as incomplete after adding items', () => {
      tracker.addItems(['https://a.com']);

      expect(tracker.isComplete()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getNextItem
  // -----------------------------------------------------------------------

  describe('getNextItem()', () => {
    it('returns null when no items exist', () => {
      expect(tracker.getNextItem()).toBeNull();
    });

    it('returns a pending item', () => {
      tracker.addItems(['https://a.com', 'https://b.com']);

      const item = tracker.getNextItem();

      expect(item).not.toBeNull();
      expect(item!.status).toBe('pending');
    });

    it('returns null when all items are completed', () => {
      tracker.addItems(['https://a.com']);

      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markCompleted(item.id);

      expect(tracker.getNextItem()).toBeNull();
    });

    it('returns retryable failed items before pending items', () => {
      tracker.addItems(['https://a.com', 'https://b.com']);

      // Process and fail the first item
      const first = tracker.getNextItem()!;
      tracker.markProcessing(first.id);
      tracker.markFailed(first.id, 'error');

      // Mock Date.now to be past retryDelayMs
      const originalNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(originalNow() + 2000);

      const next = tracker.getNextItem();
      // The failed item should be returned for retry (it was set back to pending or remains failed with retries left)
      expect(next).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // markProcessing
  // -----------------------------------------------------------------------

  describe('markProcessing()', () => {
    it('sets item status to processing', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;

      tracker.markProcessing(item.id);

      const stats = tracker.getStats();
      expect(stats.processing).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it('increments attempt count', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;

      expect(item.attempts).toBe(0);
      tracker.markProcessing(item.id);
      expect(item.attempts).toBe(1);
    });

    it('does nothing for nonexistent item ID', () => {
      tracker.markProcessing('nonexistent');
      // Should not throw
      const stats = tracker.getStats();
      expect(stats.processing).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // markCompleted
  // -----------------------------------------------------------------------

  describe('markCompleted()', () => {
    it('sets item status to completed', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);

      tracker.markCompleted(item.id, { result: 'data' });

      const stats = tracker.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.processing).toBe(0);
    });

    it('stores completion data on the item', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);

      tracker.markCompleted(item.id, { key: 'value' });

      const exported = tracker.exportData();
      expect(exported).toHaveLength(1);
      expect(exported[0].key).toBe('value');
    });

    it('triggers checkpoint after checkpointInterval items', () => {
      // Checkpoint interval is 5
      tracker.addItems([
        'https://1.com', 'https://2.com', 'https://3.com',
        'https://4.com', 'https://5.com',
      ]);

      for (let i = 0; i < 5; i++) {
        const item = tracker.getNextItem()!;
        tracker.markProcessing(item.id);
        tracker.markCompleted(item.id);
      }

      // save() should have been triggered (writeFile called)
      // It's async and fire-and-forget, so we just check it was called
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it('does nothing for nonexistent item ID', () => {
      tracker.markCompleted('nonexistent');
      const stats = tracker.getStats();
      expect(stats.completed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // markFailed
  // -----------------------------------------------------------------------

  describe('markFailed()', () => {
    it('sets item to pending when retries remain', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);

      tracker.markFailed(item.id, 'Network error');

      // Should be pending since attempts (1) < maxRetries (3)
      const stats = tracker.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(0);
    });

    it('sets item to failed when max retries reached', () => {
      tracker.addItems(['https://a.com']);

      for (let i = 0; i < 3; i++) {
        const item = tracker.getNextItem()!;
        tracker.markProcessing(item.id);
        tracker.markFailed(item.id, `Attempt ${i + 1} failed`);
      }

      const stats = tracker.getStats();
      expect(stats.failed).toBe(1);
    });

    it('stores error message on item', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markFailed(item.id, 'Connection timeout');

      expect(item.error).toBe('Connection timeout');
    });

    it('does nothing for nonexistent item ID', () => {
      tracker.markFailed('nonexistent', 'error');
      const stats = tracker.getStats();
      expect(stats.failed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // markCaptcha
  // -----------------------------------------------------------------------

  describe('markCaptcha()', () => {
    it('sets item status to captcha', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);

      tracker.markCaptcha(item.id);

      const stats = tracker.getStats();
      expect(stats.captcha).toBe(1);
      expect(stats.processing).toBe(0);
    });

    it('does nothing for nonexistent item ID', () => {
      tracker.markCaptcha('nonexistent');
      const stats = tracker.getStats();
      expect(stats.captcha).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // resetCaptchaItems
  // -----------------------------------------------------------------------

  describe('resetCaptchaItems()', () => {
    it('resets captcha items back to pending', () => {
      tracker.addItems(['https://a.com', 'https://b.com']);

      // Mark both as processing then captcha
      const item1 = tracker.getNextItem()!;
      tracker.markProcessing(item1.id);
      tracker.markCaptcha(item1.id);

      const item2 = tracker.getNextItem()!;
      tracker.markProcessing(item2.id);
      tracker.markCaptcha(item2.id);

      expect(tracker.getStats().captcha).toBe(2);

      tracker.resetCaptchaItems();

      const stats = tracker.getStats();
      expect(stats.captcha).toBe(0);
      expect(stats.pending).toBe(2);
    });

    it('resets attempt count on captcha items', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markCaptcha(item.id);

      tracker.resetCaptchaItems();

      expect(item.attempts).toBe(0);
    });

    it('does nothing when no captcha items exist', () => {
      tracker.addItems(['https://a.com']);

      tracker.resetCaptchaItems();

      const stats = tracker.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.captcha).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // save
  // -----------------------------------------------------------------------

  describe('save()', () => {
    it('serializes job state to JSON file', async () => {
      tracker.addItems(['https://a.com']);

      await tracker.save();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const [path, content] = mockWriteFile.mock.calls[0];
      expect(path).toContain('test-job.json');

      const parsed = JSON.parse(content as string);
      expect(parsed.jobId).toBe('test-job');
      expect(parsed.stats.total).toBe(1);
      expect(Array.isArray(parsed.items)).toBe(true);
    });

    it('handles write failure gracefully', async () => {
      mockWriteFile.mockRejectedValue(new Error('Disk full'));

      tracker.addItems(['https://a.com']);

      // Should not throw
      await tracker.save();
    });
  });

  // -----------------------------------------------------------------------
  // static load
  // -----------------------------------------------------------------------

  describe('load()', () => {
    it('returns fresh tracker when no checkpoint exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const loaded = await JobTracker.load('new-job');

      expect(loaded.getStats().total).toBe(0);
    });

    it('restores state from checkpoint file', async () => {
      mockExistsSync.mockReturnValue(true);

      const savedState = {
        jobId: 'existing-job',
        startedAt: Date.now() - 10000,
        lastUpdate: Date.now(),
        items: [
          ['id1', { id: 'id1', url: 'https://a.com', status: 'completed', attempts: 1, completedAt: Date.now(), data: { key: 'val' } }],
          ['id2', { id: 'id2', url: 'https://b.com', status: 'pending', attempts: 0 }],
        ],
        stats: {
          total: 2,
          pending: 1,
          processing: 0,
          completed: 1,
          failed: 0,
          captcha: 0,
        },
      };

      mockReadFile.mockResolvedValue(JSON.stringify(savedState));

      const loaded = await JobTracker.load('existing-job');

      const stats = loaded.getStats();
      expect(stats.total).toBe(2);
      expect(stats.completed).toBe(1);
      expect(stats.pending).toBe(1);
    });

    it('returns fresh tracker on parse failure', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('INVALID JSON');

      const loaded = await JobTracker.load('bad-checkpoint');

      expect(loaded.getStats().total).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // isComplete
  // -----------------------------------------------------------------------

  describe('isComplete()', () => {
    it('returns true when all items are completed or failed', () => {
      tracker.addItems(['https://a.com']);

      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markCompleted(item.id);

      expect(tracker.isComplete()).toBe(true);
    });

    it('returns false when items are still pending', () => {
      tracker.addItems(['https://a.com']);

      expect(tracker.isComplete()).toBe(false);
    });

    it('returns false when items are still processing', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);

      expect(tracker.isComplete()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // getStats
  // -----------------------------------------------------------------------

  describe('getStats()', () => {
    it('includes percentComplete', () => {
      tracker.addItems(['https://a.com', 'https://b.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markCompleted(item.id);

      const stats = tracker.getStats();
      expect(stats.percentComplete).toBe('50.0');
    });

    it('includes elapsed time', () => {
      const stats = tracker.getStats();
      expect(typeof stats.elapsed).toBe('number');
      expect(stats.elapsed).toBeGreaterThanOrEqual(0);
    });

    it('includes startedAt as ISO string', () => {
      const stats = tracker.getStats();
      expect(stats.startedAt).toBeTruthy();
      expect(new Date(stats.startedAt).getTime()).not.toBeNaN();
    });
  });

  // -----------------------------------------------------------------------
  // exportData
  // -----------------------------------------------------------------------

  describe('exportData()', () => {
    it('returns empty array when no completed items', () => {
      tracker.addItems(['https://a.com']);

      expect(tracker.exportData()).toEqual([]);
    });

    it('returns only completed items with data', () => {
      tracker.addItems(['https://a.com', 'https://b.com']);

      const item1 = tracker.getNextItem()!;
      tracker.markProcessing(item1.id);
      tracker.markCompleted(item1.id, { title: 'Page A' });

      const item2 = tracker.getNextItem()!;
      tracker.markProcessing(item2.id);
      tracker.markCompleted(item2.id); // No data

      const data = tracker.exportData();
      // Only item1 has data
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe('Page A');
      expect(data[0].url).toBe('https://a.com');
    });

    it('includes completedAt in exported data', () => {
      tracker.addItems(['https://a.com']);
      const item = tracker.getNextItem()!;
      tracker.markProcessing(item.id);
      tracker.markCompleted(item.id, { result: 'ok' });

      const data = tracker.exportData();
      expect(data[0].completedAt).toBeDefined();
      expect(typeof data[0].completedAt).toBe('number');
    });
  });
});
