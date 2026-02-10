import type { FetchMode, RenderDiagnostics } from './fetcher';

type RenderFallbackReason = NonNullable<RenderDiagnostics['fallbackReason']>;

const RENDER_DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10];

type HistogramBuckets = Record<number, number>;

interface FetchMetricsState {
  totalRequests: number;
  totalFromCache: number;
  cacheHits: number;
  cacheMisses: number;
  cacheValidations: number;
  notModifiedResponses: number;
  cacheLookupDurationMs: number[];
  robotsBlockedRequests: number;
  rateLimitedRequests: number;
  rateLimitWaitMs: number[];
  protocolUsage: Record<string, number>; // Track HTTP/2, HTTP/1.1, etc.
  requestedRendered: number;
  attemptedRendered: number;
  effectiveRendered: number;
  renderSuccess: number;
  renderFallbacks: number;
  renderDisabled: number;
  renderErrors: number;
  renderDurationSecondsCount: number;
  renderDurationSecondsSum: number;
  renderDurationSecondsBuckets: Record<number, number>;
  renderFallbackSecondsCount: number;
  renderFallbackSecondsSum: number;
  renderFallbackSecondsBuckets: Record<number, number>;
  lastRenderError: {
    reason: RenderFallbackReason;
    message: string | undefined;
    timestamp: number;
  } | null;
  lastRequestAt: number | null;
}

interface AIMetricsState {
  embeddingsGenerated: number;
  embeddingDurationMs: number[];
  embeddingErrors: number;
  summariesGenerated: number;
  summarizationDurationMs: number[];
  summarizationErrors: number;
  ragQueriesTotal: number;
  ragQueryDurationMs: number[];
  ragQueryErrors: number;
  vectorSearches: number;
  vectorSearchDurationMs: number[];
  memoryOperations: number;
  providerUsage: Record<string, number>; // Track openai, anthropic, deterministic, heuristic
}

interface SecurityMetricsState {
  authFailuresTotal: number;
  authSuccessTotal: number;
  rateLimitExceededTotal: number;
  promptInjectionsDetected: Record<string, number>; // By threat type
  unsafeQueriesTotal: number;
  unsafeContentTotal: number;
  sanitizationsPerformed: number;
}

const createInitialState = (): FetchMetricsState => ({
  totalRequests: 0,
  totalFromCache: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheValidations: 0,
  notModifiedResponses: 0,
  cacheLookupDurationMs: [],
  robotsBlockedRequests: 0,
  rateLimitedRequests: 0,
  rateLimitWaitMs: [],
  protocolUsage: {},
  requestedRendered: 0,
  attemptedRendered: 0,
  effectiveRendered: 0,
  renderSuccess: 0,
  renderFallbacks: 0,
  renderDisabled: 0,
  renderErrors: 0,
  renderDurationSecondsCount: 0,
  renderDurationSecondsSum: 0,
  renderDurationSecondsBuckets: Object.fromEntries(RENDER_DURATION_BUCKETS.map((bucket) => [bucket, 0])),
  renderFallbackSecondsCount: 0,
  renderFallbackSecondsSum: 0,
  renderFallbackSecondsBuckets: Object.fromEntries(RENDER_DURATION_BUCKETS.map((bucket) => [bucket, 0])),
  lastRenderError: null,
  lastRequestAt: null
});

const createInitialAIState = (): AIMetricsState => ({
  embeddingsGenerated: 0,
  embeddingDurationMs: [],
  embeddingErrors: 0,
  summariesGenerated: 0,
  summarizationDurationMs: [],
  summarizationErrors: 0,
  ragQueriesTotal: 0,
  ragQueryDurationMs: [],
  ragQueryErrors: 0,
  vectorSearches: 0,
  vectorSearchDurationMs: [],
  memoryOperations: 0,
  providerUsage: {}
});

const createInitialSecurityState = (): SecurityMetricsState => ({
  authFailuresTotal: 0,
  authSuccessTotal: 0,
  rateLimitExceededTotal: 0,
  promptInjectionsDetected: {},
  unsafeQueriesTotal: 0,
  unsafeContentTotal: 0,
  sanitizationsPerformed: 0
});

const fetchState: FetchMetricsState = createInitialState();
const aiState: AIMetricsState = createInitialAIState();
const securityState: SecurityMetricsState = createInitialSecurityState();

export interface FetchMetricsEvent {
  requestedMode: FetchMode;
  effectiveMode: FetchMode;
  attempted: boolean;
  rendered: boolean;
  fromCache: boolean;
  fallbackReason?: RenderFallbackReason;
  errorMessage?: string;
  renderDurationSeconds?: number;
  renderFallbackSeconds?: number;
}

export type FetchMetricsSnapshot = FetchMetricsState;
export type AIMetricsSnapshot = AIMetricsState;

export interface MetricsSnapshot {
  fetch: FetchMetricsSnapshot;
  ai: AIMetricsSnapshot;
}

export interface LatencySummary {
  render: {
    averageSeconds: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
  };
  fallback: {
    averageSeconds: number | null;
    p50Seconds: number | null;
    p95Seconds: number | null;
  };
}

export const recordFetchMetrics = (event: FetchMetricsEvent): void => {
  fetchState.totalRequests += 1;
  fetchState.lastRequestAt = Date.now();

  if (event.fromCache) {
    fetchState.totalFromCache += 1;
  }

  if (event.requestedMode === 'rendered') {
    fetchState.requestedRendered += 1;
  }

  if (event.attempted) {
    fetchState.attemptedRendered += 1;
  }

  if (event.effectiveMode === 'rendered') {
    fetchState.effectiveRendered += 1;
  }

  if (event.rendered) {
    fetchState.renderSuccess += 1;

    if (typeof event.renderDurationSeconds === 'number') {
      fetchState.renderDurationSecondsCount += 1;
      fetchState.renderDurationSecondsSum += event.renderDurationSeconds;

      for (const bucket of RENDER_DURATION_BUCKETS) {
        if (event.renderDurationSeconds <= bucket) {
          fetchState.renderDurationSecondsBuckets[bucket] += 1;
        }
      }
    }
  }

  if (event.fallbackReason) {
    fetchState.renderFallbacks += 1;
    if (event.fallbackReason === 'rendering_disabled') {
      fetchState.renderDisabled += 1;
    } else {
      fetchState.renderErrors += 1;
      fetchState.lastRenderError = {
        reason: event.fallbackReason,
        message: event.errorMessage,
        timestamp: Date.now()
      };
    }

    if (typeof event.renderFallbackSeconds === 'number') {
      fetchState.renderFallbackSecondsCount += 1;
      fetchState.renderFallbackSecondsSum += event.renderFallbackSeconds;

      for (const bucket of RENDER_DURATION_BUCKETS) {
        if (event.renderFallbackSeconds <= bucket) {
          fetchState.renderFallbackSecondsBuckets[bucket] += 1;
        }
      }
    }
  }
};

export const getMetricsSnapshot = (): MetricsSnapshot => ({
  fetch: { ...fetchState },
  ai: { ...aiState }
});

export const resetMetrics = (): void => {
  const initialFetch = createInitialState();
  const initialAI = createInitialAIState();
  Object.assign(fetchState, initialFetch);
  Object.assign(aiState, initialAI);
};

const formatGauge = (name: string, help: string, value: number): string =>
  `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;

const formatCounter = (name: string, help: string, value: number): string =>
  `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;

const estimatePercentile = (
  buckets: HistogramBuckets,
  count: number,
  percentile: number
): number | null => {
  if (count === 0) {
    return null;
  }

  const target = count * percentile;
  let running = 0;

  for (const bucket of RENDER_DURATION_BUCKETS) {
    running += buckets[bucket] ?? 0;
    if (running >= target) {
      return bucket;
    }
  }

  return null;
};

export const renderPrometheusMetrics = (): string => {
  const snapshot = getMetricsSnapshot();

  const lines = [
    formatCounter('anno_fetch_total', 'Total fetch requests processed', snapshot.fetch.totalRequests),
    formatCounter('anno_fetch_from_cache_total', 'Number of fetches served from cache', snapshot.fetch.totalFromCache),
    formatCounter('anno_fetch_cache_hits_total', 'Cache hits counted separately', snapshot.fetch.cacheHits),
    formatCounter('anno_fetch_cache_misses_total', 'Cache misses counted separately', snapshot.fetch.cacheMisses),
    formatCounter('anno_cache_validations_total', 'Conditional cache validation attempts', snapshot.fetch.cacheValidations),
    formatCounter('anno_304_responses_total', 'HTTP 304 Not Modified responses observed', snapshot.fetch.notModifiedResponses),
    formatCounter('anno_robots_blocked_total', 'Requests blocked by robots.txt', snapshot.fetch.robotsBlockedRequests),
    formatCounter('anno_rate_limited_total', 'Requests that were rate limited', snapshot.fetch.rateLimitedRequests),
    formatCounter('anno_render_requested_total', 'Number of requests asking for rendered mode', snapshot.fetch.requestedRendered),
    formatCounter('anno_render_attempted_total', 'Number of times rendering was attempted', snapshot.fetch.attemptedRendered),
    formatCounter('anno_render_success_total', 'Successful rendered fetches', snapshot.fetch.renderSuccess),
    formatCounter('anno_render_fallback_total', 'Render attempts that fell back to HTTP', snapshot.fetch.renderFallbacks),
    formatCounter('anno_render_disabled_total', 'Requests falling back because rendering disabled', snapshot.fetch.renderDisabled),
    formatCounter('anno_render_errors_total', 'Render attempts failing for other reasons', snapshot.fetch.renderErrors),
    formatGauge('anno_last_request_timestamp', 'Unix timestamp of the last request processed', snapshot.fetch.lastRequestAt ?? 0)
  ];

  lines.push('# HELP anno_render_duration_seconds Rendered fetch duration histogram (seconds)');
  lines.push('# TYPE anno_render_duration_seconds histogram');

  for (const bucket of RENDER_DURATION_BUCKETS) {
    const count = snapshot.fetch.renderDurationSecondsBuckets[bucket] ?? 0;
    lines.push(`anno_render_duration_seconds_bucket{le="${bucket}"} ${count}`);
  }

  lines.push(
    `anno_render_duration_seconds_bucket{le="+Inf"} ${snapshot.fetch.renderDurationSecondsCount}`
  );
  lines.push(`anno_render_duration_seconds_sum ${snapshot.fetch.renderDurationSecondsSum}`);
  lines.push(`anno_render_duration_seconds_count ${snapshot.fetch.renderDurationSecondsCount}`);

  lines.push('# HELP anno_render_fallback_seconds Render render-fallback duration histogram (seconds)');
  lines.push('# TYPE anno_render_fallback_seconds histogram');

  for (const bucket of RENDER_DURATION_BUCKETS) {
    const count = snapshot.fetch.renderFallbackSecondsBuckets[bucket] ?? 0;
    lines.push(`anno_render_fallback_seconds_bucket{le="${bucket}"} ${count}`);
  }

  lines.push(
    `anno_render_fallback_seconds_bucket{le="+Inf"} ${snapshot.fetch.renderFallbackSecondsCount}`
  );
  lines.push(`anno_render_fallback_seconds_sum ${snapshot.fetch.renderFallbackSecondsSum}`);
  lines.push(`anno_render_fallback_seconds_count ${snapshot.fetch.renderFallbackSecondsCount}`);

  if (snapshot.fetch.lastRenderError) {
    const { reason, message, timestamp } = snapshot.fetch.lastRenderError;
    lines.push(
      `# HELP anno_last_render_error_info Last render error reason and message\n` +
        `# TYPE anno_last_render_error_info gauge\n` +
        `anno_last_render_error_info{reason="${reason}",message="${message ?? ''}"} ${timestamp}`
    );
  }

  // AI Metrics
  lines.push('');
  lines.push(formatCounter('anno_ai_embeddings_total', 'Total embeddings generated', aiState.embeddingsGenerated));
  lines.push(formatCounter('anno_ai_embedding_errors_total', 'Embedding generation errors', aiState.embeddingErrors));
  lines.push(formatCounter('anno_ai_summaries_total', 'Total summaries generated', aiState.summariesGenerated));
  lines.push(formatCounter('anno_ai_summarization_errors_total', 'Summarization errors', aiState.summarizationErrors));
  lines.push(formatCounter('anno_ai_rag_queries_total', 'Total RAG queries', aiState.ragQueriesTotal));
  lines.push(formatCounter('anno_ai_rag_errors_total', 'RAG query errors', aiState.ragQueryErrors));
  lines.push(formatCounter('anno_ai_vector_searches_total', 'Total vector searches', aiState.vectorSearches));
  lines.push(formatCounter('anno_ai_memory_operations_total', 'Total memory operations', aiState.memoryOperations));

  // AI provider usage
  if (Object.keys(aiState.providerUsage).length > 0) {
    lines.push('# HELP anno_ai_provider_usage_total AI operations by provider');
    lines.push('# TYPE anno_ai_provider_usage_total counter');
    for (const [provider, count] of Object.entries(aiState.providerUsage)) {
      lines.push(`anno_ai_provider_usage_total{provider="${provider}"} ${count}`);
    }
  }

  // Security Metrics
  lines.push('');
  lines.push(formatCounter('anno_security_auth_failures_total', 'API authentication failures', securityState.authFailuresTotal));
  lines.push(formatCounter('anno_security_auth_success_total', 'API authentication successes', securityState.authSuccessTotal));
  lines.push(formatCounter('anno_security_rate_limit_exceeded_total', 'API rate limit exceeded', securityState.rateLimitExceededTotal));
  lines.push(formatCounter('anno_security_unsafe_queries_total', 'Queries flagged as unsafe', securityState.unsafeQueriesTotal));
  lines.push(formatCounter('anno_security_unsafe_content_total', 'Retrieved content flagged as unsafe', securityState.unsafeContentTotal));
  lines.push(formatCounter('anno_security_sanitizations_total', 'Content sanitizations performed', securityState.sanitizationsPerformed));

  // Prompt injection threats by type
  if (Object.keys(securityState.promptInjectionsDetected).length > 0) {
    lines.push('# HELP anno_security_prompt_injections_total Prompt injection attempts by threat type');
    lines.push('# TYPE anno_security_prompt_injections_total counter');
    for (const [threatType, count] of Object.entries(securityState.promptInjectionsDetected)) {
      lines.push(`anno_security_prompt_injections_total{threat_type="${threatType}"} ${count}`);
    }
  }

  return lines.join('\n') + '\n';
};

export const getLatencySummary = (): LatencySummary => {
  const snapshot = getMetricsSnapshot();

  const renderAverage =
    snapshot.fetch.renderDurationSecondsCount > 0
      ? snapshot.fetch.renderDurationSecondsSum / snapshot.fetch.renderDurationSecondsCount
      : null;
  const fallbackAverage =
    snapshot.fetch.renderFallbackSecondsCount > 0
      ? snapshot.fetch.renderFallbackSecondsSum / snapshot.fetch.renderFallbackSecondsCount
      : null;

  const renderP50 = estimatePercentile(
    snapshot.fetch.renderDurationSecondsBuckets,
    snapshot.fetch.renderDurationSecondsCount,
    0.5
  );
  const renderP95 = estimatePercentile(
    snapshot.fetch.renderDurationSecondsBuckets,
    snapshot.fetch.renderDurationSecondsCount,
    0.95
  );

  const fallbackP50 = estimatePercentile(
    snapshot.fetch.renderFallbackSecondsBuckets,
    snapshot.fetch.renderFallbackSecondsCount,
    0.5
  );
  const fallbackP95 = estimatePercentile(
    snapshot.fetch.renderFallbackSecondsBuckets,
    snapshot.fetch.renderFallbackSecondsCount,
    0.95
  );

  return {
    render: {
      averageSeconds: renderAverage,
      p50Seconds: renderP50,
      p95Seconds: renderP95
    },
    fallback: {
      averageSeconds: fallbackAverage,
      p50Seconds: fallbackP50,
      p95Seconds: fallbackP95
    }
  };
};

// Cache-specific metrics
export const recordCacheHit = (): void => {
  fetchState.cacheHits += 1;
};

export const recordCacheMiss = (): void => {
  fetchState.cacheMisses += 1;
};

export const recordCacheLookup = (durationMs: number): void => {
  fetchState.cacheLookupDurationMs.push(durationMs);
  // Keep only last 1000 lookups to avoid memory leak
  if (fetchState.cacheLookupDurationMs.length > 1000) {
    fetchState.cacheLookupDurationMs.shift();
  }
};

export const recordCacheValidation = (wasNotModified: boolean): void => {
  fetchState.cacheValidations += 1;
  if (wasNotModified) {
    fetchState.notModifiedResponses += 1;
  }
};

export const getCacheValidationStats = () => ({
  validations: fetchState.cacheValidations,
  notModified: fetchState.notModifiedResponses,
  validationHitRate:
    fetchState.cacheValidations > 0
      ? fetchState.notModifiedResponses / fetchState.cacheValidations
      : 0
});

export const getCacheStats = (): {
  hits: number;
  misses: number;
  hitRate: number;
  avgLookupMs: number;
} => {
  const total = fetchState.cacheHits + fetchState.cacheMisses;
  const hitRate = total > 0 ? fetchState.cacheHits / total : 0;
  const avgLookupMs =
    fetchState.cacheLookupDurationMs.length > 0
      ? fetchState.cacheLookupDurationMs.reduce((a, b) => a + b, 0) / fetchState.cacheLookupDurationMs.length
      : 0;

  return {
    hits: fetchState.cacheHits,
    misses: fetchState.cacheMisses,
    hitRate,
    avgLookupMs
  };
};

// Robots.txt metrics
export const recordRobotsBlocked = (): void => {
  fetchState.robotsBlockedRequests += 1;
};

export const getRobotsStats = (): { blockedRequests: number } => {
  return {
    blockedRequests: fetchState.robotsBlockedRequests
  };
};

// Rate limiting metrics
export const recordRateLimited = (waitMs: number): void => {
  if (waitMs > 0) {
    fetchState.rateLimitedRequests += 1;
    fetchState.rateLimitWaitMs.push(waitMs);
    // Keep only last 1000 to avoid memory leak
    if (fetchState.rateLimitWaitMs.length > 1000) {
      fetchState.rateLimitWaitMs.shift();
    }
  }
};

export const getRateLimitStats = (): {
  rateLimitedRequests: number;
  avgWaitMs: number;
  maxWaitMs: number;
} => {
  const avgWaitMs =
    fetchState.rateLimitWaitMs.length > 0
      ? fetchState.rateLimitWaitMs.reduce((a, b) => a + b, 0) / fetchState.rateLimitWaitMs.length
      : 0;
  const maxWaitMs = fetchState.rateLimitWaitMs.length > 0 ? Math.max(...fetchState.rateLimitWaitMs) : 0;

  return {
    rateLimitedRequests: fetchState.rateLimitedRequests,
    avgWaitMs,
    maxWaitMs
  };
};

// Protocol tracking
export const recordProtocolUsage = (protocol: string): void => {
  fetchState.protocolUsage[protocol] = (fetchState.protocolUsage[protocol] || 0) + 1;
};

export const getProtocolStats = (): Record<string, number> => {
  return { ...fetchState.protocolUsage };
};

// AI Metrics
export const recordEmbedding = (durationMs: number, provider: string, success: boolean = true): void => {
  aiState.embeddingsGenerated += 1;
  aiState.embeddingDurationMs.push(durationMs);
  aiState.providerUsage[provider] = (aiState.providerUsage[provider] || 0) + 1;

  if (!success) {
    aiState.embeddingErrors += 1;
  }

  // Keep only last 1000 measurements
  if (aiState.embeddingDurationMs.length > 1000) {
    aiState.embeddingDurationMs.shift();
  }
};

export const recordSummarization = (durationMs: number, provider: string, success: boolean = true): void => {
  aiState.summariesGenerated += 1;
  aiState.summarizationDurationMs.push(durationMs);
  aiState.providerUsage[provider] = (aiState.providerUsage[provider] || 0) + 1;

  if (!success) {
    aiState.summarizationErrors += 1;
  }

  // Keep only last 1000 measurements
  if (aiState.summarizationDurationMs.length > 1000) {
    aiState.summarizationDurationMs.shift();
  }
};

export const recordRAGQuery = (durationMs: number, success: boolean = true): void => {
  aiState.ragQueriesTotal += 1;
  aiState.ragQueryDurationMs.push(durationMs);

  if (!success) {
    aiState.ragQueryErrors += 1;
  }

  // Keep only last 1000 measurements
  if (aiState.ragQueryDurationMs.length > 1000) {
    aiState.ragQueryDurationMs.shift();
  }
};

export const recordVectorSearch = (durationMs: number): void => {
  aiState.vectorSearches += 1;
  aiState.vectorSearchDurationMs.push(durationMs);

  // Keep only last 1000 measurements
  if (aiState.vectorSearchDurationMs.length > 1000) {
    aiState.vectorSearchDurationMs.shift();
  }
};

export const recordMemoryOperation = (): void => {
  aiState.memoryOperations += 1;
};

// Security Metrics
export const recordAuthFailure = (): void => {
  securityState.authFailuresTotal += 1;
};

export const recordAuthSuccess = (): void => {
  securityState.authSuccessTotal += 1;
};

export const recordRateLimitExceeded = (): void => {
  securityState.rateLimitExceededTotal += 1;
};

export const recordPromptInjection = (threatType: string): void => {
  securityState.promptInjectionsDetected[threatType] =
    (securityState.promptInjectionsDetected[threatType] || 0) + 1;
};

export const recordUnsafeQuery = (): void => {
  securityState.unsafeQueriesTotal += 1;
};

export const recordUnsafeContent = (): void => {
  securityState.unsafeContentTotal += 1;
};

export const recordSanitization = (): void => {
  securityState.sanitizationsPerformed += 1;
};

export const getSecurityStats = () => securityState;

export const getAIStats = (): {
  embeddings: { total: number; errors: number; avgDurationMs: number };
  summaries: { total: number; errors: number; avgDurationMs: number };
  ragQueries: { total: number; errors: number; avgDurationMs: number };
  vectorSearches: { total: number; avgDurationMs: number };
  memoryOperations: number;
  providerUsage: Record<string, number>;
} => {
  const avgEmbeddingMs = aiState.embeddingDurationMs.length > 0
    ? aiState.embeddingDurationMs.reduce((a, b) => a + b, 0) / aiState.embeddingDurationMs.length
    : 0;

  const avgSummarizationMs = aiState.summarizationDurationMs.length > 0
    ? aiState.summarizationDurationMs.reduce((a, b) => a + b, 0) / aiState.summarizationDurationMs.length
    : 0;

  const avgRAGMs = aiState.ragQueryDurationMs.length > 0
    ? aiState.ragQueryDurationMs.reduce((a, b) => a + b, 0) / aiState.ragQueryDurationMs.length
    : 0;

  const avgVectorSearchMs = aiState.vectorSearchDurationMs.length > 0
    ? aiState.vectorSearchDurationMs.reduce((a, b) => a + b, 0) / aiState.vectorSearchDurationMs.length
    : 0;

  return {
    embeddings: {
      total: aiState.embeddingsGenerated,
      errors: aiState.embeddingErrors,
      avgDurationMs: avgEmbeddingMs
    },
    summaries: {
      total: aiState.summariesGenerated,
      errors: aiState.summarizationErrors,
      avgDurationMs: avgSummarizationMs
    },
    ragQueries: {
      total: aiState.ragQueriesTotal,
      errors: aiState.ragQueryErrors,
      avgDurationMs: avgRAGMs
    },
    vectorSearches: {
      total: aiState.vectorSearches,
      avgDurationMs: avgVectorSearchMs
    },
    memoryOperations: aiState.memoryOperations,
    providerUsage: { ...aiState.providerUsage }
  };
};

export const metrics = {
  recordCacheHit,
  recordCacheMiss,
  recordCacheLookup,
  recordCacheValidation,
  getCacheValidationStats,
  getCacheStats,
  recordRobotsBlocked,
  getRobotsStats,
  recordRateLimited,
  getRateLimitStats,
  recordProtocolUsage,
  getProtocolStats,
  recordEmbedding,
  recordSummarization,
  recordRAGQuery,
  recordVectorSearch,
  recordMemoryOperation,
  getAIStats
};
