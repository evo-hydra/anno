/**
 * Standardized Error Handling Middleware
 *
 * Provides consistent error responses across all endpoints
 *
 * @module middleware/error-handler
 */

import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
  timestamp: number;
  path: string;
}

/**
 * Standard error codes
 */
export enum ErrorCode {
  INVALID_REQUEST = 'invalid_request',
  VALIDATION_ERROR = 'validation_error',
  NOT_FOUND = 'not_found',
  UNAUTHORIZED = 'unauthorized',
  FORBIDDEN = 'forbidden',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  INTERNAL_ERROR = 'internal_error',
  SERVICE_UNAVAILABLE = 'service_unavailable',
  TIMEOUT = 'timeout',
  DEPENDENCY_ERROR = 'dependency_error'
}

/**
 * Custom application error class
 */
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Format error response
 */
function formatErrorResponse(
  error: Error | AppError | ZodError,
  req: Request
): ApiError {
  // Handle Zod validation errors
  if (error instanceof ZodError) {
    return {
      error: ErrorCode.VALIDATION_ERROR,
      message: 'Request validation failed',
      statusCode: 400,
      details: error.flatten(),
      timestamp: Date.now(),
      path: req.path
    };
  }

  // Handle custom AppError
  if (error instanceof AppError) {
    return {
      error: error.code,
      message: error.message,
      statusCode: error.statusCode,
      details: error.details,
      timestamp: Date.now(),
      path: req.path
    };
  }

  // Handle generic errors
  const statusCode = 'statusCode' in error ? (error.statusCode as number) : 500;
  const message = error.message || 'An unexpected error occurred';

  return {
    error: ErrorCode.INTERNAL_ERROR,
    message,
    statusCode,
    timestamp: Date.now(),
    path: req.path
  };
}

/**
 * Global error handler middleware
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const errorResponse = formatErrorResponse(err, req);

  // Log error with appropriate level
  if (errorResponse.statusCode >= 500) {
    logger.error('Server error', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      statusCode: errorResponse.statusCode
    });
  } else if (errorResponse.statusCode >= 400) {
    logger.warn('Client error', {
      error: err.message,
      path: req.path,
      method: req.method,
      statusCode: errorResponse.statusCode
    });
  }

  // Send error response
  res.status(errorResponse.statusCode).json(errorResponse);
};

/**
 * Async handler wrapper - catches async errors and passes to error middleware
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 handler for undefined routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  const error: ApiError = {
    error: ErrorCode.NOT_FOUND,
    message: `Route ${req.method} ${req.path} not found`,
    statusCode: 404,
    timestamp: Date.now(),
    path: req.path
  };

  logger.warn('Route not found', {
    path: req.path,
    method: req.method
  });

  res.status(404).json(error);
}
