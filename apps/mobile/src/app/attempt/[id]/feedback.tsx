import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { EvaluationDto } from '@marshmemos/contracts/api';
import { Bubble } from '../../../components/Bubble';
import { CriterionRow } from '../../../components/CriterionRow';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Loading, Pill, Row, Screen } from '../../../components/ui';
import { api } from '../../../lib/api';
import { pollJob } from '../../../lib/jobs';
import { stableClientKey } from '../../../lib/keys';
import { queryClient } from '../../../lib/query';
import { colors, fontSizes, radius, spacing } from '../../../lib/theme';

const REASONS = [
  ['score_seems_wrong', 'The score seems wrong'],
  ['evidence_misquoted', 'The evidence is misquoted'],
  ['rewrite_changed_facts', 'The rewrite changed my facts'],
  ['inappropriate_content', 'Something inappropriate'],
  ['other', 'Something else'],
] as const;

function headingFor(e: EvaluationDto): string {
  switch (e.status) {
    case 'scored':
      return e.totals.displayed_total !== null && e.totals.displayed_total >= 6 ? 'A strong start.' : 'Here’s what landed.';
    case 'uncertain':
      return 'We need a little more context to assess this.';
    case 'needs_revision':
      return 'Let’s revise this one.';
    case 'insufficient_input':
      return 'Not enough to assess yet.';
  }
}

export default function FeedbackScreen() {
  const { id: attemptId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const attempt = useQuery({ queryKey: ['attempt', attemptId], queryFn: () => api.attempt(attemptId!), enabled: !!attemptId });
  const evaluationId = attempt.data?.evaluation_id ?? null;
  const evaluation = useQuery({ queryKey: ['evaluation', evaluationId], queryFn: () => api.evaluation(evaluationId!), enabled: !!evaluationId });
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>('score_seems_wrong');
  const [share, setShare] = useState(false);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    const a = attempt.data;
    if (!a || a.stage !== 'evaluating' || !a.evaluation_job_id) return;
    const controller = new AbortController();
    void pollJob(a.evaluation_job_id, { signal: controller.signal }).then(() => attempt.refetch());
    return () => controller.abort();
  }, [attempt.data?.stage, attempt.data?.evaluation_job_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rewrite = useMutation({
    mutationFn: async () => {
      const key = await stableClientKey(`rewrite:${evaluationId}`);
      return api.requestRewrite(evaluationId!, { client_key: key });
    },
    onSuccess: (r) => router.push(`/rewrite/${r.rewrite.rewrite_id}`),
  });
  const report = useMutation({
    mutationFn: () => api.report({ evaluation_id: evaluationId!, reason, share_evidence: share }),
    onSuccess: () => {
      setReported(true);
      setReporting(false);
    },
  });

  const a = attempt.data;
  const e = evaluation.data;

  if (attempt.isPending || (a && a.stage === 'evaluating') || (evaluationId && evaluation.isPending)) {
    return (
      <Screen>
        <Eyebrow>Feedback</Eyebrow>
        <Loading label="Evaluating your confirmed words" />
        <Label>Your words are saved. This usually takes under a minute.</Label>
      </Screen>
    );
  }
  if (!a || !e) {
    return (
      <Screen>
        <ErrorBox message="Your words are saved. Feedback couldn’t finish yet." action={() => router.replace(`/attempt/${attemptId}/transcript`)} actionTitle="Review transcript" />
        {a?.recoverable_error ? <Label>{a.recoverable_error.message}</Label> : null}
        <Button title="Back to Today" variant="ghost" onPress={() => router.replace('/(tabs)/today')} />
      </Screen>
    );
  }

  const t = e.totals;
  const canRewrite = e.status === 'scored' || e.status === 'uncertain';
  const isRetry = a.retry_of !== null;

  return (
    <Screen>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.replace('/(tabs)/today')} accessibilityRole="button" accessibilityLabel="Back to Today" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        <Eyebrow>Framework {e.framework_number}</Eyebrow>
        <View style={{ width: 44 }} />
      </Row>
      <Heading style={{ textAlign: 'center' }}>{headingFor(e)}</Heading>

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <View>
            <Text style={styles.score} accessibilityLabel={t.displayed_total === null ? 'No total shown' : `${t.displayed_total} out of ${t.total_maximum}`}>
              {t.displayed_total === null ? '—' : `${t.displayed_total}/${t.total_maximum}`}
            </Text>
            <Body style={{ fontWeight: '600' }}>Practice fit · Framework {e.framework_number}</Body>
          </View>
          <Bubble size={56} />
        </Row>
        <Pill>Based on your confirmed words</Pill>
        {t.displayed_total !== null ? (
          <View style={{ gap: 2 }}>
            <Label>Source criteria: {t.framework_subtotal}/{t.framework_maximum}</Label>
            {t.exercise_maximum > 0 ? <Label>Exercise target: {t.exercise_subtotal}/{t.exercise_maximum}</Label> : null}
            {t.exercise_maximum > 0 ? <Label>The exercise target is an app practice condition; missing it never lowers your source-framework rating.</Label> : null}
          </View>
        ) : (
          <Label>
            {t.withheld_reason === 'low_confidence'
              ? 'We’re not confident enough to show a total for this one.'
              : t.withheld_reason === 'boundary_not_clear'
                ? 'No total is shown while a boundary issue needs revision.'
                : 'No total is shown for this result.'}
          </Label>
        )}
        {isRetry ? <Pill tone="muted">Guided retry · mastery still developing</Pill> : null}
        {e.source_copy_flag ? (
          <Card tone="lavender" style={{ padding: spacing.md }}>
            <Label style={{ color: colors.ink, fontWeight: '600' }}>Looks close to source example {e.source_copy_flag.example_id}</Label>
            <Label>{e.source_copy_flag.note}</Label>
          </Card>
        ) : null}
      </Card>

      {e.status === 'uncertain' ? (
        <Card tone="lavender">
          <Body style={{ fontWeight: '600' }}>One question</Body>
          <Body>{e.priority_improvement}</Body>
          <Label>This doesn’t count toward mastery until it can be assessed clearly.</Label>
        </Card>
      ) : null}

      <Card>
        {e.criteria.map((c) => (
          <CriterionRow key={c.criterion_id} label={c.label} origin={c.origin} score={c.score} evidence={c.evidence_quotes} reason={c.reason} />
        ))}
      </Card>

      {e.strength ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>✦ What went well</Body>
          <View style={styles.quoteBox}>
            <Text style={styles.quote}>“{e.strength.evidence_quote}”</Text>
          </View>
          <Body>{e.strength.explanation}</Body>
        </Card>
      ) : null}

      {e.status !== 'uncertain' ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>One thing to work on</Body>
          <Body>{e.priority_improvement}</Body>
          <Label>{e.retry_instruction}</Label>
        </Card>
      ) : null}

      {canRewrite ? (
        <Button
          title={e.rewrite_id ? 'View suggested rewrite' : 'View suggested rewrite'}
          onPress={() => (e.rewrite_id ? router.push(`/rewrite/${e.rewrite_id}`) : rewrite.mutate())}
          loading={rewrite.isPending}
          accessibilityHint="Opens a fact-preserving rewrite of your words"
        />
      ) : (
        <Card tone="lavender">
          <Body>{e.status === 'needs_revision' ? 'Revise the wording first; the technique never needs pressure or threats. Then record again.' : 'Record a little more so there’s something to assess.'}</Body>
          <Button title="Record again" onPress={() => router.replace(`/practice/${a.session_id}/record`)} />
        </Card>
      )}
      {rewrite.isError ? <ErrorBox message="Couldn’t start the rewrite right now. Your feedback is saved." action={() => rewrite.mutate()} actionTitle="Try again" /> : null}
      <Button title="View framework" variant="ghost" onPress={() => router.push('/(tabs)/learn')} />
      {isRetry ? <Button title="See comparison" variant="secondary" onPress={() => router.push(`/session/${a.session_id}/comparison`)} /> : null}

      <Gap />
      {reported ? (
        <Label style={{ textAlign: 'center' }}>Thanks. Your report was received{share ? ' with the transcript you chose to share' : ' without your transcript'}.</Label>
      ) : reporting ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>This feedback seems wrong</Body>
          {REASONS.map(([id, label]) => (
            <Pressable key={id} onPress={() => setReason(id)} accessibilityRole="radio" accessibilityState={{ checked: reason === id }} style={[styles.reason, reason === id && styles.reasonPicked]}>
              <Body>{label}</Body>
            </Pressable>
          ))}
          <Row style={{ justifyContent: 'space-between' }}>
            <Body style={{ flex: 1 }}>Share my confirmed transcript and this result with the review team</Body>
            <Switch value={share} onValueChange={setShare} accessibilityLabel="Share transcript evidence" />
          </Row>
          <Label>Without consent, only IDs are sent; your words stay private.</Label>
          <Button title="Send report" onPress={() => report.mutate()} loading={report.isPending} />
          <Button title="Cancel" variant="ghost" onPress={() => setReporting(false)} />
          {report.isError ? <ErrorBox message="Couldn’t send the report." /> : null}
        </Card>
      ) : (
        <Button title="This feedback seems wrong" variant="ghost" onPress={() => setReporting(true)} />
      )}
      <Label style={{ textAlign: 'center' }}>Scores are coaching estimates about wording and structure, not vocal delivery or attraction.</Label>
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  score: { fontSize: fontSizes.score, fontWeight: '800', color: colors.ink, lineHeight: 50 },
  quoteBox: { backgroundColor: colors.lavender, borderRadius: radius.button, padding: spacing.md },
  quote: { fontSize: fontSizes.body, lineHeight: 24, color: colors.ink, fontStyle: 'italic' },
  reason: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border },
  reasonPicked: { borderColor: colors.primary, borderWidth: 2 },
});
