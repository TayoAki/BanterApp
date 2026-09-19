import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Bubble } from '../../components/Bubble';
import { Player } from '../../components/Player';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Loading, Pill, Row, Screen } from '../../components/ui';
import { api } from '../../lib/api';
import { pollJob } from '../../lib/jobs';
import { stableClientKey } from '../../lib/keys';
import { track } from '../../lib/telemetry';
import { colors, fontSizes, radius, spacing } from '../../lib/theme';

export default function RewriteScreen() {
  const { id: rewriteId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const rewrite = useQuery({
    queryKey: ['rewrite', rewriteId],
    queryFn: () => api.rewrite(rewriteId!),
    enabled: !!rewriteId,
    refetchInterval: (q) => (q.state.data?.status === 'validating' ? 2000 : false),
  });
  const r = rewrite.data;
  const evaluation = useQuery({ queryKey: ['evaluation', r?.evaluation_id], queryFn: () => api.evaluation(r!.evaluation_id), enabled: !!r?.evaluation_id });
  const attempt = useQuery({ queryKey: ['attempt', evaluation.data?.attempt_id], queryFn: () => api.attempt(evaluation.data!.attempt_id), enabled: !!evaluation.data?.attempt_id });
  const playback = useQuery({
    queryKey: ['playback', r?.speech_asset_id],
    queryFn: () => api.playback(r!.speech_asset_id!),
    enabled: !!r?.speech_asset_id,
    staleTime: 4 * 60_000,
  });
  const [speechError, setSpeechError] = useState<string | null>(null);
  const waitedRef = useRef(false);

  const speech = useMutation({
    mutationFn: async () => {
      setSpeechError(null);
      const key = await stableClientKey(`speech:${rewriteId}:${new Date().toISOString().slice(0, 10)}`);
      const res = await api.requestSpeech(rewriteId!, { client_key: key });
      if (res.state === 'ready') return;
      if (res.job) {
        const outcome = await pollJob(res.job.job_id, { maxWaitMs: 60_000 });
        if (outcome.kind === 'failed' || outcome.kind === 'canceled') throw new Error('Audio is unavailable right now.');
      }
    },
    onSuccess: () => rewrite.refetch(),
    onError: () => setSpeechError('Audio is unavailable right now.'),
  });

  useEffect(() => {
    if (r?.status === 'ready' && r.speech_state === 'none' && !waitedRef.current) {
      // Generate playback once when the rewrite becomes readable; the text stays usable without it.
      waitedRef.current = true;
      speech.mutate();
    }
  }, [r?.status, r?.speech_state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rewrite.isPending || !r) {
    return (
      <Screen>
        <Loading label="Loading rewrite" />
      </Screen>
    );
  }
  const sessionId = attempt.data?.session_id;
  const parentAttemptId = evaluation.data?.attempt_id;
  const canRetry = !!sessionId && !!parentAttemptId && attempt.data?.retry_of === null;

  return (
    <Screen
      footer={
        r.status === 'ready' && canRetry ? (
          <Button title="Try it in your own words" onPress={() => router.push(`/practice/${sessionId}/record?retry_of=${parentAttemptId}`)} accessibilityHint="Records a guided retry linked to your first attempt" />
        ) : undefined
      }>
      <Row style={{ justifyContent: 'space-between' }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        <Eyebrow>Suggested rewrite</Eyebrow>
        <View style={{ width: 44 }} />
      </Row>
      <Heading style={{ textAlign: 'center' }}>Still your story. A little more spark.</Heading>

      {r.status === 'validating' ? (
        <Card>
          <Loading label="Writing and checking a rewrite" />
          <Label>We check that no facts were added, then re-score it with the same criteria.</Label>
        </Card>
      ) : null}

      {r.status === 'needs_detail' ? (
        <Card tone="lavender">
          <Body style={{ fontWeight: '700' }}>One more detail would help</Body>
          <Body>{r.question_for_user ?? 'What is one true detail you could add?'}</Body>
          <Label>Rather than invent something, we’d like a real detail from you. Record again with it, or keep your original feedback.</Label>
          {sessionId ? <Button title="Record again with that detail" variant="secondary" onPress={() => router.push(`/practice/${sessionId}/record?retry_of=${parentAttemptId}`)} /> : null}
        </Card>
      ) : null}

      {r.status === 'unavailable' || r.status === 'rejected' ? (
        <Card>
          <Body>A rewrite isn’t available for this version. Your feedback is still saved.</Body>
          <Button title="Back to feedback" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : null}

      {r.status === 'ready' && r.rewrite_text ? (
        <>
          <Card>
            <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <View style={{ flex: 1, gap: spacing.sm }}>
                <Pill tone={r.improvement_label === 'stronger_version' ? 'success' : 'lavender'}>{r.improvement_label === 'stronger_version' ? 'Stronger version' : 'Another way to say it'}</Pill>
                <Text style={styles.rewrite} selectable>
                  {r.rewrite_text}
                </Text>
              </View>
              <Bubble size={44} />
            </Row>
            {r.new_hypothetical ? <Label>Fictional addition, declared: “{r.new_hypothetical}”</Label> : null}
            <Player
              source={playback.data ? { uri: playback.data.url } : null}
              aiGenerated
              label="the suggested rewrite"
              disabled={!playback.data}
              onPlay={() => track('playback_started', { kind: 'rewrite_tts' })}
              errorText={speechError}
            />
            {r.speech_state === 'queued' || speech.isPending ? <Label>Preparing audio…</Label> : null}
            {(r.speech_state === 'failed' || r.speech_state === 'expired' || speechError) && !speech.isPending ? (
              <Button title="Listen" variant="secondary" onPress={() => speech.mutate()} accessibilityHint="Generates the AI voice for this exact text" />
            ) : null}
            <Label>Audio matches this exact text. AI-generated voice.</Label>
          </Card>
          <Card tone="lavender">
            <Body style={{ fontWeight: '700' }}>💡 What changed</Body>
            {r.changes.length === 0 ? <Body>Kept your meaning; phrasing adjusted.</Body> : null}
            {r.changes.map((c) => (
              <View key={c.criterion_id}>
                <Label style={{ color: colors.ink, fontWeight: '600' }}>{c.label}</Label>
                <Body>{c.description}</Body>
              </View>
            ))}
          </Card>
          <Label style={{ textAlign: 'center' }}>You don’t need to memorize it.</Label>
          {!canRetry && attempt.data ? <Label style={{ textAlign: 'center' }}>The included guided retry for this session is used.</Label> : null}
          <Button title="Keep practicing later" variant="ghost" onPress={() => router.replace('/(tabs)/today')} />
        </>
      ) : null}
      {rewrite.isError ? <ErrorBox message="Couldn’t load the rewrite." action={() => rewrite.refetch()} actionTitle="Try again" /> : null}
      <Gap />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  rewrite: { fontSize: 20, lineHeight: 30, color: colors.ink, fontWeight: '500' },
});
void radius;
void fontSizes;
