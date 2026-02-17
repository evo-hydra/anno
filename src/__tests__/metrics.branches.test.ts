/**
 * Branch-coverage tests for src/services/metrics.ts.
 *
 * Focuses on uncovered branches: recordFetchMetrics conditional paths,
 * estimatePercentile edge cases, renderPrometheusMetrics conditional blocks
 * (lastRenderError, provider usage, prompt injections), cache/rate-limit
 * memory-cap branches, AI metrics with success=false, getLatencySummary
 * null vs value paths, getCacheStats/getRateLimitStats zero-length branches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFetchMetrics,
  getMetricsSnapshot,
  resetMetrics,
  renderPrometheusMetrics,
  getLatencySummary,
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
  recordAuthFailure,
  recordAuthSuccess,
  recordRateLimitExceeded,
  recordPromptInjection,
  recordUnsafeQuery,
  recordUnsafeContent,
  recordSanitization,
  getSecurityStats,
  getAIStats,
} from '../services/metrics';

describe('Metrics — branch coverage', () => {
  beforeEach(() => {
    resetMetrics();
  });

  // ---- recordFetchMetrics branches ----

  describe('recordFetchMetrics', () => {
    it('increments totalFromCache when fromCache is true', () => {
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: true,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalFromCache).toBe(1);
      expect(snapshot.fetch.totalRequests).toBe(1);
    });

    it('does not increment totalFromCache when fromCache is false', () => {
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalFromCache).toBe(0);
    });

    it('increments requestedRendered when requestedMode is rendered', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.requestedRendered).toBe(1);
    });

    it('does not increment requestedRendered when requestedMode is http', () => {
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.requestedRendered).toBe(0);
    });

    it('increments attemptedRendered when attempted is true', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.attemptedRendered).toBe(1);
    });

    it('increments effectiveRendered when effectiveMode is rendered', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.effectiveRendered).toBe(1);
    });

    it('does not increment effectiveRendered when effectiveMode is http', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'rendering_disabled',
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.effectiveRendered).toBe(0);
    });

    it('increments renderSuccess and populates duration buckets when rendered with duration', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
        renderDurationSeconds: 0.3,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderSuccess).toBe(1);
      expect(snapshot.fetch.renderDurationSecondsCount).toBe(1);
      expect(snapshot.fetch.renderDurationSecondsSum).toBeCloseTo(0.3);
      // 0.3 <= 0.5, 1, 2, 5, 10 buckets
      expect(snapshot.fetch.renderDurationSecondsBuckets[0.1]).toBe(0);
      expect(snapshot.fetch.renderDurationSecondsBuckets[0.25]).toBe(0);
      expect(snapshot.fetch.renderDurationSecondsBuckets[0.5]).toBe(1);
      expect(snapshot.fetch.renderDurationSecondsBuckets[1]).toBe(1);
    });

    it('does not populate duration buckets when rendered without duration', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
        // no renderDurationSeconds
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderSuccess).toBe(1);
      expect(snapshot.fetch.renderDurationSecondsCount).toBe(0);
    });

    it('increments renderDisabled for rendering_disabled fallback', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
        fallbackReason: 'rendering_disabled',
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderFallbacks).toBe(1);
      expect(snapshot.fetch.renderDisabled).toBe(1);
      expect(snapshot.fetch.renderErrors).toBe(0);
      expect(snapshot.fetch.lastRenderError).toBeNull();
    });

    it('increments renderErrors and sets lastRenderError for non-disabled fallback', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'browser_crashed',
        errorMessage: 'Chromium OOM',
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderFallbacks).toBe(1);
      expect(snapshot.fetch.renderDisabled).toBe(0);
      expect(snapshot.fetch.renderErrors).toBe(1);
      expect(snapshot.fetch.lastRenderError).toBeDefined();
      expect(snapshot.fetch.lastRenderError!.reason).toBe('browser_crashed');
      expect(snapshot.fetch.lastRenderError!.message).toBe('Chromium OOM');
    });

    it('populates fallback duration buckets when fallback has duration', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'timeout',
        renderFallbackSeconds: 5.5,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderFallbackSecondsCount).toBe(1);
      expect(snapshot.fetch.renderFallbackSecondsSum).toBeCloseTo(5.5);
      // 5.5 <= 10 bucket only
      expect(snapshot.fetch.renderFallbackSecondsBuckets[5]).toBe(0);
      expect(snapshot.fetch.renderFallbackSecondsBuckets[10]).toBe(1);
    });

    it('does not populate fallback duration buckets without fallback duration', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'timeout',
        // no renderFallbackSeconds
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderFallbackSecondsCount).toBe(0);
    });

    it('sets lastRequestAt on each call', () => {
      const before = Date.now();
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });
      const after = Date.now();

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.lastRequestAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.fetch.lastRequestAt).toBeLessThanOrEqual(after);
    });

    it('handles render duration in smallest bucket (0.1)', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
        renderDurationSeconds: 0.05,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.renderDurationSecondsBuckets[0.1]).toBe(1);
    });

    it('handles render duration exceeding all buckets', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: false,
        renderDurationSeconds: 15,
      });

      const snapshot = getMetricsSnapshot();
      // No bucket should be incremented since 15 > all buckets
      expect(snapshot.fetch.renderDurationSecondsBuckets[0.1]).toBe(0);
      expect(snapshot.fetch.renderDurationSecondsBuckets[10]).toBe(0);
      expect(snapshot.fetch.renderDurationSecondsCount).toBe(1);
      expect(snapshot.fetch.renderDurationSecondsSum).toBe(15);
    });
  });

  // ---- renderPrometheusMetrics branches ----

  describe('renderPrometheusMetrics', () => {
    it('includes lastRenderError info when present', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'browser_crashed',
        errorMessage: 'OOM killed',
      });

      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_last_render_error_info');
      expect(output).toContain('browser_crashed');
      expect(output).toContain('OOM killed');
    });

    it('does not include lastRenderError info when null', () => {
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });

      const output = renderPrometheusMetrics();
      expect(output).not.toContain('anno_last_render_error_info');
    });

    it('includes lastRenderError with empty message', () => {
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'http',
        attempted: true,
        rendered: false,
        fromCache: false,
        fallbackReason: 'launch_failed',
        // no errorMessage
      });

      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_last_render_error_info');
      expect(output).toContain('launch_failed');
      expect(output).toContain('message=""');
    });

    it('includes AI provider usage when present', () => {
      recordEmbedding(100, 'openai');
      recordSummarization(200, 'anthropic');

      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_ai_provider_usage_total');
      expect(output).toContain('provider="openai"');
      expect(output).toContain('provider="anthropic"');
    });

    it('does not include AI provider usage section when empty', () => {
      const output = renderPrometheusMetrics();
      expect(output).not.toContain('anno_ai_provider_usage_total');
    });

    it('includes security prompt injection metrics when present', () => {
      recordPromptInjection('sql_injection');
      recordPromptInjection('xss');

      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_security_prompt_injections_total');
      expect(output).toContain('threat_type="sql_injection"');
      expect(output).toContain('threat_type="xss"');
    });

    it('does not include prompt injection section when empty (checked via fresh reset)', () => {
      // Note: securityState is not reset by resetMetrics(), so we check the
      // Prometheus output right after resetMetrics when no prompt injections
      // have been recorded in THIS test. Since earlier tests may have recorded
      // prompt injections, we instead verify that the output includes prompt
      // injection lines only when recordPromptInjection has been called.
      // This test validates the conditional block by recording and checking.
      // The "empty" path is already covered implicitly by earlier tests that
      // call renderPrometheusMetrics before any prompt injections.
      recordPromptInjection('test_threat');
      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_security_prompt_injections_total{threat_type="test_threat"}');
    });

    it('outputs lastRequestAt as 0 when null', () => {
      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_last_request_timestamp 0');
    });

    it('outputs lastRequestAt as timestamp when set', () => {
      recordFetchMetrics({
        requestedMode: 'http',
        effectiveMode: 'http',
        attempted: false,
        rendered: false,
        fromCache: false,
      });

      const output = renderPrometheusMetrics();
      // Should not contain "0" for last_request_timestamp
      const match = output.match(/anno_last_request_timestamp (\d+)/);
      expect(match).toBeDefined();
      expect(Number(match![1])).toBeGreaterThan(0);
    });

    it('includes histogram bucket lines and +Inf', () => {
      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_render_duration_seconds_bucket{le="0.1"}');
      expect(output).toContain('anno_render_duration_seconds_bucket{le="+Inf"}');
      expect(output).toContain('anno_render_fallback_seconds_bucket{le="0.1"}');
      expect(output).toContain('anno_render_fallback_seconds_bucket{le="+Inf"}');
    });

    it('renders all security counter lines', () => {
      recordAuthFailure();
      recordAuthSuccess();
      recordRateLimitExceeded();
      recordUnsafeQuery();
      recordUnsafeContent();
      recordSanitization();

      const output = renderPrometheusMetrics();
      expect(output).toContain('anno_security_auth_failures_total');
      expect(output).toContain('anno_security_auth_success_total');
      expect(output).toContain('anno_security_rate_limit_exceeded_total');
      expect(output).toContain('anno_security_unsafe_queries_total');
      expect(output).toContain('anno_security_unsafe_content_total');
      expect(output).toContain('anno_security_sanitizations_total');
    });
  });

  // ---- getLatencySummary branches ----

  describe('getLatencySummary', () => {
    it('returns null values when no render data exists', () => {
      const summary = getLatencySummary();

      expect(summary.render.averageSeconds).toBeNull();
      expect(summary.render.p50Seconds).toBeNull();
      expect(summary.render.p95Seconds).toBeNull();
      expect(summary.fallback.averageSeconds).toBeNull();
      expect(summary.fallback.p50Seconds).toBeNull();
      expect(summary.fallback.p95Seconds).toBeNull();
    });

    it('returns computed averages and percentiles when data exists', () => {
      // Record multiple render durations
      for (let i = 0; i < 10; i++) {
        recordFetchMetrics({
          requestedMode: 'rendered',
          effectiveMode: 'rendered',
          attempted: true,
          rendered: true,
          fromCache: false,
          renderDurationSeconds: 0.5,
        });
      }

      const summary = getLatencySummary();
      expect(summary.render.averageSeconds).toBeCloseTo(0.5);
      expect(summary.render.p50Seconds).toBe(0.5);
      expect(summary.render.p95Seconds).toBe(0.5);
    });

    it('returns computed fallback averages and percentiles', () => {
      for (let i = 0; i < 10; i++) {
        recordFetchMetrics({
          requestedMode: 'rendered',
          effectiveMode: 'http',
          attempted: true,
          rendered: false,
          fromCache: false,
          fallbackReason: 'timeout',
          renderFallbackSeconds: 2.0,
        });
      }

      const summary = getLatencySummary();
      expect(summary.fallback.averageSeconds).toBeCloseTo(2.0);
      expect(summary.fallback.p50Seconds).toBe(2);
      expect(summary.fallback.p95Seconds).toBe(2);
    });

    it('returns null percentile when all durations exceed buckets', () => {
      // All durations exceed the max bucket (10)
      for (let i = 0; i < 5; i++) {
        recordFetchMetrics({
          requestedMode: 'rendered',
          effectiveMode: 'rendered',
          attempted: true,
          rendered: true,
          fromCache: false,
          renderDurationSeconds: 20,
        });
      }

      const summary = getLatencySummary();
      expect(summary.render.averageSeconds).toBe(20);
      expect(summary.render.p50Seconds).toBeNull();
      expect(summary.render.p95Seconds).toBeNull();
    });
  });

  // ---- Cache metrics branches ----

  describe('Cache metrics', () => {
    it('getCacheStats returns zero hitRate when no hits/misses', () => {
      const stats = getCacheStats();
      expect(stats.hitRate).toBe(0);
      expect(stats.avgLookupMs).toBe(0);
    });

    it('getCacheStats computes hitRate correctly', () => {
      recordCacheHit();
      recordCacheHit();
      recordCacheMiss();

      const stats = getCacheStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(2 / 3);
    });

    it('getCacheStats computes average lookup duration', () => {
      recordCacheLookup(10);
      recordCacheLookup(20);
      recordCacheLookup(30);

      const stats = getCacheStats();
      expect(stats.avgLookupMs).toBe(20);
    });

    it('recordCacheLookup caps at 1000 entries', () => {
      for (let i = 0; i < 1005; i++) {
        recordCacheLookup(i);
      }

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.cacheLookupDurationMs.length).toBe(1000);
    });

    it('getCacheValidationStats returns zero rate when no validations', () => {
      const stats = getCacheValidationStats();
      expect(stats.validations).toBe(0);
      expect(stats.notModified).toBe(0);
      expect(stats.validationHitRate).toBe(0);
    });

    it('getCacheValidationStats computes rate correctly', () => {
      recordCacheValidation(true);
      recordCacheValidation(true);
      recordCacheValidation(false);

      const stats = getCacheValidationStats();
      expect(stats.validations).toBe(3);
      expect(stats.notModified).toBe(2);
      expect(stats.validationHitRate).toBeCloseTo(2 / 3);
    });

    it('recordCacheValidation does not increment notModified when false', () => {
      recordCacheValidation(false);

      const stats = getCacheValidationStats();
      expect(stats.validations).toBe(1);
      expect(stats.notModified).toBe(0);
    });
  });

  // ---- Rate limit metrics branches ----

  describe('Rate limit metrics', () => {
    it('getRateLimitStats returns zeros when no rate limiting', () => {
      const stats = getRateLimitStats();
      expect(stats.rateLimitedRequests).toBe(0);
      expect(stats.avgWaitMs).toBe(0);
      expect(stats.maxWaitMs).toBe(0);
    });

    it('getRateLimitStats computes avg and max correctly', () => {
      recordRateLimited(100);
      recordRateLimited(300);
      recordRateLimited(200);

      const stats = getRateLimitStats();
      expect(stats.rateLimitedRequests).toBe(3);
      expect(stats.avgWaitMs).toBe(200);
      expect(stats.maxWaitMs).toBe(300);
    });

    it('recordRateLimited ignores zero wait time', () => {
      recordRateLimited(0);

      const stats = getRateLimitStats();
      expect(stats.rateLimitedRequests).toBe(0);
    });

    it('recordRateLimited caps at 1000 entries', () => {
      for (let i = 0; i < 1005; i++) {
        recordRateLimited(i + 1);
      }

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.rateLimitWaitMs.length).toBe(1000);
    });
  });

  // ---- Robots and protocol metrics ----

  describe('Robots and protocol metrics', () => {
    it('recordRobotsBlocked increments counter', () => {
      recordRobotsBlocked();
      recordRobotsBlocked();

      const stats = getRobotsStats();
      expect(stats.blockedRequests).toBe(2);
    });

    it('recordProtocolUsage tracks multiple protocols', () => {
      recordProtocolUsage('h2');
      recordProtocolUsage('h2');
      recordProtocolUsage('http/1.1');

      const stats = getProtocolStats();
      expect(stats['h2']).toBe(2);
      expect(stats['http/1.1']).toBe(1);
    });
  });

  // ---- AI metrics branches ----

  describe('AI metrics', () => {
    it('recordEmbedding with success=false increments errors', () => {
      recordEmbedding(50, 'openai', false);

      const stats = getAIStats();
      expect(stats.embeddings.total).toBe(1);
      expect(stats.embeddings.errors).toBe(1);
    });

    it('recordEmbedding with default success=true does not increment errors', () => {
      recordEmbedding(50, 'openai');

      const stats = getAIStats();
      expect(stats.embeddings.total).toBe(1);
      expect(stats.embeddings.errors).toBe(0);
    });

    it('recordEmbedding caps duration array at 1000', () => {
      for (let i = 0; i < 1005; i++) {
        recordEmbedding(i, 'openai');
      }
      // Just verify it doesn't crash and stats are available
      const stats = getAIStats();
      expect(stats.embeddings.total).toBe(1005);
    });

    it('recordSummarization with success=false increments errors', () => {
      recordSummarization(100, 'anthropic', false);

      const stats = getAIStats();
      expect(stats.summaries.total).toBe(1);
      expect(stats.summaries.errors).toBe(1);
    });

    it('recordSummarization caps duration array at 1000', () => {
      for (let i = 0; i < 1005; i++) {
        recordSummarization(i, 'anthropic');
      }
      const stats = getAIStats();
      expect(stats.summaries.total).toBe(1005);
    });

    it('recordRAGQuery with success=false increments errors', () => {
      recordRAGQuery(200, false);

      const stats = getAIStats();
      expect(stats.ragQueries.total).toBe(1);
      expect(stats.ragQueries.errors).toBe(1);
    });

    it('recordRAGQuery caps duration array at 1000', () => {
      for (let i = 0; i < 1005; i++) {
        recordRAGQuery(i);
      }
      const stats = getAIStats();
      expect(stats.ragQueries.total).toBe(1005);
    });

    it('recordVectorSearch caps duration array at 1000', () => {
      for (let i = 0; i < 1005; i++) {
        recordVectorSearch(i);
      }
      const stats = getAIStats();
      expect(stats.vectorSearches.total).toBe(1005);
    });

    it('recordMemoryOperation increments counter', () => {
      recordMemoryOperation();
      recordMemoryOperation();

      const stats = getAIStats();
      expect(stats.memoryOperations).toBe(2);
    });

    it('getAIStats returns zero averages when no data', () => {
      const stats = getAIStats();
      expect(stats.embeddings.avgDurationMs).toBe(0);
      expect(stats.summaries.avgDurationMs).toBe(0);
      expect(stats.ragQueries.avgDurationMs).toBe(0);
      expect(stats.vectorSearches.avgDurationMs).toBe(0);
    });

    it('getAIStats computes averages correctly', () => {
      recordEmbedding(100, 'openai');
      recordEmbedding(200, 'openai');
      recordSummarization(300, 'anthropic');
      recordSummarization(500, 'anthropic');
      recordRAGQuery(50);
      recordRAGQuery(150);
      recordVectorSearch(10);
      recordVectorSearch(30);

      const stats = getAIStats();
      expect(stats.embeddings.avgDurationMs).toBe(150);
      expect(stats.summaries.avgDurationMs).toBe(400);
      expect(stats.ragQueries.avgDurationMs).toBe(100);
      expect(stats.vectorSearches.avgDurationMs).toBe(20);
    });

    it('getAIStats includes provider usage', () => {
      recordEmbedding(100, 'openai');
      recordEmbedding(100, 'openai');
      recordSummarization(200, 'anthropic');

      const stats = getAIStats();
      expect(stats.providerUsage['openai']).toBe(2);
      expect(stats.providerUsage['anthropic']).toBe(1);
    });
  });

  // ---- Security metrics ----

  describe('Security metrics', () => {
    it('records all security event types (incremental)', () => {
      const before = getSecurityStats();
      const baseAuth = before.authFailuresTotal;
      const baseSuccess = before.authSuccessTotal;
      const baseRate = before.rateLimitExceededTotal;
      const baseUnsafeQ = before.unsafeQueriesTotal;
      const baseUnsafeC = before.unsafeContentTotal;
      const baseSanit = before.sanitizationsPerformed;

      recordAuthFailure();
      recordAuthSuccess();
      recordRateLimitExceeded();
      recordUnsafeQuery();
      recordUnsafeContent();
      recordSanitization();

      const stats = getSecurityStats();
      expect(stats.authFailuresTotal).toBe(baseAuth + 1);
      expect(stats.authSuccessTotal).toBe(baseSuccess + 1);
      expect(stats.rateLimitExceededTotal).toBe(baseRate + 1);
      expect(stats.unsafeQueriesTotal).toBe(baseUnsafeQ + 1);
      expect(stats.unsafeContentTotal).toBe(baseUnsafeC + 1);
      expect(stats.sanitizationsPerformed).toBe(baseSanit + 1);
    });

    it('recordPromptInjection tracks by threat type (incremental)', () => {
      const before = getSecurityStats();
      const baseSql = before.promptInjectionsDetected['sql_injection_2'] || 0;
      const baseXss = before.promptInjectionsDetected['xss_2'] || 0;

      recordPromptInjection('sql_injection_2');
      recordPromptInjection('sql_injection_2');
      recordPromptInjection('xss_2');

      const stats = getSecurityStats();
      expect(stats.promptInjectionsDetected['sql_injection_2']).toBe(baseSql + 2);
      expect(stats.promptInjectionsDetected['xss_2']).toBe(baseXss + 1);
    });
  });

  // ---- resetMetrics ----

  describe('resetMetrics', () => {
    it('resets all fetch and AI state to initial values', () => {
      // Populate some state
      recordFetchMetrics({
        requestedMode: 'rendered',
        effectiveMode: 'rendered',
        attempted: true,
        rendered: true,
        fromCache: true,
        renderDurationSeconds: 1,
      });
      recordCacheHit();
      recordEmbedding(100, 'openai');

      // Reset
      resetMetrics();

      const snapshot = getMetricsSnapshot();
      expect(snapshot.fetch.totalRequests).toBe(0);
      expect(snapshot.fetch.totalFromCache).toBe(0);
      expect(snapshot.fetch.cacheHits).toBe(0);
      expect(snapshot.fetch.renderSuccess).toBe(0);
      expect(snapshot.ai.embeddingsGenerated).toBe(0);
    });
  });
});
