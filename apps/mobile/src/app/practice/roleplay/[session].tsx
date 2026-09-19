import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, ErrorBox, Eyebrow, Heading, Label, Loading, Pill, Row, Screen } from '../../../components/ui';
import { api, ApiClientError } from '../../../lib/api';
import { pollJob } from '../../../lib/jobs';
import { newClientKey, stableClientKey } from '../../../lib/keys';
import { colors, fontSizes, radius, spacing } from '../../../lib/theme';

/**
 * Optional three-exchange fictional conversation. Each learner turn is an
 * attempt whose words are confirmed before the partner replies; spoken turns
 * arrive via the recording flow with `roleplay=1`, typed turns are entered
 * here. The server enforces the exchange limit and evaluates once at the end.
 */
export default function RoleplayScreen() {
  const { session: sessionId, attempt: confirmedAttemptId, revision } = useLocalSearchParams<{ session: string; attempt?: string; revision?: string }>();
  const router = useRouter();
  const state = useQuery({ queryKey: ['roleplay', sessionId], queryFn: () => api.roleplay(sessionId!), enabled: !!sessionId, refetchInterval: (q) => (q.state.data?.exchanges.some((e) => e.partner_reply === null) ? 2000 : false) });
  const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId!), enabled: !!sessionId });
  const [typed, setTyped] = useState('');
  const s = state.data;
  const nextExchange = (s?.exchanges.length ?? 0) + 1;

  const submitTurn = useMutation({
    mutationFn: async (input: { attemptId: string; revision: number } | { text: string }) => {
      let attemptId: string;
      let rev: number;
      if ('text' in input) {
        const key = await stableClientKey(`attempt:${sessionId}:rp:${nextExchange}:typed`);
        const attempt = await api.createAttempt(sessionId!, { client_key: key, ordinal: nextExchange, retry_of: null, input_mode: 'typed' });
        const confirmed = attempt.current_revision >= 1 ? attempt : await api.confirmTranscript(attempt.attempt_id, { client_key: newClientKey('confirm'), expected_revision: 0, confirmed_text: input.text.trim() });
        attemptId = confirmed.attempt_id;
        rev = confirmed.current_revision;
      } else {
        attemptId = input.attemptId;
        rev = input.revision;
      }
      const { job } = await api.roleplayTurn(sessionId!, { client_key: newClientKey('turn'), attempt_id: attemptId, transcript_revision: rev, expected_exchange: nextExchange });
      await pollJob(job.job_id, { maxWaitMs: 60_000 });
    },
    onSuccess: () => {
      setTyped('');
      void state.refetch();
    },
  });
  const finish = useMutation({
    mutationFn: async () => {
      const { job } = await api.roleplayFinish(sessionId!, { client_key: newClientKey('finish') });
      if (job) await pollJob(job.job_id, { maxWaitMs: 90_000 });
    },
    onSuccess: async () => {
      const latest = await state.refetch();
      const evalId = latest.data?.session_evaluation_id;
      const lastAttempt = latest.data?.exchanges.at(-1)?.attempt_id;
      if (evalId && lastAttempt) router.replace(`/attempt/${lastAttempt}/feedback`);
    },
  });

  if (state.isPending || session.isPending) {
    return (
      <Screen>
        <Loading label="Loading conversation" />
      </Screen>
    );
  }
  if (!s || !session.data) {
    return (
      <Screen>
        <ErrorBox message="Couldn’t load this conversation." action={() => state.refetch()} actionTitle="Try again" />
      </Screen>
    );
  }
  const waiting = s.exchanges.some((e) => e.partner_reply === null);
  const pendingConfirmed = confirmedAttemptId && revision && !s.exchanges.some((e) => e.attempt_id === confirmedAttemptId);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Screen>
        <Eyebrow>Fictional practice</Eyebrow>
        <Heading>A short conversation with {s.partner_name}.</Heading>
        <Card tone="lavender">
          <Label style={{ color: colors.ink, fontWeight: '600' }}>Scenario</Label>
          <Body>{s.scenario}</Body>
          <Label>{s.partner_name} is a fictional adult. They can be playful, neutral, or done talking. Up to three exchanges.</Label>
        </Card>
        {s.exchanges.map((e) => (
          <View key={e.exchange} style={{ gap: spacing.xs }}>
            <View style={[styles.bubble, styles.mine]}>
              <Label style={{ color: colors.surface }}>You · turn {e.exchange}</Label>
              <Text style={[styles.bubbleText, { color: colors.surface }]}>{e.learner_text}</Text>
            </View>
            {e.partner_reply ? (
              <View style={[styles.bubble, styles.theirs]}>
                <Label>{s.partner_name}</Label>
                <Text style={styles.bubbleText}>{e.partner_reply}</Text>
                {e.boundary_signal === 'disengaged' ? <Pill tone="muted">They’re wrapping up</Pill> : null}
              </View>
            ) : (
              <Loading label={`${s.partner_name} is replying`} />
            )}
          </View>
        ))}
        {s.ended ? (
          <Card>
            <Body>{s.session_evaluation_id ? 'This conversation was assessed.' : 'The conversation has ended.'}</Body>
            {s.session_evaluation_id ? (
              <Button title="See feedback" onPress={() => router.replace(`/attempt/${s.exchanges.at(-1)!.attempt_id}/feedback`)} />
            ) : (
              <Button title="Get feedback on the conversation" onPress={() => finish.mutate()} loading={finish.isPending} />
            )}
          </Card>
        ) : (
          <Card>
            <Row style={{ justifyContent: 'space-between' }}>
              <Body style={{ fontWeight: '600' }}>Your turn {nextExchange} of 3</Body>
              <Label>{s.exchanges_remaining} left</Label>
            </Row>
            {pendingConfirmed ? (
              <Button title="Send my confirmed words" onPress={() => submitTurn.mutate({ attemptId: confirmedAttemptId!, revision: Number(revision) })} loading={submitTurn.isPending} disabled={waiting} />
            ) : null}
            <Button title="Speak my turn" variant="secondary" onPress={() => router.push(`/practice/${sessionId}/record`)} disabled={waiting || submitTurn.isPending} />
            <Label>Or type it:</Label>
            <TextInput value={typed} onChangeText={setTyped} multiline style={styles.input} placeholder="Type what you’d say…" accessibilityLabel="Typed turn" editable={!waiting && !submitTurn.isPending} />
            <Button title="Send typed turn" onPress={() => submitTurn.mutate({ text: typed })} disabled={typed.trim().length === 0 || waiting} loading={submitTurn.isPending} />
            {s.exchanges.length > 0 && !waiting ? <Button title="Finish and get feedback" variant="ghost" onPress={() => finish.mutate()} loading={finish.isPending} /> : null}
            {submitTurn.isError ? <ErrorBox message={submitTurn.error instanceof ApiClientError ? submitTurn.error.message : 'Couldn’t send that turn.'} /> : null}
            {finish.isError ? <ErrorBox message="Couldn’t finish the conversation yet." action={() => finish.mutate()} actionTitle="Try again" /> : null}
          </Card>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.card, padding: spacing.md, gap: 4, maxWidth: '92%' },
  mine: { backgroundColor: colors.primary, alignSelf: 'flex-end' },
  theirs: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border },
  bubbleText: { fontSize: fontSizes.body, lineHeight: 24, color: colors.ink },
  input: { minHeight: 80, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, padding: spacing.md, fontSize: fontSizes.body, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' },
});
