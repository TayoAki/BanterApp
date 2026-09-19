import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

/**
 * Bounded opaque client keys (16–128 URL-safe chars) scoped per purpose.
 * A key is created once and reused for retries of the same logical action
 * so the server can treat repeats idempotently.
 */
export function newClientKey(prefix: string): string {
  return `${prefix}-${Crypto.randomUUID()}`.slice(0, 128);
}

const PREFIX = 'mm.key.';

export async function stableClientKey(purpose: string): Promise<string> {
  const storageKey = `${PREFIX}${purpose}`;
  const existing = await AsyncStorage.getItem(storageKey);
  if (existing) return existing;
  const created = newClientKey(purpose.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 24) || 'k');
  await AsyncStorage.setItem(storageKey, created);
  return created;
}

export async function forgetClientKey(purpose: string): Promise<void> {
  await AsyncStorage.removeItem(`${PREFIX}${purpose}`);
}

export async function clearAllClientKeys(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  for (const k of keys.filter((k) => k.startsWith(PREFIX))) await AsyncStorage.removeItem(k);
}
