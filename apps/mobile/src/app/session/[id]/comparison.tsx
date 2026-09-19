import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Button, Card, ErrorBox, Eyebrow, Heading, Label, Loading, Pill, Row, Screen } from '../../../components/ui';
import { api } from '../../../lib/api';
import { localDateTime } from '../../../lib/format';
import { colors, spacing } from '../../../lib/theme';

export default function ComparisonScreen() {
  const { id: sessionId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const cmp = useQuery({ queryKey: ['comparison', sessionId], queryFn: () => api.comparison(sessionId!), enabled: !!sessionId });
  const c = cmp.data;

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.replace('/(tabs)/progress')} accessibilityRole="button" accessibilityLabel="Back to Progress" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        <Eyebrow>Comparison</Eyebrow>
        <View style={{ width: 44 }} />
      </Row>
      <Heading>First try and retry, side by side.</Heading>
      {cmp.isPending ? <Loading label="Loading comparison" /> : null}
      {cmp.isError ? <ErrorBox message="Couldn’t load the comparison." action={() => cmp.refetch()} actionTitle="Try again" /> : null}
      {c ? (
        <>
          <Card>
            <Label>
              {c.app_title} · rubric {c.rubric_version}
            </Label>
            {c.state === 'ready' && c.first && c.retry ? (
              <>
                <Row style={{ justifyContent: 'space-around', paddingVertical: spacing.sm }}>
                  <View style={{ alignItems: 'center' }}>
                    <Label>First try</Label>
                    <Text style={styles.big}>{c.first.displayed_total ?? '—'}/{c.first.total_maximum}</Text>
                  </View>
                  <Text style={{ color: colors.primary, fontSize: 24 }}>→</Text>
                  <View style={{ alignItems: 'center' }}>
                    <Label>Retry</Label>
                    <Text style={[styles.big, { color: colors.primary }]}>{c.retry.displayed_total ?? '—'}/{c.retry.total_maximum}</Text>
                  </View>
                </Row>
                <Pill tone={c.retry.guided ? 'muted' : 'success'}>{c.mastery_note}</Pill>
                <View style={{ gap: spacing.xs }}>
                  {c.per_criterion.map((p) => (
                    <Row key={p.criterion_id} style={{ justifyContent: 'space-between' }}>
                      <Body style={{ flex: 1 }}>{p.label}</Body>
                      <Label>
                        {p.before ?? '—'} → {p.after ?? '—'}
                        {p.delta !== null && p.delta !== 0 ? ` (${p.delta > 0 ? '+' : ''}${p.delta})` : ''}
                      </Label>
                    </Row>
                  ))}
                </View>
              </>
            ) : c.state === 'retry_unavailable' ? (
              <Body>No retry yet for this practice. A guided retry can improve the display but never completes mastery on its own.</Body>
            ) : c.state === 'stale_revision' ? (
              <Body>The transcript changed after this comparison; the results are no longer comparable.</Body>
            ) : (
              <Body>No comparable result yet. Both attempts need valid feedback on the same rubric version.</Body>
            )}
          </Card>
          <Card tone="lavender">
            <Body style={{ fontWeight: '600' }}>Next review</Body>
            <Body>{c.next_review_at ? localDateTime(c.next_review_at) : 'Two independent, qualifying attempts on different prompts at least a day apart make this skill Ready for spaced review.'}</Body>
          </Card>
          {c.retry?.evaluation_id ? <Button title="See retry feedback" variant="secondary" onPress={() => router.push(`/attempt/${c.retry!.attempt_id}/feedback`)} /> : null}
          <Button title="Back to Today" variant="ghost" onPress={() => router.replace('/(tabs)/today')} />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  big: { fontSize: 40, fontWeight: '800', color: colors.ink },
});
