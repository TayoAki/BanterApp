import { ApiClientError } from './api';

/** Learner-facing copy for sign-in failures. Never echoes raw provider or server internals. */
export function friendlyAuthError(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'offline' || e.code === 'timeout') return 'You’re offline or the connection timed out. Try again.';
    if (e.code === 'rate_limited') return 'Too many attempts. Wait a few minutes and try again.';
    if (e.code === 'unauthenticated') return 'Email or password is incorrect.';
    if (e.code === 'conflict' || e.code === 'validation_failed') return e.message;
    if (e.status >= 500) return 'Something went wrong on our side. Try again shortly.';
    return e.message || 'Sign-in didn’t work. Try again.';
  }
  return 'Sign-in didn’t work. Check your connection and try again.';
}

export function isPlausibleEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

export const PASSWORD_MIN_LENGTH = 8;
