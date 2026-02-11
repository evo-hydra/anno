import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, CircuitState, CircuitOpenError } from '../utils/circuit-breaker';

// Mock the logger to avoid noise in test output
vi.mock('../utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      halfOpenMaxAttempts: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through calls in CLOSED state', async () => {
    const fn = vi.fn().mockResolvedValue('hello');

    const result = await breaker.execute(fn);

    expect(result).toBe('hello');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('stays CLOSED when failures are below threshold', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Fail twice (threshold is 3)
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('opens after failure threshold reached', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Fail 3 times (threshold is 3)
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');
    await expect(breaker.execute(fn)).rejects.toThrow('fail');

    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  it('rejects immediately when OPEN (throws CircuitOpenError)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Subsequent calls should throw CircuitOpenError without executing fn
    const callCount = fn.mock.calls.length;
    await expect(breaker.execute(vi.fn())).rejects.toThrow(CircuitOpenError);
    await expect(breaker.execute(vi.fn())).rejects.toBeInstanceOf(CircuitOpenError);

    // The new functions should NOT have been called
    expect(fn).toHaveBeenCalledTimes(callCount);
  });

  it('transitions to HALF_OPEN after reset timeout', async () => {
    vi.useFakeTimers();

    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time past resetTimeoutMs
    vi.advanceTimersByTime(1001);

    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    vi.useRealTimers();
  });

  it('closes again on successful HALF_OPEN call', async () => {
    vi.useFakeTimers();

    const failFn = vi.fn().mockRejectedValue(new Error('fail'));
    const successFn = vi.fn().mockResolvedValue('recovered');

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time past resetTimeoutMs
    vi.advanceTimersByTime(1001);

    // Execute a successful call in HALF_OPEN
    const result = await breaker.execute(successFn);

    expect(result).toBe('recovered');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    vi.useRealTimers();
  });

  it('returns to OPEN on failed HALF_OPEN call', async () => {
    vi.useFakeTimers();

    const failFn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time past resetTimeoutMs
    vi.advanceTimersByTime(1001);

    // Execute a failing call in HALF_OPEN
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    vi.useRealTimers();
  });

  it('reset() returns to CLOSED state', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(fn)).rejects.toThrow('fail');
    }

    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Reset
    breaker.reset();

    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Should be able to execute calls again
    const successFn = vi.fn().mockResolvedValue('works');
    const result = await breaker.execute(successFn);
    expect(result).toBe('works');
  });

  it('resets consecutive failure count on success in CLOSED state', async () => {
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));
    const successFn = vi.fn().mockResolvedValue('ok');

    // Fail twice (below threshold of 3)
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');

    // Succeed once — should reset counter
    await breaker.execute(successFn);

    // Fail twice more — should still be CLOSED since counter was reset
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    await expect(breaker.execute(failFn)).rejects.toThrow('fail');

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });
});

describe('CircuitOpenError', () => {
  it('has correct name and message', () => {
    const error = new CircuitOpenError('my-service');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error.name).toBe('CircuitOpenError');
    expect(error.message).toContain('my-service');
    expect(error.message).toContain('OPEN');
  });
});
