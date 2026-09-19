import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput } from 'react-native';
import { CONFIRMED_TEXT_MAX } from '@marshmemos/contracts/api';
import { Player } from '../../../components/Player';
import { Body, Button, Card, ErrorBox, Eyebrow, Heading, Label, Loading, Screen } from '../../../components/ui';
import { api, ApiClientError } from '../../../lib/api';
import { newClientKey, stableClientKey } from '../../../lib/keys';
import { pollJob, type PollOutcome } from '../../../lib/jobs';
import { queryClient } from '../../../lib/query';
import { takeFileExists, useTakes } from '../../../lib/takes';
import { colors, fontSizes, radius, spacing } from '../../../lib/theme';

export default function TranscriptScreen() {
  const { id: attemptId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const attempt = useQuery({ queryKey: ['attempt', attemptId], queryFn: () => api.attempt(attemptId!), enabled: !!attemptId });
  const take = useTakes((s) => s.takes.find((t) => t.attemptId === attemptId));
  const markConfirmed = useTakes((s) => s.update);
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [waitState, setWaitState] = useState<'idle' | 'transcribing' | 'evaluating' | 'still_working'>('idle');
  const [jobError, setJobError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const a = attempt.data;
  const raw = a?.transcript.raw_text ?? '';
  const baseText = a ? (a.transcript.confirmed_text ?? raw) : '';
  const current = text ?? baseText;
  const lowContent = !!a && a.input_mode === 'voice' && a.stage === 'transcript_review' && (a.transcript.provider_meta?.low_content || raw.trim().length === 0);
  const correctionsLeft = a ? Math.max(0, 2 - a.current_revision) : 0;
  const invalidLength = current.trim().length === 0 || [...current].length > CONFIRMED_TEXT_MAX;

  // Poll the transcription job while transcribing.
  useEffect(() => {
    if (!a || a.stage !== 'transcribing' || !a.transcription_job_id) return;
    setWaitState('transcribing');
    const controller = new AbortController();
    abortRef.current = controller;
    void pollJob(a.transcription_job_id, { signal: controller.signal }).then(async (outcome: PollOutcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === 'still_working') setWaitState('still_working');
      else {
        setWaitState('idle');
        if (outcome.kind === 'failed') setJobError('Your recording is saved on this device. Try sending it again.');
        await attempt.refetch();
      }
    });
    return () => controller.abort();
  }, [a?.stage, a?.transcription_job_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume an evaluation already in flight (for example after relaunch).
  useEffect(() => {
    if (!a || a.stage !== 'evaluating' || !a.evaluation_job_id) return;
    setWaitState('evaluating');
    const controller = new AbortController();
    void pollJob(a.evaluation_job_id, { signal: controller.signal }).then(async (outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === 'succeeded') router.replace(`/attempt/${attemptId}/feedback`);
      else if (outcome.kind === 'still_working') setWaitState('still_working');
      else {
        setWaitState('idle');
        setJobError('Your words are saved. Feedback couldn’t finish yet.');
        await attempt.refetch();
      }
    });
    return () => controller.abort();
  }, [a?.stage, a?.evaluation_job_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const getFeedback = useMutation({
    mutationFn: async () => {
      if (!a) throw new Error('no attempt');
      setJobError(null);
      let revision = a.current_revision;
      const changed = current.trim() !== (a.transcript.confirmed_text ?? '').trim();
      if (a.current_revision === 0 || changed) {
        const confirmed = await api.confirmTranscript(a.attempt_id, { client_key: newClientKey('confirm'), expected_revision: a.current_revision, confirmed_text: current.trim() });
        revision = confirmed.current_revision;
        if (take) await markConfirmed(take.id, { state: 'confirmed' });
      }
      const key = await stableClientKey(`evaluate:${a.attempt_id}:${revision}`);
      const { job, evaluation_id } = await api.evaluate(a.attempt_id, { client_key: key, revision });
      if (evaluation_id && job.state === 'succeeded') return 'done' as const;
      setWaitState('evaluating');
      const outcome = await pollJob(job.job_id);
      if (outcome.kind === 'succeeded') return 'done' as const;
      if (outcome.kind === 'still_working') return 'still_working' as const;
      throw new ApiClientError(0, 'evaluation_failed', outcome.kind === 'failed' ? outcome.job.error?.message ?? 'Feedback couldn’t finish yet.' : 'Feedback was canceled.', outcome.kind === 'failed' ? outcome.job.error?.retryable ?? true : false, null, undefined);
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['attempt', attemptId] });
      await queryClient.invalidateQueries({ queryKey: ['today'] });
      if (result === 'done') router.replace(`/attempt/${attemptId}/feedback`);
      else setWaitState('still_working');
    },
    onError: async (e) => {
      setWaitState('idle');
      if (e instanceof ApiClientError && e.status === 409) setJobError('The transcript changed since you loaded it. Review the latest version below.');
      else if (e instanceof ApiClientError && e.status === 429) setJobError(e.message);
      else setJobError('Your words are saved. Feedback couldn’t finish yet.');
      await attempt.refetch();
      setText(null);
    },
  });

  if (attempt.isPending) {
    return (
      <Screen>
        <Loading label="Loading" />
      </Screen>
    );
  }
  if (attempt.isError || !a) {
    return (
      <Screen>
        <ErrorBox message="Couldn’t load this practice." action={() => attempt.refetch()} actionTitle="Try again" />
        <Button title="Back to Today" variant="ghost" onPress={() => router.replace('/(tabs)/today')} />
      </Screen>
    );
  }

  const busy = getFeedback.isPending || waitState === 'transcribing' || waitState === 'evaluating';
  const typed = a.input_mode === 'typed';

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Screen
        footer={
          a.stage !== 'transcribing' && waitState !== 'still_working' ? (
            <Button
              title={waitState === 'evaluating' ? 'Getting your feedback…' : 'Get my feedback'}
              onPress={() => getFeedback.mutate()}
              loading={busy}
              disabled={invalidLength || (a.current_revision >= 2 && current.trim() !== (a.transcript.confirmed_text ?? '').trim())}
              accessibilityHint="Confirms these words and evaluates exactly this text"
            />
          ) : undefined
        }>
        <Eyebrow>{typed ? 'Type your words' : 'Check your words'}</Eyebrow>
        <Heading>{typed ? 'What would you say?' : 'Did we hear you right?'}</Heading>

        {a.stage === 'transcribing' || waitState === 'transcribing' ? (
          <Card>
            <Loading label="Transcribing your recording" />
            <Label>Usually under a minute. Your recording is private.</Label>
          </Card>
        ) : null}

        {waitState === 'still_working' ? (
          <Card tone="lavender">
            <Body>We’re still working—come back shortly. This practice stays in Today as a pending item.</Body>
            <Button title="Back to Today" variant="secondary" onPress={() => router.replace('/(tabs)/today')} />
            <Button title="Check again" variant="ghost" onPress={() => { setWaitState('idle'); void attempt.refetch(); }} />
          </Card>
        ) : null}

        {jobError ? (
          <ErrorBox
            message={jobError}
            action={a.stage === 'uploaded' && take && takeFileExists(take.uri) ? () => router.replace(`/practice/${a.session_id}/review-recording?take=${take.id}`) : a.stage === 'transcript_review' ? () => getFeedback.mutate() : undefined}
            actionTitle={a.stage === 'uploaded' && take ? 'Send it again' : a.stage === 'transcript_review' ? 'Try again' : undefined}
          />
        ) : null}
        {a.stage === 'uploaded' && a.recoverable_error && !(take && takeFileExists(take.uri)) ? (
          <Card>
            <Body>The recording for this practice is no longer on this device, so it can’t be sent again.</Body>
            <Button title="Record again" variant="secondary" onPress={() => router.replace(`/practice/${a.session_id}/record`)} />
          </Card>
        ) : null}

        {take && takeFileExists(take.uri) && !typed ? <Player source={{ uri: take.uri }} label="your original recording" /> : null}

        {lowContent && !editing ? (
          <Card>
            <Body>We couldn’t get a clear transcript. Try another take or type what you said.</Body>
            <Button title="Record again" variant="secondary" onPress={() => router.replace(`/practice/${a.session_id}/record`)} />
            <Button title="Type instead" onPress={() => setEditing(true)} />
          </Card>
        ) : null}

        {a.stage !== 'transcribing' && (!lowContent || editing) ? (
          <Card>
            <Label>{typed ? 'Your words' : 'Your transcript'}</Label>
            <TextInput
              value={current}
              onChangeText={(v) => {
                setText(v);
                setEditing(true);
              }}
              multiline
              editable={!busy && (a.current_revision < 2 || a.transcript.confirmed_text === null)}
              style={styles.input}
              placeholder={typed ? 'Type what you’d say out loud…' : ''}
              accessibilityLabel={typed ? 'Your words' : 'Editable transcript'}
              textAlignVertical="top"
              scrollEnabled={false}
            />
            {!typed && !editing ? <Button title="Edit transcript" variant="ghost" onPress={() => setEditing(true)} /> : null}
            <Label>Your feedback uses the words you confirm.</Label>
            {a.current_revision >= 1 ? <Label>{correctionsLeft > 0 ? `One correction is included after your first confirmation.` : 'The included transcript correction for this practice is used; the text above is what will be assessed.'}</Label> : null}
            {[...current].length > CONFIRMED_TEXT_MAX ? <Label style={{ color: colors.error }}>Keep it under {CONFIRMED_TEXT_MAX} characters.</Label> : null}
          </Card>
        ) : null}

        {!typed && a.stage === 'transcript_review' ? <Button title="Record again" variant="ghost" onPress={() => router.replace(`/practice/${a.session_id}/record`)} disabled={busy} /> : null}
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 140, fontSize: fontSizes.body, lineHeight: 25, color: colors.ink, backgroundColor: colors.surface, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
});
