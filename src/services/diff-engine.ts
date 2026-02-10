/**
 * Content Diff Engine for Change Detection
 *
 * Detects and describes changes between versioned page snapshots.
 * Uses LCS-based line diffing and SHA-256 content addressing for
 * efficient storage and comparison.
 *
 * @module services/diff-engine
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentSnapshot {
  url: string;
  urlHash: string;
  contentHash: string;
  content: string;
  title?: string;
  timestamp: string; // ISO 8601
  metadata?: Record<string, unknown>;
}

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNumber?: number;
}

export interface DiffResult {
  lines: DiffLine[];
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  changePercent: number;
}

export interface ChangeDetection {
  url: string;
  hasChanged: boolean;
  changePercent: number;
  diff: DiffResult;
  summary: string;
  previousSnapshot?: ContentSnapshot;
  currentSnapshot: ContentSnapshot;
}

export interface ChangeHistoryEntry {
  timestamp: string;
  contentHash: string;
  changePercent: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of a string. */
const sha256 = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * Monotonic counter appended to filenames to prevent collisions when
 * multiple snapshots are taken within the same millisecond.
 */
let snapshotSeq = 0;

/** Truncated SHA-256 of a normalised URL, used as the directory name. */
const urlToHash = (url: string): string => {
  const normalised = url.trim().toLowerCase().replace(/\/+$/, '');
  return sha256(normalised).slice(0, 16);
};

/**
 * Compute the longest common subsequence table for two string arrays.
 *
 * Returns an (m+1) x (n+1) table where table[i][j] is the LCS length
 * of a[0..i-1] and b[0..j-1].
 */
const buildLCSTable = (a: string[], b: string[]): number[][] => {
  const m = a.length;
  const n = b.length;
  // Allocate table filled with zeros
  const table: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
};

/**
 * Back-track through the LCS table to produce a list of DiffLine entries.
 *
 * Lines present only in `a` are marked "removed"; lines present only in `b`
 * are marked "added"; common lines are "unchanged".
 */
const backtrackDiff = (
  table: number[][],
  a: string[],
  b: string[],
  i: number,
  j: number
): DiffLine[] => {
  // Iterative implementation to avoid stack overflow on very large inputs.
  const result: DiffLine[] = [];

  let ci = i;
  let cj = j;

  while (ci > 0 || cj > 0) {
    if (ci > 0 && cj > 0 && a[ci - 1] === b[cj - 1]) {
      result.push({ type: 'unchanged', content: a[ci - 1] });
      ci--;
      cj--;
    } else if (cj > 0 && (ci === 0 || table[ci][cj - 1] >= table[ci - 1][cj])) {
      result.push({ type: 'added', content: b[cj - 1] });
      cj--;
    } else {
      result.push({ type: 'removed', content: a[ci - 1] });
      ci--;
    }
  }

  // The backtrack builds the list in reverse order.
  result.reverse();

  // Assign line numbers relative to original (for removed/unchanged) and
  // new (for added/unchanged) sequences.
  let oldLine = 1;
  let newLine = 1;
  for (const line of result) {
    if (line.type === 'removed') {
      line.lineNumber = oldLine++;
    } else if (line.type === 'added') {
      line.lineNumber = newLine++;
    } else {
      // unchanged — advance both counters; report the new-side number
      line.lineNumber = newLine;
      oldLine++;
      newLine++;
    }
  }

  return result;
};

/**
 * Compute line-level diff between two strings.
 */
const computeDiff = (oldText: string, newText: string): DiffResult => {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const table = buildLCSTable(oldLines, newLines);
  const lines = backtrackDiff(table, oldLines, newLines, oldLines.length, newLines.length);

  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;

  for (const line of lines) {
    switch (line.type) {
      case 'added':
        addedCount++;
        break;
      case 'removed':
        removedCount++;
        break;
      case 'unchanged':
        unchangedCount++;
        break;
    }
  }

  const maxTotal = Math.max(oldLines.length, newLines.length, 1);
  const changePercent = Math.round(((addedCount + removedCount) / maxTotal) * 10000) / 100;

  return { lines, addedCount, removedCount, unchangedCount, changePercent };
};

/**
 * Generate a human-readable summary from a DiffResult.
 *
 * Counts contiguous blocks of additions/removals as "sections" so the
 * summary reads naturally (e.g. "2 sections added, 1 removed").
 */
const generateSummary = (diff: DiffResult): string => {
  if (diff.addedCount === 0 && diff.removedCount === 0) {
    return 'No changes detected';
  }

  let addedSections = 0;
  let removedSections = 0;
  let modifiedSections = 0;

  let inAddBlock = false;
  let inRemoveBlock = false;

  for (const line of diff.lines) {
    if (line.type === 'added') {
      if (!inAddBlock) {
        inAddBlock = true;
        // If we just finished a remove block this is a modification
        if (inRemoveBlock) {
          // Convert the remove block into a modification
          removedSections--; // undo the count from the remove block start
          modifiedSections++;
          inRemoveBlock = false;
        } else {
          addedSections++;
        }
      }
    } else if (line.type === 'removed') {
      if (!inRemoveBlock) {
        inRemoveBlock = true;
        // If we just finished an add block this is a modification
        if (inAddBlock) {
          addedSections--; // undo the count from the add block start
          modifiedSections++;
          inAddBlock = false;
        } else {
          removedSections++;
        }
      }
    } else {
      // unchanged line — close any open blocks
      inAddBlock = false;
      inRemoveBlock = false;
    }

  }

  const parts: string[] = [];
  if (addedSections > 0) {
    parts.push(`${addedSections} section${addedSections === 1 ? '' : 's'} added`);
  }
  if (removedSections > 0) {
    parts.push(`${removedSections} section${removedSections === 1 ? '' : 's'} removed`);
  }
  if (modifiedSections > 0) {
    parts.push(`${modifiedSections} section${modifiedSections === 1 ? '' : 's'} modified`);
  }

  if (parts.length === 0) {
    // Edge case: all changes are interleaved single lines
    if (diff.addedCount > 0) {
      parts.push(`${diff.addedCount} line${diff.addedCount === 1 ? '' : 's'} added`);
    }
    if (diff.removedCount > 0) {
      parts.push(`${diff.removedCount} line${diff.removedCount === 1 ? '' : 's'} removed`);
    }
  }

  return parts.join(', ');
};

// ---------------------------------------------------------------------------
// DiffEngine
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = join(__dirname, '..', '..', 'data', 'snapshots');

export class DiffEngine {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
  }

  // -----------------------------------------------------------------------
  // Snapshot storage
  // -----------------------------------------------------------------------

  /**
   * Take a versioned snapshot of extracted content for the given URL.
   *
   * The snapshot is persisted to disk under `{dataDir}/{urlHash}/{timestamp}.json`.
   */
  async takeSnapshot(
    url: string,
    content: string,
    metadata?: Record<string, unknown> & { title?: string }
  ): Promise<ContentSnapshot> {
    const urlHash = urlToHash(url);
    const contentHash = sha256(content);
    const timestamp = new Date().toISOString();

    const snapshot: ContentSnapshot = {
      url,
      urlHash,
      contentHash,
      content,
      title: metadata?.title,
      timestamp,
      metadata
    };

    const dir = join(this.dataDir, urlHash);
    await fs.mkdir(dir, { recursive: true });

    // Use a filesystem-safe timestamp (replace colons) with a monotonic
    // sequence suffix to prevent collisions for rapid-fire snapshots.
    const safeTs = timestamp.replace(/:/g, '-');
    const seq = String(snapshotSeq++).padStart(4, '0');
    const filePath = join(dir, `${safeTs}_${seq}.json`);

    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

    logger.info('Snapshot saved', { url, urlHash, contentHash, filePath });
    return snapshot;
  }

  // -----------------------------------------------------------------------
  // Diff computation
  // -----------------------------------------------------------------------

  /**
   * Compute a structured diff between two snapshots.
   */
  diff(snapshotA: ContentSnapshot, snapshotB: ContentSnapshot): DiffResult {
    return computeDiff(snapshotA.content, snapshotB.content);
  }

  // -----------------------------------------------------------------------
  // Change detection
  // -----------------------------------------------------------------------

  /**
   * Compare new content against the most recent snapshot for a URL.
   *
   * Automatically takes a new snapshot and returns a detailed change report.
   */
  async detectChanges(
    url: string,
    newContent: string,
    metadata?: Record<string, unknown> & { title?: string }
  ): Promise<ChangeDetection> {
    const previous = await this.getLatestSnapshot(url);
    const current = await this.takeSnapshot(url, newContent, metadata);

    if (!previous) {
      logger.info('No previous snapshot; treating as first capture', { url });
      const lines = newContent.split('\n');
      return {
        url,
        hasChanged: true,
        changePercent: 100,
        diff: {
          lines: lines.map((content, idx) => ({
            type: 'added' as const,
            content,
            lineNumber: idx + 1
          })),
          addedCount: lines.length,
          removedCount: 0,
          unchangedCount: 0,
          changePercent: 100
        },
        summary: 'Initial snapshot (no previous version)',
        currentSnapshot: current
      };
    }

    // Fast-path: identical content hashes mean no change
    if (previous.contentHash === current.contentHash) {
      return {
        url,
        hasChanged: false,
        changePercent: 0,
        diff: {
          lines: current.content.split('\n').map((content, idx) => ({
            type: 'unchanged' as const,
            content,
            lineNumber: idx + 1
          })),
          addedCount: 0,
          removedCount: 0,
          unchangedCount: current.content.split('\n').length,
          changePercent: 0
        },
        summary: 'No changes detected',
        previousSnapshot: previous,
        currentSnapshot: current
      };
    }

    const diffResult = computeDiff(previous.content, current.content);
    const summary = generateSummary(diffResult);

    return {
      url,
      hasChanged: true,
      changePercent: diffResult.changePercent,
      diff: diffResult,
      summary,
      previousSnapshot: previous,
      currentSnapshot: current
    };
  }

  // -----------------------------------------------------------------------
  // Snapshot management
  // -----------------------------------------------------------------------

  /**
   * List all snapshots for a URL, sorted by timestamp (oldest first).
   */
  async getSnapshots(url: string): Promise<ContentSnapshot[]> {
    const urlHash = urlToHash(url);
    const dir = join(this.dataDir, urlHash);

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();

    const snapshots: ContentSnapshot[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await fs.readFile(join(dir, file), 'utf8');
        snapshots.push(JSON.parse(raw) as ContentSnapshot);
      } catch (err) {
        logger.warn('Failed to read snapshot file', {
          file,
          error: err instanceof Error ? err.message : 'unknown'
        });
      }
    }

    return snapshots;
  }

  /**
   * Get the most recent snapshot for a URL, or `null` if none exists.
   */
  async getLatestSnapshot(url: string): Promise<ContentSnapshot | null> {
    const snapshots = await this.getSnapshots(url);
    if (snapshots.length === 0) {
      return null;
    }
    return snapshots[snapshots.length - 1];
  }

  /**
   * Keep only the `keepCount` most recent snapshots for a URL.
   *
   * Returns the number of snapshots that were deleted.
   */
  async pruneSnapshots(url: string, keepCount: number): Promise<number> {
    const urlHash = urlToHash(url);
    const dir = join(this.dataDir, urlHash);

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return 0;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();

    if (jsonFiles.length <= keepCount) {
      return 0;
    }

    const toDelete = jsonFiles.slice(0, jsonFiles.length - keepCount);
    let deleted = 0;

    for (const file of toDelete) {
      try {
        await fs.unlink(join(dir, file));
        deleted++;
      } catch (err) {
        logger.warn('Failed to delete snapshot file', {
          file,
          error: err instanceof Error ? err.message : 'unknown'
        });
      }
    }

    logger.info('Pruned snapshots', { url, deleted, kept: keepCount });
    return deleted;
  }

  /**
   * Return the change history (timeline) for a URL.
   *
   * Each entry shows the change percentage relative to the previous snapshot.
   */
  async getHistory(url: string): Promise<ChangeHistoryEntry[]> {
    const snapshots = await this.getSnapshots(url);

    if (snapshots.length === 0) {
      return [];
    }

    const history: ChangeHistoryEntry[] = [];

    // First snapshot has no predecessor — report as 100 % new.
    history.push({
      timestamp: snapshots[0].timestamp,
      contentHash: snapshots[0].contentHash,
      changePercent: 100,
      summary: 'Initial snapshot'
    });

    for (let i = 1; i < snapshots.length; i++) {
      const prev = snapshots[i - 1];
      const curr = snapshots[i];

      if (prev.contentHash === curr.contentHash) {
        history.push({
          timestamp: curr.timestamp,
          contentHash: curr.contentHash,
          changePercent: 0,
          summary: 'No changes detected'
        });
      } else {
        const diffResult = computeDiff(prev.content, curr.content);
        history.push({
          timestamp: curr.timestamp,
          contentHash: curr.contentHash,
          changePercent: diffResult.changePercent,
          summary: generateSummary(diffResult)
        });
      }
    }

    return history;
  }
}

// ---------------------------------------------------------------------------
// Singleton export (matches codebase convention)
// ---------------------------------------------------------------------------

export const diffEngine = new DiffEngine();
