import { useMutation, useQuery } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Row, Screen } from '../components/ui';
import { api, ApiClientError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { deviceTimeZone, reminderLabel } from '../lib/format';
import { newClientKey } from '../lib/keys';
import { cancelDailyReminder, getOsPermission, requestOsPermission, scheduleDailyReminder, type OsPermission } from '../lib/notifications';
import { queryClient } from '../lib/query';
import { pendingTakes, useTakes } from '../lib/takes';
import { track } from '../lib/telemetry';
import { colors, radius, spacing } from '../lib/theme';

const TIMES = ['07:00', '08:00', '12:30', '18:00', '19:00', '20:30'];

export default function Settings() {
  const router = useRouter();
  const { email, mode, signOut } = useAuth();
  const prefs = useQuery({ queryKey: ['preferences'], queryFn: api.preferences });
  const entitlement = useQuery({ queryKey: ['entitlements'], queryFn: api.entitlements });
  const progress = useQuery({ queryKey: ['progress'], queryFn: () => api.progress() });
  const takes = useTakes((s) => s.takes);
  const [osPermission, setOsPermission] = useState<OsPermission>('undetermined');
  const [deleteStep, setDeleteStep] = useState<'idle' | 'confirm' | 'pending'>('idle');

  // Check the OS permission each time settings opens.
  useFocusEffect(
    useCallback(() => {
      void getOsPermission().then(setOsPermission);
    }, []),
  );

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updatePreferences(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(['preferences'], data);
    },
  });

  const setReminder = async (enabled: boolean, time?: string) => {
    if (enabled) {
      const permission = await requestOsPermission();
      setOsPermission(permission);
      const chosen = time ?? prefs.data?.reminder_time ?? '19:00';
      if (permission === 'granted') {
        await scheduleDailyReminder(chosen);
        track('reminder_opted_in', { time: chosen });
      }
      await save.mutateAsync({ reminder_enabled: true, reminder_time: chosen, timezone: deviceTimeZone() });
    } else {
      await cancelDailyReminder();
      await save.mutateAsync({ reminder_enabled: false, reminder_time: null });
    }
  };

  const deleteAccount = useMutation({
    mutationFn: () => api.requestAccountDeletion({ client_key: newClientKey('delete') }),
    onSuccess: async () => {
      setDeleteStep('pending');
      await signOut();
      router.replace('/welcome');
    },
  });

  const p = prefs.data;
  const eligibleForReminder = (progress.data?.practices_completed ?? 0) > 0;

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        <Eyebrow>Settings</Eyebrow>
        <View style={{ width: 44 }} />
      </Row>
      <Heading>Your practice, your rules.</Heading>

      <Card>
        <Body style={{ fontWeight: '700' }}>Daily reminder</Body>
        {!eligibleForReminder ? <Label>Available after your first completed practice.</Label> : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <Body>Remind me daily</Body>
          <Switch value={!!p?.reminder_enabled} onValueChange={(v) => void setReminder(v)} disabled={!p || !eligibleForReminder || save.isPending} accessibilityLabel="Daily reminder" />
        </Row>
        {p?.reminder_enabled ? (
          <View style={{ gap: spacing.xs }}>
            <Label>Time · {reminderLabel(p.reminder_time)}</Label>
            <Row style={{ flexWrap: 'wrap' }}>
              {TIMES.map((t) => (
                <Pressable key={t} onPress={() => void setReminder(true, t)} accessibilityRole="radio" accessibilityState={{ checked: p.reminder_time === t }} style={[styles.time, p.reminder_time === t && styles.timeActive]}>
                  <Text style={[styles.timeText, p.reminder_time === t && { color: colors.surface }]}>{reminderLabel(t)}</Text>
                </Pressable>
              ))}
            </Row>
          </View>
        ) : null}
        {osPermission === 'denied' ? (
          <>
            <Label>Notifications are off for marshmemos in your device settings. The app works without them.</Label>
            <Button title="Open settings" variant="secondary" onPress={() => Linking.openSettings()} />
          </>
        ) : null}
        <Label>The reminder says only “Your marshmemos practice is ready.” Delivery is controlled by your device.</Label>
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>Practice plan</Body>
        <Body>{entitlement.data?.plan === 'pro' ? 'Pro is active.' : 'Free: one voice practice session per UTC day.'}</Body>
        <Button title={entitlement.data?.plan === 'pro' ? 'Manage Pro' : 'See Pro practice'} variant="secondary" onPress={() => router.push('/upgrade')} />
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>History and data</Body>
        <Label>Confirmed transcripts, feedback and progress stay until you delete them. Raw recordings and generated audio expire within 24 hours. Delete a single practice from its feedback screen.</Label>
        <Label>Recordings on this device: {pendingTakes(takes).length} pending.</Label>
        <Button title="Clear recordings on this device" variant="ghost" onPress={() => void useTakes.getState().clearAll()} />
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>Account</Body>
        <Label>{email ?? (mode === 'fixture' ? 'Development identity' : 'Signed in')}</Label>
        <Label>Timezone: {p?.timezone ?? '…'} (device: {deviceTimeZone()})</Label>
        {p && p.timezone !== deviceTimeZone() ? <Button title="Use device timezone" variant="ghost" onPress={() => save.mutate({ timezone: deviceTimeZone() })} /> : null}
        <Button title="Sign out" variant="secondary" onPress={() => void signOut().then(() => router.replace('/welcome'))} />
        {deleteStep === 'idle' ? (
          <Button title="Delete account" variant="ghost" onPress={() => setDeleteStep('confirm')} />
        ) : deleteStep === 'confirm' ? (
          <View style={{ gap: spacing.sm }}>
            <Body>This removes your practice history, transcripts, feedback and audio. It can’t be undone. Store subscriptions are managed separately in your store account.</Body>
            <Button title="Delete my account" variant="danger" onPress={() => Alert.alert('Delete account?', 'This cannot be undone.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => deleteAccount.mutate() }])} loading={deleteAccount.isPending} />
            <Button title="Keep my account" variant="ghost" onPress={() => setDeleteStep('idle')} />
            {deleteAccount.isError ? (
              <ErrorBox
                message={deleteAccount.error instanceof ApiClientError && deleteAccount.error.code === 'recent_auth_required' ? 'For safety, sign in again and then delete your account.' : 'Couldn’t start deletion. Try again.'}
                action={deleteAccount.error instanceof ApiClientError && deleteAccount.error.code === 'recent_auth_required' ? () => void signOut().then(() => router.replace('/auth')) : undefined}
                actionTitle="Sign in again"
              />
            ) : null}
          </View>
        ) : (
          <Label>Deletion is in progress.</Label>
        )}
      </Card>

      <Card>
        <Body style={{ fontWeight: '700' }}>Support</Body>
        <Label>Use “This feedback seems wrong” on any feedback screen. Transcript evidence is shared only with your consent. Operator contact, privacy and terms links are set by the app owner before release.</Label>
        <Label>Platform: {Platform.OS}</Label>
      </Card>
      {save.isError ? <ErrorBox message="Couldn’t save. Check your connection." /> : null}
      <Gap />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  time: { minHeight: 40, paddingHorizontal: spacing.md, borderRadius: radius.button, borderWidth: 1, borderColor: colors.primary, justifyContent: 'center', marginRight: spacing.xs, marginBottom: spacing.xs },
  timeActive: { backgroundColor: colors.primary },
  timeText: { color: colors.primary, fontWeight: '600' },
});
