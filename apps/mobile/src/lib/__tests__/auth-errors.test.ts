import { describe, expect, it } from 'vitest';
import { ApiClientError } from '../api';
import { friendlyAuthError, isPlausibleEmail } from '../auth-errors';

describe('sign-in error copy', () => {
  it('maps API error codes to learner-facing messages without leaking internals', () => {
    expect(friendlyAuthError(new ApiClientError(401, 'unauthenticated', 'Email or password is incorrect.', false, 'r1', undefined))).toBe('Email or password is incorrect.');
    expect(friendlyAuthError(new ApiClientError(429, 'rate_limited', 'Too many requests.', true, 'r1', undefined))).toMatch(/Too many attempts/);
    expect(friendlyAuthError(new ApiClientError(409, 'conflict', 'That email can’t be used to create an account right now. If it’s yours, sign in instead.', false, 'r1', undefined))).toMatch(/sign in instead/);
    expect(friendlyAuthError(new ApiClientError(422, 'validation_failed', 'Use at least 8 characters.', false, 'r1', undefined))).toBe('Use at least 8 characters.');
    expect(friendlyAuthError(new ApiClientError(500, 'internal', 'stack trace here', true, 'r1', undefined))).not.toContain('stack');
    expect(friendlyAuthError(ApiClientError.offline())).toMatch(/offline/);
    expect(friendlyAuthError(new Error('TypeError: fetch'))).not.toContain('TypeError');
  });

  it('accepts plausible emails only', () => {
    expect(isPlausibleEmail(' learner@example.com ')).toBe(true);
    expect(isPlausibleEmail('learner@example')).toBe(false);
    expect(isPlausibleEmail('not an email')).toBe(false);
  });
});
