import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { api } from './api';

type ClientEvent = 'practice_started' | 'recording_finished' | 'playback_started' | 'reminder_opted_in' | 'offer_viewed';

const queue: Array<{ event_id: string; name: string; properties?: Record<string, string | number | boolean>; platform?: 'ios' | 'android' }> = [];
let flushing = false;

/**
 * Minimal product telemetry: IDs, versions, states, durations. Never raw
 * speech, text, or email. Server-defined events (feedback_ready, purchase
 * verified...) are recorded by the server, not here.
 */
export function track(name: ClientEvent, properties: Record<string, string | number | boolean> = {}): void {
  queue.push({
    event_id: Crypto.randomUUID(),
    name,
    properties,
    platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : undefined,
  });
  void flush();
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, 50);
  try {
    await api.telemetry(batch);
  } catch {
    // Telemetry is best effort; drop on failure rather than retry forever.
  } finally {
    flushing = false;
  }
}
