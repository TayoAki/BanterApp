import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const REMINDER_CHANNEL = 'practice-reminders';
const REMINDER_ID_KEY = 'mm.reminder.notificationId';

/** Generic lock-screen copy only: no transcripts, scores, or sensitive context. */
export const REMINDER_BODY = 'Your marshmemos practice is ready.';

export function configureNotificationHandling(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
    name: 'Practice reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    vibrationPattern: null,
  });
}

export type OsPermission = 'granted' | 'denied' | 'undetermined';

export async function getOsPermission(): Promise<OsPermission> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return 'granted';
  return p.canAskAgain ? 'undetermined' : 'denied';
}

/** Asks only when the learner opts in; denial leaves the app usable. */
export async function requestOsPermission(): Promise<OsPermission> {
  await ensureChannel();
  const p = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
  if (p.granted) return 'granted';
  return p.canAskAgain ? 'undetermined' : 'denied';
}

/** Schedules (replacing) the single daily local reminder at hh:mm local time. */
export async function scheduleDailyReminder(hhmm: string): Promise<boolean> {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return false;
  if ((await getOsPermission()) !== 'granted') return false;
  await ensureChannel();
  await cancelDailyReminder();
  const id = await Notifications.scheduleNotificationAsync({
    content: { title: 'marshmemos', body: REMINDER_BODY, data: { route: '/(tabs)/today' } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: h, minute: m, channelId: REMINDER_CHANNEL },
  });
  await AsyncStorage.setItem(REMINDER_ID_KEY, id);
  return true;
}

export async function cancelDailyReminder(): Promise<void> {
  const id = await AsyncStorage.getItem(REMINDER_ID_KEY);
  if (id) {
    try {
      await Notifications.cancelScheduledNotificationAsync(id);
    } catch {
      // already gone
    }
    await AsyncStorage.removeItem(REMINDER_ID_KEY);
  }
  // Defensive: remove any stale reminders from previous installs.
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of all) if ((n.content.data as { route?: string } | null)?.route) await Notifications.cancelScheduledNotificationAsync(n.identifier);
  } catch {
    // ignore
  }
}

export function routeFromNotification(response: Notifications.NotificationResponse | null | undefined): string | null {
  const data = response?.notification.request.content.data as { route?: unknown } | undefined;
  return typeof data?.route === 'string' ? data.route : null;
}
