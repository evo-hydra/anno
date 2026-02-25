/**
 * Anno - AI-Native Web Browser
 * Copyright (c) 2025 Evolving Intelligence AI. All rights reserved.
 *
 * PROPRIETARY AND CONFIDENTIAL
 * This code is proprietary to Evolving Intelligence AI and may not be copied, modified,
 * or distributed without explicit written permission.
 */

import crypto from 'crypto';
import { config } from '../config/env';
import { distillContent } from '../services/distiller';
import { fetchPage, type FetchMode } from '../services/fetcher';
import { logger } from '../utils/logger';
import { detectChallengePage, detectAuthWall, isGatedPage } from './wall-detector';

export interface PipelineOptions {
  url: string;
  useCache: boolean;
  maxNodes: number;
  mode: FetchMode;
}

export type StreamEvent =
  | { type: 'metadata'; payload: Record<string, unknown> }
  | { type: 'node'; payload: Record<string, unknown> }
  | { type: 'provenance'; payload: Record<string, unknown> }
  | { type: 'confidence'; payload: Record<string, unknown> }
  | { type: 'extraction'; payload: Record<string, unknown> }
  | { type: 'alert'; payload: Record<string, unknown> }
  | { type: 'done'; payload: Record<string, unknown> };

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const computeConfidence = (contentLength: number, byline: string | null, nodes: number, fallbackUsed: boolean): number => {
  let score = fallbackUsed ? 0.45 : 0.62;

  if (contentLength > 1200) {
    score += 0.1;
  } else if (contentLength < 400) {
    score -= 0.08;
  }

  if (byline) {
    score += 0.05;
  }

  if (nodes > 5) {
    score += 0.05;
  }

  return clamp(score, 0.2, 0.95);
};

const computeNodeConfidence = (overall: number, textLength: number, isHeading: boolean): number => {
  const modifier = isHeading ? 0.02 : textLength > 200 ? 0.04 : textLength < 40 ? -0.08 : 0;
  return clamp(overall + modifier, 0.1, 0.98);
};

const sha256 = (input: string): string => crypto.createHash('sha256').update(input).digest('hex');

const buildMetadataPayload = (fetchResult: Awaited<ReturnType<typeof fetchPage>>): Record<string, unknown> => ({
  url: fetchResult.url,
  finalUrl: fetchResult.finalUrl,
  status: fetchResult.status,
  contentType: fetchResult.headers['content-type'] ?? null,
  fetchTimestamp: fetchResult.fetchTimestamp,
  durationMs: fetchResult.durationMs,
  fromCache: fetchResult.fromCache,
  rendered: fetchResult.rendered,
  renderDiagnostics: fetchResult.renderDiagnostics,
});

export async function* runPipeline(options: PipelineOptions): AsyncGenerator<StreamEvent> {
  let fetchResult = await fetchPage({ url: options.url, useCache: options.useCache, mode: options.mode });

  yield { type: 'metadata', payload: buildMetadataPayload(fetchResult) } satisfies StreamEvent;

  if (!fetchResult.body) {
    logger.warn('empty body from fetch', { url: options.url });
    yield {
      type: 'alert',
      payload: { kind: 'empty_body', url: options.url, timestamp: Date.now() }
    } satisfies StreamEvent;
    yield {
      type: 'done',
      payload: { reason: 'empty_body', nodes: 0 }
    } satisfies StreamEvent;
    return;
  }

  // --- Gate detection (challenges + auth walls) ---
  const challenge = detectChallengePage(fetchResult.body);
  if (challenge) {
    logger.warn('potential challenge page detected', { url: options.url, reason: challenge.reason });
    yield {
      type: 'alert',
      payload: {
        kind: 'challenge_detected',
        reason: challenge.reason,
        pattern: challenge.pattern,
        url: options.url,
        timestamp: Date.now()
      }
    } satisfies StreamEvent;
  }

  let authWallDetected = false;
  const authWall = detectAuthWall(fetchResult.body);
  if (authWall) {
    authWallDetected = true;
    logger.warn('auth wall detected', { url: options.url, reason: authWall.reason });
    yield {
      type: 'alert',
      payload: {
        kind: 'auth_wall_detected',
        reason: authWall.reason,
        pattern: authWall.pattern,
        url: options.url,
        timestamp: Date.now()
      }
    } satisfies StreamEvent;
  }

  // --- Auto-retry with rendering when gated (challenge OR auth wall) ---
  const gated = challenge !== null || authWallDetected;
  if (gated && options.mode === 'http' && config.rendering.enabled) {
    logger.info('auto-retrying with rendered mode after gate detection', {
      url: options.url,
      trigger: authWall?.reason ?? challenge?.reason,
    });
    try {
      const renderedResult = await fetchPage({ url: options.url, useCache: options.useCache, mode: 'rendered' });
      if (renderedResult.body && !isGatedPage(renderedResult.body)) {
        fetchResult = renderedResult;
        authWallDetected = false;
        // Emit corrected metadata so consumers see the actual fetch details
        yield { type: 'metadata', payload: buildMetadataPayload(fetchResult) } satisfies StreamEvent;
        yield {
          type: 'alert',
          payload: {
            kind: 'gate_bypassed',
            method: 'rendered_retry',
            trigger: authWall?.reason ?? challenge?.reason,
            url: options.url,
            timestamp: Date.now()
          }
        } satisfies StreamEvent;
      }
    } catch (err) {
      logger.warn('rendered retry after gate detection failed', { url: options.url, error: String(err) });
    }
  }

  const distillation = await distillContent(fetchResult.body, fetchResult.finalUrl);
  let overallConfidence = computeConfidence(
    distillation.contentLength,
    distillation.byline,
    distillation.nodes.length,
    distillation.fallbackUsed
  );
  // If auth wall is still detected after potential retry, cap confidence
  if (authWallDetected) {
    overallConfidence = Math.min(overallConfidence, 0.15);
  }

  const extractionMethod =
    distillation.extractionMethod ??
    (distillation.fallbackUsed ? 'fallback-dom' : 'readability');
  const extractionConfidence = distillation.extractionConfidence ?? overallConfidence;

  yield {
    type: 'confidence',
    payload: {
      overallConfidence,
      authWall: authWallDetected,
      heuristics: {
        fallbackUsed: distillation.fallbackUsed,
        nodeCount: distillation.nodes.length,
        contentLength: distillation.contentLength,
        hasByline: Boolean(distillation.byline)
      }
    }
  } satisfies StreamEvent;

  yield {
    type: 'extraction',
    payload: {
      method: extractionMethod,
      confidence: extractionConfidence,
      fallbackUsed: distillation.fallbackUsed,
      byline: distillation.byline,
      siteName: distillation.siteName,
      ebayListing: distillation.ebayData ?? undefined,
      ebaySearch: distillation.ebaySearchData ?? undefined
    }
  } satisfies StreamEvent;

  const limitedNodes = distillation.nodes.slice(0, options.maxNodes);

  for (const node of limitedNodes) {
    const nodeHash = sha256(`${fetchResult.finalUrl}:${node.order}:${node.text.slice(0, 64)}`);
    yield {
      type: 'node',
      payload: {
        id: node.id,
        hash: nodeHash,
        order: node.order,
        kind: node.type,
        text: node.text,
        confidence: computeNodeConfidence(overallConfidence, node.text.length, node.type === 'heading')
      }
    } satisfies StreamEvent;
  }

  yield {
    type: 'provenance',
    payload: {
      extractor: extractionMethod,
      checksum: sha256(fetchResult.body),
      nodeCount: limitedNodes.length
    }
  } satisfies StreamEvent;

  yield {
    type: 'done',
    payload: {
      nodes: limitedNodes.length,
      truncated: distillation.nodes.length > limitedNodes.length,
      excerpt: distillation.excerpt,
      title: distillation.title,
      byline: distillation.byline,
      siteName: distillation.siteName
    }
  } satisfies StreamEvent;
}
