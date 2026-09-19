import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { create } from 'zustand';

/**
 * Local takes: recordings kept in app-private document storage until the
 * transcript is confirmed or the learner discards them, at most 24 hours.
 * Metadata lives in AsyncStorage so an interrupted upload shows up as a
 * visible pending practice after relaunch. Sign-out clears everything.
 */
export const TAKE_TTL_MS = 24 * 3_600_000;

export type TakeState = 'recorded' | 'uploading' | 'uploaded' | 'transcribing' | 'confirmed';

export interface LocalTake {
  id: string;
  sessionId: string;
  attemptId: string | null;
  uri: string;
  durationMs: number;
  bytes: number | null;
  createdAt: number;
  expiresAt: number;
  state: TakeState;
  assetId: string | null;
  uploadClientKey: string;
  attemptClientKey: string;
  ordinal: number;
  roleplay: boolean;
}

interface TakeStore {
  takes: LocalTake[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (take: LocalTake) => Promise<void>;
  update: (id: string, patch: Partial<LocalTake>) => Promise<void>;
  remove: (id: string, deleteFile?: boolean) => Promise<void>;
  clearAll: () => Promise<void>;
  expire: () => Promise<void>;
}

const STORAGE_KEY = 'mm.takes.v1';

function takesDir(): Directory {
  const dir = new Directory(Paths.document, 'takes');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function takeFileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function takeFileSize(uri: string): number | null {
  try {
    const f = new File(uri);
    return f.exists ? (f.size ?? null) : null;
  } catch {
    return null;
  }
}

/** Moves a fresh recording into the app-private takes folder (document storage). */
export function persistRecording(sourceUri: string, takeId: string): string {
  const source = new File(sourceUri);
  const dest = new File(takesDir(), `${takeId}.m4a`);
  if (dest.exists) dest.delete();
  source.move(dest);
  return dest.uri;
}

function deleteFileQuietly(uri: string): void {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}

async function save(takes: LocalTake[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(takes));
}

export const useTakes = create<TakeStore>((set, get) => ({
  takes: [],
  hydrated: false,
  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const takes = raw ? (JSON.parse(raw) as LocalTake[]) : [];
      set({ takes, hydrated: true });
      await get().expire();
    } catch {
      set({ takes: [], hydrated: true });
    }
  },
  add: async (take) => {
    const takes = [...get().takes.filter((t) => t.id !== take.id), take];
    set({ takes });
    await save(takes);
  },
  update: async (id, patch) => {
    const takes = get().takes.map((t) => (t.id === id ? { ...t, ...patch } : t));
    set({ takes });
    await save(takes);
  },
  remove: async (id, deleteFile = true) => {
    const target = get().takes.find((t) => t.id === id);
    if (target && deleteFile) deleteFileQuietly(target.uri);
    const takes = get().takes.filter((t) => t.id !== id);
    set({ takes });
    await save(takes);
  },
  clearAll: async () => {
    for (const t of get().takes) deleteFileQuietly(t.uri);
    set({ takes: [] });
    await AsyncStorage.removeItem(STORAGE_KEY);
  },
  expire: async () => {
    const now = Date.now();
    const keep: LocalTake[] = [];
    for (const t of get().takes) {
      if (t.expiresAt <= now || t.state === 'confirmed') deleteFileQuietly(t.uri);
      else keep.push(t);
    }
    if (keep.length !== get().takes.length) {
      set({ takes: keep });
      await save(keep);
    }
  },
}));

export function pendingTakes(takes: LocalTake[]): LocalTake[] {
  return takes.filter((t) => t.state !== 'confirmed' && t.expiresAt > Date.now());
}
