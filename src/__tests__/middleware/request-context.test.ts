import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { requestContextMiddleware } from '../../middleware/request-context';
import * as logger from '../../utils/logger';

vi.mock('../../utils/logger', () => ({
  generateRequestId: vi.fn(),
  setRequestContext: vi.fn()
}));

describe('requestContextMiddleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRequest = {
      header: vi.fn(),
      method: 'GET',
      path: '/api/test'
    };

    mockResponse = {
      setHeader: vi.fn()
    };

    mockNext = vi.fn();
  });

  it('uses existing x-request-id header if provided', () => {
    const existingRequestId = 'existing-req-id-123';
    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return existingRequestId;
      if (headerName === 'user-agent') return 'Mozilla/5.0';
      return undefined;
    });

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockRequest.header).toHaveBeenCalledWith('x-request-id');
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', existingRequestId);
    expect(logger.generateRequestId).not.toHaveBeenCalled();
  });

  it('generates a new request ID if none provided', () => {
    const generatedRequestId = 'generated-req-id-456';
    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return undefined;
      if (headerName === 'user-agent') return 'Mozilla/5.0';
      return undefined;
    });
    (logger.generateRequestId as ReturnType<typeof vi.fn>).mockReturnValue(generatedRequestId);

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(logger.generateRequestId).toHaveBeenCalled();
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', generatedRequestId);
  });

  it('sets x-request-id response header', () => {
    const requestId = 'test-request-id';
    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return requestId;
      if (headerName === 'user-agent') return 'Chrome/100';
      return undefined;
    });

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', requestId);
    expect(mockResponse.setHeader).toHaveBeenCalledTimes(1);
  });

  it('calls setRequestContext with correct data', () => {
    const requestId = 'context-test-id';
    const userAgent = 'TestAgent/1.0';

    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return requestId;
      if (headerName === 'user-agent') return userAgent;
      return undefined;
    });

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(logger.setRequestContext).toHaveBeenCalledWith({
      requestId,
      method: 'GET',
      path: '/api/test',
      userAgent
    });
  });

  it('calls next()', () => {
    (mockRequest.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (logger.generateRequestId as ReturnType<typeof vi.fn>).mockReturnValue('next-test-id');

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(mockNext).toHaveBeenCalled();
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('handles missing user-agent header', () => {
    const requestId = 'no-ua-id';

    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return requestId;
      if (headerName === 'user-agent') return undefined;
      return undefined;
    });

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(logger.setRequestContext).toHaveBeenCalledWith({
      requestId,
      method: 'GET',
      path: '/api/test',
      userAgent: undefined
    });
    expect(mockNext).toHaveBeenCalled();
  });

  it('handles POST request with different path', () => {
    const requestId = 'post-test-id';
    mockRequest.method = 'POST';
    mockRequest.path = '/api/content';

    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return requestId;
      if (headerName === 'user-agent') return 'Safari/15.0';
      return undefined;
    });

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    expect(logger.setRequestContext).toHaveBeenCalledWith({
      requestId,
      method: 'POST',
      path: '/api/content',
      userAgent: 'Safari/15.0'
    });
  });

  it('generates new ID when x-request-id header is empty string', () => {
    const generatedId = 'empty-string-fallback-id';

    (mockRequest.header as ReturnType<typeof vi.fn>).mockImplementation((headerName: string) => {
      if (headerName === 'x-request-id') return '';
      if (headerName === 'user-agent') return 'Test';
      return undefined;
    });
    (logger.generateRequestId as ReturnType<typeof vi.fn>).mockReturnValue(generatedId);

    requestContextMiddleware(
      mockRequest as Request,
      mockResponse as Response,
      mockNext
    );

    // Empty string is falsy, so generateRequestId should be called
    expect(logger.generateRequestId).toHaveBeenCalled();
    expect(mockResponse.setHeader).toHaveBeenCalledWith('x-request-id', generatedId);
  });
});
