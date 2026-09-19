import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bubble } from '../../components/Bubble';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Loading, Pill, Row, Screen } from '../../components/ui';
import { api, ApiClientError } from '../../lib/api';
import { localTime } from '../../lib/format';
import { routeForAttempt, startSession } from '../../lib/practice';
import { pendingTakes, useTakes } from '../../lib/takes';
import { brand, colors, spacing } from '../../lib/theme';

export default function Today() {
  const router = useRouter();
  const today = useQuery({ queryKey: ['today'], queryFn: api.today });
  const takes = useTakes((s) => s.takes);
  const pending = pendingTakes(takes);
  const start = useMutation({
    mutationFn: (assignmentId: string) => startSession({ assignmentId, mode: 'daily' }),
    onSuccess: (session) => router.push(`/practice/${session.session_id}/record`),
  });

  const data = today.data;
  const quotaUsed = !!data && data.allowance.remaining === 0 && !data.pending_session && !data.completed_today;

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.brand}>{brand.name}</Text>
        <Row>
          {data && data.streak_days > 0 ? <Pill tone="accent">🔥 {data.streak_days} {data.streak_days === 1 ? 'day' : 'days'}</Pill> : null}
          <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Settings" style={styles.settings}>
            <Text style={{ fontSize: 20, color: colors.muted }}>⚙︎</Text>
          </Pressable>
        </Row>
      </Row>
      <Heading>What’s your story today?</Heading>

      {today.isPending ? <Loading label="Loading today’s practice" /> : null}
      {today.isError ? (
        <ErrorBox
          message={today.error instanceof ApiClientError && today.error.code === 'offline' ? 'You’re offline. Saved practice stays on this device until you reconnect.' : 'Couldn’t load today’s practice.'}
          action={() => today.refetch()}
          actionTitle="Try again"
        />
      ) : null}

      {pending.length > 0 ? (
        <Card tone="lavender">
          <Label style={{ color: colors.ink, fontWeight: '600' }}>Pending practice on this device</Label>
          <Body>A recording is waiting to be sent. It stays here for 24 hours.</Body>
          <Button title="Review pending recording" variant="secondary" onPress={() => router.push(`/practice/${pending[0]!.sessionId}/review-recording?take=${pending[0]!.id}`)} />
        </Card>
      ) : null}

      {data?.pending_session && !data.completed_today ? (
        <Card>
          <Label>In progress</Label>
          <Body>You have a practice session under way.</Body>
          <Button
            title="Continue"
            onPress={() =>
              router.push(
                data.pending_session!.attempt_id
                  ? routeForAttempt({ attempt_id: data.pending_session!.attempt_id, session_id: data.pending_session!.session_id, stage: data.pending_session!.stage ?? 'created', evaluation_id: null })
                  : `/practice/${data.pending_session!.session_id}/record`,
              )
            }
          />
        </Card>
      ) : null}

      {data?.content_state === 'no_published_prompt' ? (
        <Card>
          <Label>Today</Label>
          <Body>No practice prompt is published yet. You can still read the lessons.</Body>
          <Button title="Go to Learn" variant="secondary" onPress={() => router.push('/(tabs)/learn')} />
        </Card>
      ) : null}

      {data?.assignment ? (
        <>
          <Card tone="lavender">
            <Eyebrow>Today’s framework</Eyebrow>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '700' }}>{data.assignment.framework.app_title}</Body>
              <Label>Framework {data.assignment.framework.framework_number}</Label>
            </Row>
            {data.assignment.reason === 'review_due' ? <Pill tone="accent">Review due</Pill> : null}
          </Card>
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1 }}>
                <Body style={{ fontWeight: '700', fontSize: 20, lineHeight: 26 }}>{data.assignment.framework.objective}</Body>
              </View>
              <Bubble size={48} />
            </Row>
            <Body>{data.assignment.prompt.prompt}</Body>
            <View style={{ gap: spacing.xs }}>
              <Label style={{ fontWeight: '600', color: colors.ink }}>Your three targets</Label>
              {data.assignment.prompt.criteria.map((c) => (
                <Row key={c.id}>
                  <Text style={{ color: colors.primary }}>•</Text>
                  <Body style={{ flex: 1 }}>{c.label}</Body>
                  <Label>{c.origin === 'source_rule' ? 'source' : 'exercise'}</Label>
                </Row>
              ))}
            </View>
            <Row style={{ justifyContent: 'space-between' }}>
              <Label>⏱ {data.assignment.prompt.target_seconds.min}–{data.assignment.prompt.target_seconds.max} seconds</Label>
              <Label>Framework {data.assignment.framework.framework_number}</Label>
            </Row>
            <Label>
              {data.allowance.plan === 'pro' ? 'Pro' : 'Free'} · {data.allowance.remaining} of {data.allowance.allowed_sessions} practice {data.allowance.allowed_sessions === 1 ? 'session' : 'sessions'} left today · resets {localTime(data.allowance.resets_at)}
            </Label>
            {data.completed_today ? (
              <>
                <Pill tone="success">Done for today</Pill>
                {data.completed_today.evaluation_id ? <Button title="See today’s feedback" variant="secondary" onPress={() => router.push(`/attempt/${data.completed_today!.attempt_id}/feedback`)} /> : null}
              </>
            ) : quotaUsed ? (
              <>
                <Body muted>Today’s practice allowance is used. It resets at {localTime(data.allowance.resets_at)}.</Body>
                <Button title="Continue learning" variant="secondary" onPress={() => router.push('/(tabs)/learn')} />
                {data.allowance.plan === 'free' ? <Button title="See Pro practice" variant="ghost" onPress={() => router.push('/upgrade')} /> : null}
              </>
            ) : !data.pending_session ? (
              <Button title="Start speaking" onPress={() => start.mutate(data.assignment!.id)} loading={start.isPending} accessibilityHint="Opens the recording screen and asks for microphone access if needed" />
            ) : null}
            {start.isError ? (
              <ErrorBox message={start.error instanceof ApiClientError ? start.error.message : 'Couldn’t start a session.'} />
            ) : null}
          </Card>
        </>
      ) : null}

      {data && data.next_units.length > 0 ? (
        <>
          <Gap size={spacing.sm} />
          <Body style={{ fontWeight: '700' }}>Your next moves</Body>
          {data.next_units.slice(0, 4).map((u) => (
            <Pressable key={u.framework_id} onPress={() => router.push('/(tabs)/learn')} accessibilityRole="button" style={styles.unitRow}>
              <Text style={{ color: u.state === 'new' ? colors.muted : colors.success }}>{u.state === 'new' ? '○' : '●'}</Text>
              <Body style={{ flex: 1 }}>{u.app_title}</Body>
              <Label>{u.state === 'new' ? 'Up next' : u.state === 'review_due' ? 'Review due' : u.state === 'ready' ? 'Ready' : 'Developing'}</Label>
            </Pressable>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { fontSize: 22, fontWeight: '800', color: colors.ink },
  settings: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  unitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
});
