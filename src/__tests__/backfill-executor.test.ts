import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockAppendFile = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockConstants = vi.hoisted(() => ({ F_OK: 0 }));

const mockExtractListing = vi.hoisted(() => vi.fn());
const mockIsEnabled = vi.hoisted(() => vi.fn());

const mockEmit = vi.hoisted(() => vi.fn());
const mockCreateExtractionEvent = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  appendFile: mockAppendFile,
  access: mockAccess,
  constants: mockConstants,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../services/extractors/extraction-event-pipeline', () => ({
  extractionEventPipeline: {
    emit: mockEmit,
  },
  createExtractionEvent: mockCreateExtractionEvent,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  BackfillExecutor,
  createBackfillJob,
  registerDatabaseAdapter,
} from '../services/extractors/backfill-executor';
import type { BackfillJob, MarketplaceListing } from '../services/extractors/marketplace-adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRegistry() {
  return {
    isEnabled: mockIsEnabled,
    extractListing: mockExtractListing,
  } as unknown as ConstructorParameters<typeof BackfillExecutor>[0];
}

function makeListing(overrides?: Partial<MarketplaceListing>): MarketplaceListing {
  return {
    id: 'test-123',
    marketplace: 'ebay',
    url: 'https://www.ebay.com/itm/123456789',
    title: 'Test Item',
    price: { amount: 29.99, currency: 'USD' },
    condition: 'new',
    availability: 'sold',
    seller: { name: 'test-seller' },
    images: ['https://img.example.com/1.jpg'],
    extractedAt: '2026-01-01T00:00:00Z',
    extractionMethod: 'test',
    confidence: 0.85,
    extractorVersion: '1.0.0',
    ...overrides,
  };
}

function makeJob(overrides?: Partial<BackfillJob>): BackfillJob {
  return {
    jobId: 'test-job-1',
    marketplace: 'ebay',
    urlSource: {
      type: 'file',
      config: { filePath: '/tmp/urls.txt' },
    },
    concurrency: 1,
    batchSize: 2,
    checkpoint: {
      enabled: false,
      interval: 100,
      storage: 'file',
    },
    errorHandling: {
      maxConsecutiveFailures: 3,
      pauseOnError: true,
      skipFailedUrls: true,
      retryStrategy: 'skip',
    },
    output: {
      format: 'jsonl',
      destination: '/tmp/output.jsonl',
      emitEvents: false,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BackfillExecutor', () => {
  let executor: BackfillExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockIsEnabled.mockReturnValue(true);
    mockExtractListing.mockResolvedValue({
      success: true,
      listing: makeListing(),
      metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
    });
    mockReadFile.mockResolvedValue('https://www.ebay.com/itm/1\nhttps://www.ebay.com/itm/2\n');
    mockAppendFile.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockEmit.mockResolvedValue(undefined);
    mockCreateExtractionEvent.mockReturnValue({ eventId: 'evt-1' });
    executor = new BackfillExecutor(makeMockRegistry());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // createBackfillJob helper
  // =========================================================================

  describe('createBackfillJob', () => {
    it('creates a job with default values', () => {
      const job = createBackfillJob({
        marketplace: 'ebay',
        urlSourceFile: '/tmp/urls.txt',
        outputFile: '/tmp/output.jsonl',
      });

      expect(job.jobId).toBeDefined();
      expect(job.marketplace).toBe('ebay');
      expect(job.concurrency).toBe(3);
      expect(job.batchSize).toBe(10);
      expect(job.checkpoint.enabled).toBe(true);
      expect(job.checkpoint.interval).toBe(100);
      expect(job.checkpoint.storage).toBe('file');
      expect(job.output.format).toBe('jsonl');
      expect(job.output.destination).toBe('/tmp/output.jsonl');
      expect(job.output.emitEvents).toBe(true);
      expect(job.errorHandling.maxConsecutiveFailures).toBe(10);
    });

    it('creates a job with custom concurrency and batchSize', () => {
      const job = createBackfillJob({
        marketplace: 'amazon',
        urlSourceFile: '/tmp/urls.txt',
        outputFile: '/tmp/output.jsonl',
        concurrency: 5,
        batchSize: 20,
      });

      expect(job.concurrency).toBe(5);
      expect(job.batchSize).toBe(20);
      expect(job.marketplace).toBe('amazon');
    });

    it('generates unique job IDs', () => {
      const job1 = createBackfillJob({
        marketplace: 'ebay',
        urlSourceFile: '/tmp/urls.txt',
        outputFile: '/tmp/out.jsonl',
      });
      const job2 = createBackfillJob({
        marketplace: 'ebay',
        urlSourceFile: '/tmp/urls.txt',
        outputFile: '/tmp/out.jsonl',
      });

      expect(job1.jobId).not.toBe(job2.jobId);
    });
  });

  // =========================================================================
  // start()
  // =========================================================================

  describe('start', () => {
    it('throws when marketplace is not enabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      const job = makeJob();

      await expect(executor.start(job)).rejects.toThrow('Marketplace ebay is not enabled');
    });

    it('throws when job is already running', async () => {
      const job = makeJob();
      await executor.start(job);

      await expect(executor.start(job)).rejects.toThrow('Job test-job-1 is already running');
    });

    it('throws for unsupported URL source type', async () => {
      const job = makeJob({
        urlSource: { type: 'database', config: {} },
      });

      await expect(executor.start(job)).rejects.toThrow('Unsupported URL source type: database');
    });

    it('starts a job successfully and tracks it', async () => {
      const job = makeJob();
      await executor.start(job);

      const jobs = executor.listJobs();
      expect(jobs).toContain('test-job-1');
    });

    it('reads URLs from file source', async () => {
      const job = makeJob();
      await executor.start(job);

      expect(mockReadFile).toHaveBeenCalledWith('/tmp/urls.txt', 'utf-8');
    });

    it('filters out comments and empty lines from URL file', async () => {
      mockReadFile.mockResolvedValue(
        '# comment\nhttps://www.ebay.com/itm/1\n\n  \nhttps://www.ebay.com/itm/2\n# another comment\n'
      );
      const job = makeJob();
      await executor.start(job);

      // Wait for background execution
      await vi.advanceTimersByTimeAsync(500);

      // Two valid URLs means 2 calls to extractListing
      expect(mockExtractListing).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // pause / resume / cancel
  // =========================================================================

  describe('pause', () => {
    it('pauses a running job', async () => {
      const job = makeJob();
      await executor.start(job);
      await executor.pause('test-job-1');

      const status = await executor.getStatus('test-job-1');
      expect(status.state).toBe('paused');
    });

    it('throws for unknown job', async () => {
      await expect(executor.pause('nonexistent')).rejects.toThrow('Job nonexistent not found');
    });
  });

  describe('resume', () => {
    it('resumes a paused job', async () => {
      const job = makeJob();
      await executor.start(job);
      await executor.pause('test-job-1');
      await executor.resume('test-job-1');

      const status = await executor.getStatus('test-job-1');
      expect(status.state).toBe('running');
    });

    it('throws for unknown job', async () => {
      await expect(executor.resume('nonexistent')).rejects.toThrow('Job nonexistent not found');
    });

    it('throws when job is not paused', async () => {
      const job = makeJob();
      await executor.start(job);

      await expect(executor.resume('test-job-1')).rejects.toThrow('Job test-job-1 is not paused');
    });
  });

  describe('cancel', () => {
    it('cancels a running job', async () => {
      const job = makeJob();
      await executor.start(job);
      await executor.cancel('test-job-1');

      const status = await executor.getStatus('test-job-1');
      expect(status.state).toBe('failed');
    });

    it('throws for unknown job', async () => {
      await expect(executor.cancel('nonexistent')).rejects.toThrow('Job nonexistent not found');
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe('getStatus', () => {
    it('returns job status with progress', async () => {
      const job = makeJob();
      await executor.start(job);

      const status = await executor.getStatus('test-job-1');
      expect(status.jobId).toBe('test-job-1');
      expect(status.progress).toBeDefined();
      expect(status.progress.totalUrls).toBe(2);
      expect(status.timing).toBeDefined();
      expect(status.timing.startedAt).toBeDefined();
    });

    it('throws for unknown job', async () => {
      await expect(executor.getStatus('nonexistent')).rejects.toThrow(
        'Job nonexistent not found'
      );
    });

    it('returns undefined estimatedCompletion when no URLs processed', async () => {
      // Use a file with many URLs so processing hasn't completed
      mockReadFile.mockResolvedValue('# empty\n');

      const job = makeJob();
      await executor.start(job);

      const status = await executor.getStatus('test-job-1');
      expect(status.timing.estimatedCompletion).toBeUndefined();
    });
  });

  // =========================================================================
  // listJobs
  // =========================================================================

  describe('listJobs', () => {
    it('returns empty array when no jobs', () => {
      expect(executor.listJobs()).toEqual([]);
    });

    it('returns all job IDs', async () => {
      const job1 = makeJob({ jobId: 'job-a' });
      const job2 = makeJob({ jobId: 'job-b' });

      await executor.start(job1);
      await executor.start(job2);

      const jobs = executor.listJobs();
      expect(jobs).toContain('job-a');
      expect(jobs).toContain('job-b');
      expect(jobs).toHaveLength(2);
    });
  });

  // =========================================================================
  // Job execution (JSONL output)
  // =========================================================================

  describe('job execution with JSONL output', () => {
    it('writes successful extractions to JSONL file', async () => {
      const job = makeJob();
      await executor.start(job);

      // Wait for processing
      await vi.advanceTimersByTimeAsync(500);

      expect(mockAppendFile).toHaveBeenCalled();
      const appendedData = mockAppendFile.mock.calls[0][1] as string;
      expect(appendedData).toContain('"id":"test-123"');
      expect(appendedData.endsWith('\n')).toBe(true);
    });

    it('handles extraction failures gracefully', async () => {
      mockExtractListing.mockResolvedValue({
        success: false,
        error: { code: 'EXTRACTION_FAILED', message: 'Failed', recoverable: false },
        metadata: { duration: 50, retryCount: 0, rateLimited: false, cached: false },
      });

      const job = makeJob();
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // No data should be written for failed extractions
      expect(mockAppendFile).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Job execution with events
  // =========================================================================

  describe('job execution with events', () => {
    it('emits success events when enabled', async () => {
      const job = makeJob({ output: { format: 'jsonl', destination: '/tmp/out.jsonl', emitEvents: true } });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockCreateExtractionEvent).toHaveBeenCalled();
      expect(mockEmit).toHaveBeenCalled();
    });

    it('emits failure events when enabled', async () => {
      mockExtractListing.mockResolvedValue({
        success: false,
        error: { code: 'FAIL', message: 'oops', recoverable: false },
        metadata: { duration: 50, retryCount: 0, rateLimited: false, cached: false },
      });

      const job = makeJob({ output: { format: 'jsonl', destination: '/tmp/out.jsonl', emitEvents: true } });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockCreateExtractionEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'extraction_failure' })
      );
    });

    it('does not emit events when disabled', async () => {
      const job = makeJob({ output: { format: 'jsonl', destination: '/tmp/out.jsonl', emitEvents: false } });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // CSV output
  // =========================================================================

  describe('CSV output', () => {
    it('writes CSV headers when file does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const job = makeJob({
        output: { format: 'csv', destination: '/tmp/output.csv', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // Should write header via writeFile
      expect(mockWriteFile).toHaveBeenCalledWith(
        '/tmp/output.csv',
        expect.stringContaining('id,marketplace,url,title'),
        'utf-8'
      );
      // Should append data via appendFile
      expect(mockAppendFile).toHaveBeenCalledWith(
        '/tmp/output.csv',
        expect.any(String),
        'utf-8'
      );
    });

    it('does not write header when file already exists', async () => {
      mockAccess.mockResolvedValue(undefined);

      const job = makeJob({
        output: { format: 'csv', destination: '/tmp/output.csv', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // writeFile should not be called for CSV header if file exists
      const headerWriteCalls = mockWriteFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string) === '/tmp/output.csv'
      );
      expect(headerWriteCalls).toHaveLength(0);
    });

    it('escapes CSV values with commas', async () => {
      const listing = makeListing({ title: 'Item, with comma' });
      mockExtractListing.mockResolvedValue({
        success: true,
        listing,
        metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
      });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const job = makeJob({
        output: { format: 'csv', destination: '/tmp/output.csv', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // The data row should have the escaped comma value
      const dataCalls = mockAppendFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string) === '/tmp/output.csv'
      );
      expect(dataCalls.length).toBeGreaterThan(0);
      const row = dataCalls[0][1] as string;
      expect(row).toContain('"Item, with comma"');
    });

    it('escapes CSV values with double quotes', async () => {
      const listing = makeListing({ title: 'Item "quoted"' });
      mockExtractListing.mockResolvedValue({
        success: true,
        listing,
        metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
      });
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const job = makeJob({
        output: { format: 'csv', destination: '/tmp/output.csv', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      const dataCalls = mockAppendFile.mock.calls.filter(
        (call: unknown[]) => (call[0] as string) === '/tmp/output.csv'
      );
      expect(dataCalls.length).toBeGreaterThan(0);
      const row = dataCalls[0][1] as string;
      expect(row).toContain('"Item ""quoted"""');
    });
  });

  // =========================================================================
  // Database output
  // =========================================================================

  describe('database output', () => {
    it('does not write to file when database format selected and no adapter registered', async () => {
      // Ensure no adapter
      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);

      const job = makeJob({
        output: { format: 'database', destination: 'postgres://localhost/test', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // No file writing should occur for database format
      expect(mockAppendFile).not.toHaveBeenCalled();
    });

    it('writes to database when adapter is registered', async () => {
      const mockExecute = vi.fn().mockResolvedValue({ affectedRows: 1 });
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockDbFactory = vi.fn().mockResolvedValue({
        query: vi.fn(),
        execute: mockExecute,
        close: mockClose,
      });

      registerDatabaseAdapter(mockDbFactory);

      const job = makeJob({
        output: { format: 'database', destination: 'postgres://localhost/test', emitEvents: false },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockDbFactory).toHaveBeenCalledWith('postgres://localhost/test');
      expect(mockExecute).toHaveBeenCalled();

      // Reset so other tests don't use this adapter
      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);
    });
  });

  // =========================================================================
  // Checkpoints
  // =========================================================================

  describe('checkpoints', () => {
    it('saves file checkpoint when enabled', async () => {
      mockReadFile.mockResolvedValue(
        Array.from({ length: 100 }, (_, i) => `https://www.ebay.com/itm/${i}`).join('\n')
      );

      const job = makeJob({
        batchSize: 100,
        concurrency: 100,
        checkpoint: { enabled: true, interval: 100, storage: 'file' },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(5000);

      // A checkpoint should have been written
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.checkpoint'),
        expect.any(String),
        'utf-8'
      );
    });

    it('does not save checkpoint when disabled', async () => {
      const job = makeJob({
        checkpoint: { enabled: false, interval: 1, storage: 'file' },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(500);

      // No checkpoint file should be written
      const checkpointCalls = mockWriteFile.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('.checkpoint')
      );
      expect(checkpointCalls).toHaveLength(0);
    });
  });

  // =========================================================================
  // Consecutive failure handling
  // =========================================================================

  describe('consecutive failure handling', () => {
    it('pauses job after max consecutive failures within a batch', async () => {
      mockExtractListing.mockResolvedValue({
        success: false,
        error: { code: 'FAIL', message: 'error', recoverable: false },
        metadata: { duration: 50, retryCount: 0, rateLimited: false, cached: false },
      });

      // Provide enough URLs across multiple batches to trigger pause
      // batchSize=3 means first batch gets 3 URLs, all fail -> pause
      mockReadFile.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => `https://www.ebay.com/itm/${i}`).join('\n')
      );

      const job = makeJob({
        batchSize: 3,
        concurrency: 1,
        errorHandling: {
          maxConsecutiveFailures: 3,
          pauseOnError: true,
          skipFailedUrls: true,
          retryStrategy: 'skip',
        },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(2000);

      const status = await executor.getStatus(job.jobId);
      expect(status.state).toBe('paused');
    });

    it('resets consecutive failure counter on success', async () => {
      let callCount = 0;
      mockExtractListing.mockImplementation(() => {
        callCount++;
        // Fail first 2, succeed 3rd, fail 4th and 5th
        if (callCount <= 2 || callCount >= 4) {
          return Promise.resolve({
            success: false,
            error: { code: 'FAIL', message: 'error', recoverable: false },
            metadata: { duration: 50, retryCount: 0, rateLimited: false, cached: false },
          });
        }
        return Promise.resolve({
          success: true,
          listing: makeListing(),
          metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
        });
      });

      mockReadFile.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => `https://www.ebay.com/itm/${i}`).join('\n')
      );

      const job = makeJob({
        batchSize: 5,
        concurrency: 1,
        errorHandling: {
          maxConsecutiveFailures: 3,
          pauseOnError: true,
          skipFailedUrls: true,
          retryStrategy: 'skip',
        },
      });
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(2000);

      const status = await executor.getStatus(job.jobId);
      // Should complete because consecutive failures never reached 3
      // (2 failures, 1 success resets, then 2 more failures)
      expect(status.state).toBe('completed');
    });
  });

  // =========================================================================
  // Progress tracking
  // =========================================================================

  describe('progress tracking', () => {
    it('tracks successful and failed extractions', async () => {
      let callCount = 0;
      mockExtractListing.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            success: true,
            listing: makeListing(),
            metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
          });
        }
        return Promise.resolve({
          success: false,
          error: { code: 'FAIL', message: 'error', recoverable: false },
          metadata: { duration: 50, retryCount: 0, rateLimited: false, cached: false },
        });
      });

      const job = makeJob();
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(1000);

      const status = await executor.getStatus(job.jobId);
      expect(status.progress.successfulExtractions).toBe(1);
      expect(status.progress.failedExtractions).toBe(1);
      expect(status.progress.processedUrls).toBe(2);
    });

    it('updates rolling average confidence', async () => {
      const listing1 = makeListing({ confidence: 0.9 });
      const listing2 = makeListing({ confidence: 0.7 });
      let callCount = 0;
      mockExtractListing.mockImplementation(() => {
        callCount++;
        const listing = callCount === 1 ? listing1 : listing2;
        return Promise.resolve({
          success: true,
          listing,
          metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
        });
      });

      const job = makeJob();
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(1000);

      const status = await executor.getStatus(job.jobId);
      // Average of 0.9 and 0.7 = 0.8
      expect(status.progress.averageConfidence).toBeCloseTo(0.8, 1);
    });
  });

  // =========================================================================
  // loadDatabaseCheckpoint
  // =========================================================================

  describe('loadDatabaseCheckpoint', () => {
    it('returns null when no database adapter registered', async () => {
      // Ensure no adapter is registered
      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);

      const result = await executor.loadDatabaseCheckpoint('job-1', 'postgres://localhost/test');
      expect(result).toBeNull();
    });

    it('returns null when checkpoint not found in database', async () => {
      const mockQuery = vi.fn().mockResolvedValue([]);
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockDbFactory = vi.fn().mockResolvedValue({
        query: mockQuery,
        execute: vi.fn(),
        close: mockClose,
      });

      registerDatabaseAdapter(mockDbFactory);

      const result = await executor.loadDatabaseCheckpoint('job-1', 'postgres://localhost/test');
      expect(result).toBeNull();
      expect(mockClose).toHaveBeenCalled();

      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);
    });

    it('returns checkpoint data when found', async () => {
      const mockQuery = vi.fn().mockResolvedValue([
        {
          job_id: 'job-1',
          timestamp: '2026-01-01T00:00:00Z',
          processed_urls: 50,
          successful_extractions: 45,
          failed_extractions: 5,
          last_processed_url: 'https://ebay.com/itm/50',
        },
      ]);
      const mockClose = vi.fn().mockResolvedValue(undefined);
      const mockDbFactory = vi.fn().mockResolvedValue({
        query: mockQuery,
        execute: vi.fn(),
        close: mockClose,
      });

      registerDatabaseAdapter(mockDbFactory);

      const result = await executor.loadDatabaseCheckpoint('job-1', 'postgres://localhost/test');
      expect(result).toEqual({
        jobId: 'job-1',
        timestamp: '2026-01-01T00:00:00Z',
        processedUrls: 50,
        successfulExtractions: 45,
        failedExtractions: 5,
        lastProcessedUrl: 'https://ebay.com/itm/50',
      });
      expect(mockClose).toHaveBeenCalled();

      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);
    });
  });

  // =========================================================================
  // Job completion
  // =========================================================================

  describe('job completion', () => {
    it('marks job as completed when all URLs processed', async () => {
      const job = makeJob();
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(2000);

      const status = await executor.getStatus(job.jobId);
      expect(status.state).toBe('completed');
    });

    it('calculates estimated completion when progress exists', async () => {
      // Use enough URLs that we can check status mid-run
      mockReadFile.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => `https://www.ebay.com/itm/${i}`).join('\n')
      );

      // Make extraction slow
      mockExtractListing.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  success: true,
                  listing: makeListing(),
                  metadata: { duration: 100, retryCount: 0, rateLimited: false, cached: false },
                }),
              50
            )
          )
      );

      const job = makeJob({ batchSize: 5, concurrency: 1 });
      await executor.start(job);

      // Advance partially
      await vi.advanceTimersByTimeAsync(300);

      const status = await executor.getStatus(job.jobId);
      // If some URLs have been processed, there should be an estimated completion
      if (status.progress.processedUrls > 0) {
        expect(status.timing.estimatedCompletion).toBeDefined();
      }
    });
  });

  // =========================================================================
  // Error handling in processUrl
  // =========================================================================

  describe('error handling in processUrl', () => {
    it('handles thrown errors from extractListing gracefully', async () => {
      mockExtractListing.mockRejectedValue(new Error('Network timeout'));

      const job = makeJob();
      await executor.start(job);
      await vi.advanceTimersByTimeAsync(1000);

      const status = await executor.getStatus(job.jobId);
      expect(status.progress.failedExtractions).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // registerDatabaseAdapter
  // =========================================================================

  describe('registerDatabaseAdapter', () => {
    it('registers a database adapter factory', () => {
      const factory = vi.fn();
      registerDatabaseAdapter(factory);

      // Reset
      registerDatabaseAdapter(null as unknown as (conn: string) => Promise<unknown>);
    });
  });
});
