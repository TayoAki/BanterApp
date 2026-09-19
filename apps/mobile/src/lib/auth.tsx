import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';
import { setTokenProvider } from './api';
import { env, supabaseConfigured } from './env';
import { clearAllClientKeys } from './keys';
import { cancelDailyReminder } from './notifications';
import { configurePurchases, resetPurchasesIdentity } from './purchases';
import { queryClient } from './query';
import { getSupabase } from './supabase';
import { useTakes } from './takes';

/**
 * Authentication state. Production uses Supabase email one-time codes with
 * the session persisted through encrypted secure storage. When no Supabase
 * project is configured (local development against the fixture server), a
 * development token `fixture:<uuid>` is accepted so the whole flow can run;
 * the server refuses that mode in production.
 */
export type AuthStatus = 'loading' | 'signed_out' | 'signed_in';

interface AuthValue {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  mode: 'supabase' | 'development';
  sendCode: (email: string) => Promise<void>;
  verifyCode: (email: string, code: string) => Promise<void>;
  signInDevelopment: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Seconds since the last sign-in, for recent-auth gated actions. */
  authAgeSeconds: () => number | null;
}

const AuthContext = createContext<AuthValue | null>(null);
const DEV_TOKEN_KEY = 'mm.dev.token';
const AUTH_AT_KEY = 'mm.auth.at';

export function AuthProvider({ children }: PropsWithChildren) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [devUser, setDevUser] = useState<string | null>(null);
  const mode: AuthValue['mode'] = supabaseConfigured ? 'supabase' : 'development';

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    (async () => {
      if (mode === 'supabase') {
        const supabase = getSupabase()!;
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session);
        setStatus(data.session ? 'signed_in' : 'signed_out');
        const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
          setSession(next);
          setStatus(next ? 'signed_in' : 'signed_out');
        });
        unsubscribe = () => sub.subscription.unsubscribe();
        return;
      }
      const stored = env.name === 'production' ? null : await AsyncStorage.getItem(DEV_TOKEN_KEY);
      if (!mounted) return;
      setDevUser(stored);
      setStatus(stored ? 'signed_in' : 'signed_out');
    })();
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [mode]);

  useEffect(() => {
    setTokenProvider(async () => {
      if (mode === 'supabase') {
        const supabase = getSupabase();
        if (!supabase) return null;
        const { data } = await supabase.auth.getSession();
        return data.session?.access_token ?? null;
      }
      return devUser ? `fixture:${devUser}` : null;
    });
  }, [mode, devUser]);

  const userId = mode === 'supabase' ? session?.user.id ?? null : devUser;
  const email = mode === 'supabase' ? session?.user.email ?? null : null;

  useEffect(() => {
    if (userId) void configurePurchases(userId).catch(() => undefined);
  }, [userId]);

  const sendCode = useCallback(async (address: string) => {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Sign-in is not configured for this build.');
    const { error } = await supabase.auth.signInWithOtp({ email: address.trim(), options: { shouldCreateUser: true } });
    if (error) throw error;
  }, []);

  const verifyCode = useCallback(async (address: string, code: string) => {
    const supabase = getSupabase();
    if (!supabase) throw new Error('Sign-in is not configured for this build.');
    const { error } = await supabase.auth.verifyOtp({ email: address.trim(), token: code.trim(), type: 'email' });
    if (error) throw error;
    lastAuthAt = Date.now();
    await AsyncStorage.setItem(AUTH_AT_KEY, String(lastAuthAt));
  }, []);

  const signInDevelopment = useCallback(async (id: string) => {
    if (env.name === 'production' || mode === 'supabase') throw new Error('Development sign-in is unavailable.');
    await AsyncStorage.setItem(DEV_TOKEN_KEY, id);
    lastAuthAt = Date.now();
    await AsyncStorage.setItem(AUTH_AT_KEY, String(lastAuthAt));
    setDevUser(id);
    setStatus('signed_in');
  }, [mode]);

  const signOut = useCallback(async () => {
    // Logout clears user-specific caches, local audio, scheduled reminders and billing identity.
    queryClient.clear();
    await useTakes.getState().clearAll();
    await cancelDailyReminder();
    await clearAllClientKeys();
    await resetPurchasesIdentity();
    for (const k of [DEV_TOKEN_KEY, AUTH_AT_KEY, 'mm.pendingRoute']) await AsyncStorage.removeItem(k);
    lastAuthAt = null;
    if (mode === 'supabase') await getSupabase()?.auth.signOut();
    setDevUser(null);
    setSession(null);
    setStatus('signed_out');
  }, [mode]);

  const authAgeSeconds = useCallback(() => {
    // Read synchronously from the last known value; callers re-check with the server anyway.
    return lastAuthAt ? Math.floor((Date.now() - lastAuthAt) / 1000) : null;
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, userId, email, mode, sendCode, verifyCode, signInDevelopment, signOut, authAgeSeconds }),
    [status, userId, email, mode, sendCode, verifyCode, signInDevelopment, signOut, authAgeSeconds],
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
