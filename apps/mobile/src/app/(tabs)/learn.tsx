import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { SkillState } from '@marshmemos/contracts/api';
import { Body, Card, ErrorBox, Eyebrow, Heading, Label, Loading, Pill, Row, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { colors, spacing } from '../../lib/theme';

const STAGE_LABEL = { notice: 'Notice', build: 'Build', transfer: 'Transfer' } as const;
const STATE_LABEL: Record<SkillState, string> = { new: 'New', developing: 'Developing', ready: 'Ready', review_due: 'Review due' };

export default function Learn() {
  const router = useRouter();
  const { status } = useAuth();
  const catalog = useQuery({ queryKey: ['catalog', status], queryFn: api.catalog });
  const progress = useQuery({ queryKey: ['progress'], queryFn: () => api.progress(), enabled: status === 'signed_in' });
  const stateOf = new Map(progress.data?.skills.map((s) => [s.framework_id, s.state]) ?? []);
  const frameworks = catalog.data?.frameworks ?? [];
  const firstNew = frameworks.findIndex((f) => (stateOf.get(f.id) ?? 'new') === 'new');

  return (
    <Screen>
      <Eyebrow>Learn</Eyebrow>
      <Heading>Ten small frameworks.</Heading>
      <Body muted>Each unit has a Notice lesson (spot the move in the original example), a Build prompt, and a Transfer prompt in a new context.</Body>
      {catalog.isPending ? <Loading label="Loading lessons" /> : null}
      {catalog.isError ? <ErrorBox message="Couldn’t load lessons." action={() => catalog.refetch()} actionTitle="Try again" /> : null}
      {frameworks.map((f, index) => {
        const state = stateOf.get(f.id) ?? 'new';
        const isCurrent = index === firstNew;
        return (
          <Card key={f.id} style={isCurrent ? styles.current : undefined}>
            <Row style={{ justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Label>Framework {f.framework_number} · unit {f.order}</Label>
                <Body style={{ fontWeight: '700' }}>{f.app_title}</Body>
              </View>
              <Pill tone={state === 'ready' ? 'success' : state === 'review_due' ? 'accent' : state === 'developing' ? 'lavender' : 'muted'}>{isCurrent && state === 'new' ? 'Current' : STATE_LABEL[state]}</Pill>
            </Row>
            <Body muted>{f.objective}</Body>
            {f.publication_status !== 'published' ? <Pill tone="error">Draft · internal preview</Pill> : null}
            <View style={{ gap: spacing.xs }}>
              {f.lessons.map((l) => (
                <Pressable key={l.id} onPress={() => router.push(`/lesson/${l.id}`)} accessibilityRole="button" accessibilityLabel={`${STAGE_LABEL[l.stage]}: ${l.title}`} style={styles.lessonRow}>
                  <Text style={styles.stage}>{STAGE_LABEL[l.stage]}</Text>
                  <Body style={{ flex: 1 }}>{l.title}</Body>
                  <Text style={{ color: colors.muted }}>›</Text>
                </Pressable>
              ))}
              {f.lessons.length === 0 ? <Label>Lessons for this unit aren’t published yet.</Label> : null}
            </View>
          </Card>
        );
      })}
      {!catalog.isPending && frameworks.length === 0 ? <Body muted>No published lessons yet.</Body> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  current: { borderColor: colors.primary, borderWidth: 1.5 },
  lessonRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, paddingHorizontal: spacing.sm, borderRadius: 10, backgroundColor: colors.canvas },
  stage: { width: 72, fontSize: 12, fontWeight: '700', color: colors.primary, textTransform: 'uppercase', letterSpacing: 1 },
});
