/**
 * Request Context Middleware
 *
 * Adds request ID to all requests for correlation and tracing.
 *
 * @module middleware/request-context
 */

import { Request, Response, NextFunction } from 'express';
import { generateRequestId, setRequestContext } from '../utils/logger';

/**
 * Middleware to add request ID and context to all requests
 */
export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  // Get request ID from header or generate new one
  const requestId = (req.header('x-request-id') || generateRequestId()) as string;

  // Set response header
  res.setHeader('x-request-id', requestId);

  // Set context for logging
  setRequestContext({
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.header('user-agent')
  });

  next();
};
