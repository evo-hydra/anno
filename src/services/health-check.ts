/**
 * Enhanced Health Check Service
 *
 * Performs deep health checks on all system dependencies
 *
 * @module services/health-check
 */

import { cache } from './cache';
import { ollamaExtractor } from './ollama-extractor';
import { getRendererStatus } from './renderer';
import { policyEngine } from './policy-engine';
import { logger } from '../utils/logger';

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  checks: {
    cache: ComponentHealth;
    ollama: ComponentHealth;
    renderer: ComponentHealth;
    policies: ComponentHealth;
  };
  overall: {
    healthy: number;
    degraded: number;
    unhealthy: number;
  };
}

export interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

/**
 * Check Redis cache health
 */
async function checkCacheHealth(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    const strategy = cache.getStrategy();
    const redisStatus = cache.getRedisStatus();
    const latencyMs = Date.now() - start;

    if (redisStatus && redisStatus.connected) {
      return {
        status: 'healthy',
        message: 'Redis connected and operational',
        latencyMs,
        details: {
          strategy,
          connected: redisStatus.connected,
          reconnectAttempts: redisStatus.reconnectAttempts
        }
      };
    } else if (strategy === 'lru') {
      return {
        status: 'degraded',
        message: 'Using in-memory cache (Redis unavailable)',
        latencyMs,
        details: {
          strategy
        }
      };
    } else {
      return {
        status: 'unhealthy',
        message: 'Cache unavailable',
        latencyMs,
        details: redisStatus ? {
          connected: redisStatus.connected,
          reconnectAttempts: redisStatus.reconnectAttempts
        } : {}
      };
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      message: `Cache check failed: ${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Check Ollama LLM health
 */
async function checkOllamaHealth(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    const available = await ollamaExtractor.checkAvailability();
    const latencyMs = Date.now() - start;

    if (available) {
      return {
        status: 'healthy',
        message: 'Ollama LLM available',
        latencyMs,
        details: { available: true }
      };
    } else {
      return {
        status: 'degraded',
        message: 'Ollama LLM unavailable (using fallback methods)',
        latencyMs,
        details: { available: false }
      };
    }
  } catch (error) {
    return {
      status: 'degraded',
      message: `Ollama check failed (using fallback): ${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Check Playwright renderer health
 */
async function checkRendererHealth(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    const status = getRendererStatus();
    const latencyMs = Date.now() - start;

    if (status.enabled && status.initialized) {
      return {
        status: 'healthy',
        message: 'Renderer initialized and ready',
        latencyMs,
        details: {
          enabled: status.enabled,
          initialized: status.initialized,
          concurrency: status.concurrency
        }
      };
    } else if (status.enabled && !status.initialized) {
      return {
        status: 'degraded',
        message: 'Renderer enabled but not initialized',
        latencyMs,
        details: {
          enabled: status.enabled,
          initialized: status.initialized
        }
      };
    } else {
      return {
        status: 'degraded',
        message: 'Renderer disabled (using HTTP fallback)',
        latencyMs,
        details: {
          enabled: status.enabled
        }
      };
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      message: `Renderer check failed: ${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - start
    };
  }
}

async function checkPolicyHealth(): Promise<ComponentHealth> {
  const start = Date.now();

  try {
    await policyEngine.init();
    const policies = policyEngine.getPolicies();
    const fingerprint = policyEngine.getFingerprint();
    const latencyMs = Date.now() - start;

    if (policies.length > 0) {
      return {
        status: 'healthy',
        message: 'Policy engine loaded',
        latencyMs,
        details: {
          count: policies.length,
          fingerprint,
          names: policies.map((policy) => policy.name)
        }
      };
    }

    return {
      status: 'degraded',
      message: 'No policies loaded',
      latencyMs,
      details: {
        count: 0,
        fingerprint: fingerprint ?? undefined,
        names: []
      }
    };
  } catch (error) {
    return {
      status: 'degraded',
      message: `Policy check failed: ${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Perform comprehensive health check
 */
export async function performHealthCheck(): Promise<HealthStatus> {
  const startTime = Date.now();

  try {
    // Run all checks in parallel
    const [cacheHealth, ollamaHealth, rendererHealth, policyHealth] = await Promise.all([
      checkCacheHealth(),
      checkOllamaHealth(),
      checkRendererHealth(),
      checkPolicyHealth()
    ]);

    const checks = {
      cache: cacheHealth,
      ollama: ollamaHealth,
      renderer: rendererHealth,
      policies: policyHealth
    };

    // Calculate overall health
    const statuses = Object.values(checks).map(c => c.status);
    const overall = {
      healthy: statuses.filter(s => s === 'healthy').length,
      degraded: statuses.filter(s => s === 'degraded').length,
      unhealthy: statuses.filter(s => s === 'unhealthy').length
    };

    // Determine overall status
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (overall.unhealthy > 0) {
      overallStatus = 'unhealthy';
    } else if (overall.degraded > 0) {
      overallStatus = 'degraded';
    } else {
      overallStatus = 'healthy';
    }

    const result: HealthStatus = {
      status: overallStatus,
      timestamp: Date.now(),
      checks,
      overall
    };

    const duration = Date.now() - startTime;
    logger.debug('Health check completed', { duration, status: overallStatus });

    return result;
  } catch (error) {
    logger.error('Health check failed', { error });
    return {
      status: 'unhealthy',
      timestamp: Date.now(),
      checks: {
        cache: { status: 'unhealthy', message: 'Health check error' },
        ollama: { status: 'unhealthy', message: 'Health check error' },
        renderer: { status: 'unhealthy', message: 'Health check error' },
        policies: { status: 'unhealthy', message: 'Health check error' }
      },
      overall: {
        healthy: 0,
        degraded: 0,
        unhealthy: 3
      }
    };
  }
}
