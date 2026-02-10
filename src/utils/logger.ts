/*
 * Structured logger with request ID correlation and performance tracing.
 */
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  requestId?: string;
  traceId?: string;
  parentSpanId?: string;
  spanId?: string;
  [key: string]: unknown;
}

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const envLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
const threshold = levelPriority[envLevel] ?? levelPriority.info;

// AsyncLocalStorage for request context
const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

const log = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
  if (levelPriority[level] < threshold) {
    return;
  }

  const context = asyncLocalStorage.getStore() || {};

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
    ...meta
  };

  console.log(JSON.stringify(payload));
};

/**
 * Set request context for correlation across async operations
 */
export const setRequestContext = (context: LogContext): void => {
  const store = asyncLocalStorage.getStore() || {};
  asyncLocalStorage.enterWith({ ...store, ...context });
};

/**
 * Get current request context
 */
export const getRequestContext = (): LogContext => {
  return asyncLocalStorage.getStore() || {};
};

/**
 * Run function with request context
 */
export const runWithContext = <T>(context: LogContext, fn: () => T): T => {
  return asyncLocalStorage.run(context, fn);
};

/**
 * Generate new request ID
 */
export const generateRequestId = (): string => {
  return randomUUID();
};

/**
 * Start a trace span
 */
export const startSpan = (name: string): { end: (meta?: Record<string, unknown>) => void } => {
  const spanId = randomUUID();
  const context = getRequestContext();
  const startTime = Date.now();

  setRequestContext({
    ...context,
    parentSpanId: context.spanId,
    spanId
  });

  log('debug', `Span started: ${name}`, { span: name, spanId });

  return {
    end: (meta?: Record<string, unknown>) => {
      const duration = Date.now() - startTime;
      log('debug', `Span ended: ${name}`, {
        span: name,
        spanId,
        durationMs: duration,
        ...meta
      });

      // Restore parent span
      if (context.parentSpanId) {
        setRequestContext({
          ...context,
          spanId: context.parentSpanId,
          parentSpanId: undefined
        });
      }
    }
  };
};

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta)
};
