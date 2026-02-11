/**
 * Circuit Breaker implementation for protecting against cascading failures.
 *
 * States:
 * - CLOSED: Normal operation, requests flow through.
 * - OPEN: Failing fast, requests are rejected immediately.
 * - HALF_OPEN: Testing recovery, limited requests are allowed through.
 *
 * @module utils/circuit-breaker
 */

import { logger } from './logger';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  /** Identifying name for this circuit breaker (used in logs) */
  name: string;
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN (default: 30000) */
  resetTimeoutMs?: number;
  /** Number of test calls allowed in HALF_OPEN state (default: 1) */
  halfOpenMaxAttempts?: number;
}

/**
 * Error thrown when the circuit breaker is in OPEN state and rejects a call.
 */
export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is OPEN — requests are being rejected`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxAttempts: number;

  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * - CLOSED: Execute normally, track failures.
   * - OPEN: Reject immediately. Transition to HALF_OPEN after resetTimeoutMs.
   * - HALF_OPEN: Allow limited attempts. Success → CLOSED, Failure → OPEN.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      // Check if enough time has passed to transition to HALF_OPEN
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    if (this.state === CircuitState.HALF_OPEN) {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        throw new CircuitOpenError(this.name);
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitState {
    // Check for automatic transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
    return this.state;
  }

  /**
   * Manually reset the circuit breaker to CLOSED state.
   */
  reset(): void {
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
    this.lastFailureTime = 0;
    this.transitionTo(CircuitState.CLOSED);
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      // Successful call in HALF_OPEN → transition back to CLOSED
      this.consecutiveFailures = 0;
      this.halfOpenAttempts = 0;
      this.transitionTo(CircuitState.CLOSED);
    } else {
      // Reset failure count on success in CLOSED state
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      // Failed in HALF_OPEN → go back to OPEN
      this.halfOpenAttempts = 0;
      this.transitionTo(CircuitState.OPEN);
    } else if (this.state === CircuitState.CLOSED) {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;

    const previousState = this.state;
    this.state = newState;

    if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts = 0;
    }

    logger.info(`Circuit breaker '${this.name}' state transition`, {
      circuitBreaker: this.name,
      from: previousState,
      to: newState,
      consecutiveFailures: this.consecutiveFailures,
    });
  }
}
