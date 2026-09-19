import { useQuery } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { api } from '../lib/api';
import { AuthProvider, useAuth, type AuthStatus } from '../lib/auth';
import { configureNotificationHandling, routeFromNotification } from '../lib/notifications';
import { setPendingRoute, takePendingRoute } from '../lib/pending-route';
import { QueryProvider } from '../lib/query';
import { useTakes } from '../lib/takes';
import { colors } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);
configureNotificationHandling();

/** Routes reachable without an account: welcome, sign-in, the guest sample lesson. */
const PUBLIC_SEGMENTS = new Set(['welcome', 'auth', 'lesson', 'index', '']);

function Gate() {
  const { status, userId } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const hydrate = useTakes((s) => s.hydrate);
  const handledInitial = useRef(false);
  const previousStatus = useRef<AuthStatus>('loading');

  const prefs = useQuery({ queryKey: ['preferences', userId], queryFn: api.preferences, enabled: status === 'signed_in' });

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Reminder/deep-link taps: preserve the destination through sign-in.
  const lastResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    const route = routeFromNotification(lastResponse);
    if (!route) return;
    if (status === 'signed_in') router.replace(route as never);
    else if (status === 'signed_out') void setPendingRoute(route);
  }, [lastResponse, status, router]);

  useEffect(() => {
    if (status === 'loading') return;
    const first = segments[0] ?? '';
    const isPublic = PUBLIC_SEGMENTS.has(first);
    if (status === 'signed_out') {
      // Allow the next sign-in to redirect again, and only remember a destination when the
      // learner arrived signed out (deep link / relaunch), never when they just signed out.
      handledInitial.current = false;
      const cameFromSignedIn = previousStatus.current === 'signed_in';
      previousStatus.current = status;
      if (!isPublic) {
        if (!cameFromSignedIn) void setPendingRoute(`/${segments.join('/')}`);
        router.replace('/welcome');
      }
      SplashScreen.hideAsync().catch(() => undefined);
      return;
    }
    previousStatus.current = status;
    if (status === 'signed_in') {
      if (prefs.isPending) return;
      const onboarded = prefs.data?.onboarding_completed ?? true;
      if (!onboarded && first !== 'onboarding') {
        router.replace('/onboarding');
      } else if ((first === 'welcome' || first === 'auth' || first === '') && !handledInitial.current) {
        handledInitial.current = true;
        void takePendingRoute().then((pending) => router.replace((pending ?? '/(tabs)/today') as never));
      }
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [status, segments, router, prefs.isPending, prefs.data?.onboarding_completed]);

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="welcome" />
        <Stack.Screen name="auth" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="practice/[session]/record" options={{ gestureEnabled: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <QueryProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </QueryProvider>
  );
}
