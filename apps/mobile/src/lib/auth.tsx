import AsyncStorage from '@react-native-async-storage/async-storage';
import type { AuthTokensDto } from '@marshmemos/contracts/api';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { api, ApiClientError, setTokenProvider, setUnauthorizedHandler } from './api';
import { fixtureSignInAvailable } from './env';
import { clearAllClientKeys } from './keys';
import { cancelDailyReminder } from './notifications';
import { configurePurchases, resetPurchasesIdentity } from './purchases';
import { queryClient } from './query';
import { secureStore } from './secure-store';
import { useTakes } from './takes';

/**
 * Authentication state. Production uses email + password accounts served by
 * the API: a short-lived access token plus a rotating refresh token, both
 * kept in encrypted secure storage. The access token is refreshed shortly
 * before it expires and once more on an unexpected 401. When the build is
 * configured for a fixture server (local development only), a development
 * identity `fixture:<uuid>` is accepted instead; the server refuses that
 * mode in production.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';

interface StoredSession {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when the access token expires. */
  expires_at: number;
  user_id: string;
  email: string;
  /** Epoch ms of the last password proof (sign-in or account creation). */
  auth_at: number;
}

interface AuthValue {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  mode: 'password' | 'fixture';
  signIn: (email: string, password: string) => Promise<void>;
  createAccount: (email: string, password: string) => Promise<void>;
  signInDevelopment: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Seconds since the last sign-in, for recent-auth gated actions. */
  authAgeSeconds: () => number | null;
}

const AuthContext = createContext<AuthValue | null>(null);
const SESSION_KEY = 'mm.session.v1';
const DEV_TOKEN_KEY = 'mm.dev.token';
const AUTH_AT_KEY = 'mm.auth.at';
/** Refresh this long before the access token expires so requests never race the expiry. */
const REFRESH_SKEW_MS = 60_000;

function sessionFromTokens(tokens: AuthTokensDto, authAt: number): StoredSession {
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    user_id: tokens.user_id,
    email: tokens.email,
    auth_at: authAt,
  };
}

function parseStored(raw: string | null): StoredSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string' || typeof s.user_id !== 'string') return null;
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: typeof s.expires_at === 'number' ? s.expires_at : 0,
      user_id: s.user_id,
      email: typeof s.email === 'string' ? s.email : '',
      auth_at: typeof s.auth_at === 'number' ? s.auth_at : 0,
    };
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<StoredSession | null>(null);
  const [devUser, setDevUser] = useState<string | null>(null);
  const sessionRef = useRef<StoredSession | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);
  const mode: AuthValue['mode'] = fixtureSignInAvailable ? 'fixture' : 'password';

  const persist = useCallback(async (next: StoredSession | null) => {
    sessionRef.current = next;
    setSession(next);
    if (next) await secureStore.setItem(SESSION_KEY, JSON.stringify(next));
    else await secureStore.removeItem(SESSION_KEY);
  }, []);

  /** Rotates the refresh token; a revoked or expired session signs the learner out. Network failures keep the session. */
  const refresh = useCallback((): Promise<string | null> => {
    if (refreshing.current) return refreshing.current;
    const current = sessionRef.current;
    if (!current) return Promise.resolve(null);
    refreshing.current = (async () => {
      try {
        const tokens = await api.refreshSession({ refresh_token: current.refresh_token });
        const next = sessionFromTokens(tokens, current.auth_at);
        await persist(next);
        return next.access_token;
      } catch (e) {
        if (e instanceof ApiClientError && (e.status === 401 || e.status === 403)) {
          await persist(null);
          setStatus('signed_out');
        }
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [persist]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (mode === 'fixture') {
        const stored = await AsyncStorage.getItem(DEV_TOKEN_KEY);
        if (!mounted) return;
        setDevUser(stored);
        setStatus(stored ? 'signed_in' : 'signed_out');
        return;
      }
      const stored = parseStored(await secureStore.getItem(SESSION_KEY));
      if (!mounted) return;
      sessionRef.current = stored;
      setSession(stored);
      lastAuthAt = stored?.auth_at ?? null;
      setStatus(stored ? 'signed_in' : 'signed_out');
    })();
    return () => {
      mounted = false;
    };
  }, [mode]);

  useEffect(() => {
    setTokenProvider(async () => {
      if (mode === 'fixture') return devUser ? `fixture:${devUser}` : null;
      const current = sessionRef.current;
      if (!current) return null;
      if (current.expires_at - Date.now() < REFRESH_SKEW_MS) return (await refresh()) ?? current.access_token;
      return current.access_token;
    });
    setUnauthorizedHandler(async () => (mode === 'fixture' ? null : refresh()));
  }, [mode, devUser, refresh]);

  const userId = mode === 'fixture' ? devUser : session?.user_id ?? null;
  const email = mode === 'fixture' ? null : session?.email ?? null;

  useEffect(() => {
    if (userId) void configurePurchases(userId).catch(() => undefined);
  }, [userId]);

  const onSignedIn = useCallback(
    async (tokens: AuthTokensDto) => {
      lastAuthAt = Date.now();
      await AsyncStorage.setItem(AUTH_AT_KEY, String(lastAuthAt));
      await persist(sessionFromTokens(tokens, lastAuthAt));
      setStatus('signed_in');
    },
    [persist],
  );

  const signIn = useCallback(
    async (address: string, password: string) => {
      if (mode !== 'password') throw new Error('Sign-in is not configured for this build.');
      await onSignedIn(await api.login({ email: address.trim(), password }));
    },
    [mode, onSignedIn],
  );

  const createAccount = useCallback(
    async (address: string, password: string) => {
      if (mode !== 'password') throw new Error('Sign-in is not configured for this build.');
      await onSignedIn(await api.register({ email: address.trim(), password }));
    },
    [mode, onSignedIn],
  );

  const signInDevelopment = useCallback(
    async (id: string) => {
      if (mode !== 'fixture') throw new Error('Development sign-in is unavailable.');
      await AsyncStorage.setItem(DEV_TOKEN_KEY, id);
      lastAuthAt = Date.now();
      await AsyncStorage.setItem(AUTH_AT_KEY, String(lastAuthAt));
      setDevUser(id);
      setStatus('signed_in');
    },
    [mode],
  );

  const signOut = useCallback(async () => {
    // Logout clears user-specific caches, local audio, scheduled reminders and billing identity,
    // then revokes the refresh session on the server (best effort; the local copy is gone regardless).
    const current = sessionRef.current;
    queryClient.clear();
    await useTakes.getState().clearAll();
    await cancelDailyReminder();
    await clearAllClientKeys();
    await resetPurchasesIdentity();
    for (const k of [DEV_TOKEN_KEY, AUTH_AT_KEY, 'mm.pendingRoute']) await AsyncStorage.removeItem(k);
    lastAuthAt = null;
    await persist(null);
    if (current) void api.logout({ refresh_token: current.refresh_token }).catch(() => undefined);
    setDevUser(null);
    setStatus('signed_out');
  }, [persist]);

  const authAgeSeconds = useCallback(() => {
    // Read synchronously from the last known value; callers re-check with the server anyway.
    return lastAuthAt ? Math.floor((Date.now() - lastAuthAt) / 1000) : null;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, userId, email, mode, signIn, createAccount, signInDevelopment, signOut, authAgeSeconds }),
    [status, userId, email, mode, signIn, createAccount, signInDevelopment, signOut, authAgeSeconds],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

let lastAuthAt: number | null = null;
void AsyncStorage.getItem(AUTH_AT_KEY).then((v) => {
  lastAuthAt = v ? Number(v) : null;
});

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
