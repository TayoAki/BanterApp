import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SkillState } from '@marshmemos/contracts/api';
import { Body, Card, ErrorBox, Heading, Label, Loading, Pill, Row, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { localDateTime, reminderLabel } from '../../lib/format';
import { brand, colors, spacing } from '../../lib/theme';

const STATE_LABEL: Record<SkillState, string> = { new: 'Up next', developing: 'Developing', ready: 'Ready', review_due: 'Review due' };

export default function Progress() {
  const router = useRouter();
  const progress = useQuery({ queryKey: ['progress'], queryFn: () => api.progress() });
  const prefs = useQuery({ queryKey: ['preferences'], queryFn: api.preferences });
  const d = progress.data;

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text style={styles.brand}>{brand.name}</Text>
        {d ? (
          <Row>
            <Pill tone="accent">🔥 {d.streak_days} day streak</Pill>
            <Pill>{d.practices_completed} practices</Pill>
          </Row>
        ) : null}
      </Row>
      <Heading>Small reps. Real progress.</Heading>
      {progress.isPending ? <Loading label="Loading progress" /> : null}
      {progress.isError ? <ErrorBox message="Couldn’t load progress." action={() => progress.refetch()} actionTitle="Try again" /> : null}

      {d && d.history.length === 0 ? (
        <Card>
          <Body>No saved practice yet. Your first session shows up here with its criterion scores.</Body>
        </Card>
      ) : null}

      {d && d.history.length > 0 ? (
        <Card>
          <Label>Latest practice</Label>
          {(() => {
            const latest = d.history[0]!;
            const linked = latest.retry_of ? d.history.find((h) => h.attempt_id === latest.retry_of) : d.history.find((h) => h.retry_of === latest.attempt_id);
            const first = latest.retry_of ? linked : latest;
            const retry = latest.retry_of ? latest : linked;
            return (
              <>
                <Body style={{ fontWeight: '700' }}>{latest.app_title}</Body>
                <Row style={{ justifyContent: 'space-around', paddingVertical: spacing.sm }}>
                  <View style={{ alignItems: 'center' }}>
                    <Label>First try</Label>
                    <Text style={styles.big}>{first?.displayed_total ?? '—'}/{first?.total_maximum ?? 9}</Text>
                  </View>
                  {retry ? (
                    <>
                      <Text style={{ color: colors.primary, fontSize: 24 }}>→</Text>
                      <View style={{ alignItems: 'center' }}>
                        <Label>Retry</Label>
                        <Text style={[styles.big, { color: colors.primary }]}>{retry.displayed_total ?? '—'}/{retry.total_maximum}</Text>
                      </View>
                    </>
                  ) : null}
                </Row>
                {retry?.is_guided_retry ? <Label>Guided retry · mastery still developing</Label> : null}
                <Pressable onPress={() => router.push(`/session/${latest.session_id}/comparison`)} accessibilityRole="button" style={styles.link}>
                  <Text style={styles.linkText}>View comparison</Text>
                </Pressable>
              </>
            );
          })()}
        </Card>
      ) : null}

      {d ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>Skills you’re building</Body>
          {d.skills.map((s) => (
            <Row key={s.framework_id} style={styles.skillRow}>
              <View style={{ flex: 1 }}>
                <Body>{s.app_title}</Body>
                {s.next_due_at && s.state !== 'new' ? <Label>Next review {localDateTime(s.next_due_at)}</Label> : null}
              </View>
              <Pill tone={s.state === 'ready' ? 'success' : s.state === 'review_due' ? 'accent' : s.state === 'developing' ? 'lavender' : 'muted'}>{STATE_LABEL[s.state]}</Pill>
            </Row>
          ))}
          <Label>Scores are coaching estimates from your confirmed words, not predictions about people.</Label>
        </Card>
      ) : null}

      {d && d.due_reviews.length > 0 ? (
        <Card tone="lavender">
          <Body style={{ fontWeight: '700' }}>Reviews due</Body>
          {d.due_reviews.map((r) => (
            <Row key={r.framework_id} style={{ justifyContent: 'space-between' }}>
              <Body>{r.app_title}</Body>
              <Label>{localDateTime(r.due_at)}</Label>
            </Row>
          ))}
          <Label>Today’s prompt picks the most overdue review first.</Label>
        </Card>
      ) : null}

      <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Daily reminder settings">
        <Card>
          <Row style={{ justifyContent: 'space-between' }}>
            <View>
              <Body style={{ fontWeight: '600' }}>Your daily nudge</Body>
              <Label>{prefs.data?.reminder_enabled ? reminderLabel(prefs.data.reminder_time) : 'Off'}</Label>
            </View>
            <Text style={{ color: colors.muted }}>›</Text>
          </Row>
        </Card>
      </Pressable>

      {d && d.history.length > 0 ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>History</Body>
          {d.history.map((h) => (
            <Pressable key={h.attempt_id} onPress={() => (h.evaluation_id ? router.push(`/attempt/${h.attempt_id}/feedback`) : undefined)} accessibilityRole="button" style={styles.historyRow}>
              <View style={{ flex: 1 }}>
                <Body>{h.app_title}</Body>
                <Label>
                  {h.local_day}
                  {h.is_guided_retry ? ' · guided retry' : ''}
                </Label>
              </View>
              <Text style={styles.score}>{h.displayed_total === null ? '—' : `${h.displayed_total}/${h.total_maximum}`}</Text>
            </Pressable>
          ))}
          <Label>Deleted practices no longer appear here.</Label>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { fontSize: 22, fontWeight: '800', color: colors.ink },
  big: { fontSize: 36, fontWeight: '800', color: colors.ink },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { color: colors.primary, fontWeight: '600', fontSize: 16 },
  skillRow: { justifyContent: 'space-between', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  historyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border },
  score: { fontSize: 18, fontWeight: '700', color: colors.ink },
});
