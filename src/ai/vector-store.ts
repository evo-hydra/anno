/* eslint-disable @typescript-eslint/no-explicit-any */
// Redis type is complex and varies - using any for flexibility

export interface VectorMetadata extends Record<string, unknown> {
  url?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface VectorEntry {
  id: string;
  vector: number[];
  metadata?: VectorMetadata;
  content?: string;
  createdAt: number;
}

export interface SimilarityResult {
  id: string;
  score: number;
  metadata?: VectorMetadata;
  content?: string;
}

export interface SimilaritySearchOptions {
  k?: number;
  filter?: Partial<VectorMetadata>;
  minScore?: number;
}

export interface VectorStore {
  addEntries(entries: VectorEntry[]): Promise<void>;
  similaritySearch(vector: number[], options?: SimilaritySearchOptions): Promise<SimilarityResult[]>;
  clear(): Promise<void>;
  size(): number;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly entries: VectorEntry[] = [];

  async addEntries(entries: VectorEntry[]): Promise<void> {
    const timestamp = Date.now();
    for (const entry of entries) {
      this.entries.push({ ...entry, createdAt: entry.createdAt ?? timestamp });
    }
  }

  async similaritySearch(vector: number[], options: SimilaritySearchOptions = {}): Promise<SimilarityResult[]> {
    const { k = 5, filter, minScore = -Infinity } = options;

    const matches = this.entries
      .filter((entry) => this.matchesFilter(entry.metadata, filter))
      .map((entry) => ({
        entry,
        score: this.cosineSimilarity(vector, entry.vector)
      }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ entry, score }) => ({
        id: entry.id,
        score,
        metadata: entry.metadata,
        content: entry.content
      }));

    return matches;
  }

  async clear(): Promise<void> {
    this.entries.length = 0;
  }

  size(): number {
    return this.entries.length;
  }

  private matchesFilter(metadata: VectorMetadata | undefined, filter: Partial<VectorMetadata> | undefined): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }
    if (!metadata) {
      return false;
    }
    return Object.entries(filter).every(([key, value]) => {
      const metadataValue = metadata[key];
      if (Array.isArray(value) && Array.isArray(metadataValue)) {
        return value.every((item) => metadataValue.includes(item));
      }
      return metadataValue === value;
    });
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * Redis-backed vector store for production persistence
 * Stores vectors in Redis with JSON serialization
 */
export class RedisVectorStore implements VectorStore {
  private redis: any;
  private readonly keyPrefix: string;
  private cachedSize: number = 0;

  constructor(redis: any, keyPrefix = 'anno:vectors:') {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
  }

  async addEntries(entries: VectorEntry[]): Promise<void> {
    const timestamp = Date.now();
    const pipeline = this.redis.multi();

    for (const entry of entries) {
      const key = `${this.keyPrefix}${entry.id}`;
      const value = JSON.stringify({
        ...entry,
        createdAt: entry.createdAt ?? timestamp
      });
      pipeline.set(key, value);
    }

    await pipeline.exec();
    this.cachedSize += entries.length;
  }

  async similaritySearch(vector: number[], options: SimilaritySearchOptions = {}): Promise<SimilarityResult[]> {
    const { k = 5, filter, minScore = -Infinity } = options;

    // Get all vector keys
    const keys = await this.redis.keys(`${this.keyPrefix}*`);

    if (keys.length === 0) {
      return [];
    }

    // Fetch all vectors
    const values = await this.redis.mGet(keys);

    const entries: VectorEntry[] = values
      .filter((v: string | null) => v !== null)
      .map((v: string) => JSON.parse(v));

    // Compute similarities
    const matches = entries
      .filter((entry) => this.matchesFilter(entry.metadata, filter))
      .map((entry) => ({
        entry,
        score: this.cosineSimilarity(vector, entry.vector)
      }))
      .filter(({ score }) => score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ entry, score }) => ({
        id: entry.id,
        score,
        metadata: entry.metadata,
        content: entry.content
      }));

    return matches;
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) {
      await this.redis.del(keys);
    }
    this.cachedSize = 0;
  }

  size(): number {
    return this.cachedSize;
  }

  private matchesFilter(metadata: VectorMetadata | undefined, filter: Partial<VectorMetadata> | undefined): boolean {
    if (!filter || Object.keys(filter).length === 0) {
      return true;
    }
    if (!metadata) {
      return false;
    }
    return Object.entries(filter).every(([key, value]) => {
      const metadataValue = metadata[key];
      if (Array.isArray(value) && Array.isArray(metadataValue)) {
        return value.every((item) => metadataValue.includes(item));
      }
      return metadataValue === value;
    });
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    const length = Math.min(a.length, b.length);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
      return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Initialize cache size by counting keys
   */
  async initialize(): Promise<void> {
    const keys = await this.redis.keys(`${this.keyPrefix}*`);
    this.cachedSize = keys.length;
  }
}
