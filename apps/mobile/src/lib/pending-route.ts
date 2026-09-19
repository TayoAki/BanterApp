import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mm.pendingRoute';

/** Destination to resume after sign-in (deep link, reminder tap, interrupted flow). */
export async function setPendingRoute(route: string): Promise<void> {
  await AsyncStorage.setItem(KEY, route);
}

export async function takePendingRoute(): Promise<string | null> {
  const r = await AsyncStorage.getItem(KEY);
  if (r) await AsyncStorage.removeItem(KEY);
  return r;
}
