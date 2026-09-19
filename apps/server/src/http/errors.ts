import type { ApiErrorCode } from '@marshmemos/contracts';

/**
 * API error envelope: {code, message, retryable, request_id}. Never includes
 * secrets or provider payloads.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: ApiErrorCode | string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  static unauthenticated(message = 'Sign in required.') {
    return new ApiError(401, 'unauthenticated', message);
  }
  static forbidden(message = 'Not allowed.') {
    return new ApiError(403, 'forbidden', message);
  }
  /** Missing or deliberately concealed foreign resource. */
  static notFound(message = 'Not found.') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, details?: Record<string, unknown>) {
    return new ApiError(409, 'conflict', message, details ? { details } : {});
  }
  static tooLarge(message: string) {
    return new ApiError(413, 'payload_too_large', message);
  }
  static unprocessable(message: string, details?: Record<string, unknown>) {
    return new ApiError(422, 'unprocessable', message, details ? { details } : {});
  }
  static validation(message: string, details?: Record<string, unknown>) {
    return new ApiError(422, 'validation_failed', message, details ? { details } : {});
  }
  static quota(message: string, details?: Record<string, unknown>) {
    return new ApiError(429, 'quota_exceeded', message, { retryable: false, ...(details ? { details } : {}) });
  }
  static rateLimited(message = 'Too many requests.') {
    return new ApiError(429, 'rate_limited', message, { retryable: true });
  }
  static unavailable(message = 'Service temporarily unavailable.') {
    return new ApiError(503, 'service_unavailable', message, { retryable: true });
  }
}
