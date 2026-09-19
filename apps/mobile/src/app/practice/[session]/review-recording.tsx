import { useMutation } from '@tanstack/react-query';
import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Player } from '../../../components/Player';
import { Body, Button, Card, ErrorBox, Eyebrow, Heading, Label, Screen } from '../../../components/ui';
import { api, ApiClientError } from '../../../lib/api';
import { mmss } from '../../../lib/format';
import { stableClientKey } from '../../../lib/keys';
import { takeFileExists, takeFileSize, useTakes } from '../../../lib/takes';
import { spacing } from '../../../lib/theme';

type UploadStep = 'idle' | 'creating_attempt' | 'requesting_upload' | 'uploading' | 'verifying';

const STEP_LABEL: Record<UploadStep, string> = {
  idle: '',
  creating_attempt: 'Preparing…',
  requesting_upload: 'Preparing upload…',
  uploading: 'Sending your recording…',
  verifying: 'Checking the file…',
};

/**
 * After Stop: duration, Play, Record again, Discard, Use recording. Nothing is
 * uploaded until Use recording. The local file stays until the transcript is
 * confirmed or the learner discards it.
 */
export default function ReviewRecording() {
  const { session: sessionId, take: takeId, retry_of, interrupted, roleplay, exchange } = useLocalSearchParams<{ session: string; take: string; retry_of?: string; interrupted?: string; roleplay?: string; exchange?: string }>();
  const router = useRouter();
  const take = useTakes((s) => s.takes.find((t) => t.id === takeId));
  const update = useTakes((s) => s.update);
  const remove = useTakes((s) => s.remove);
  const [step, setStep] = useState<UploadStep>('idle');
  const fileExists = take ? takeFileExists(take.uri) : false;

  const send = useMutation({
    mutationFn: async () => {
      if (!take) throw new Error('missing take');
      const file = new File(take.uri);
      if (!file.exists) throw new ApiClientError(0, 'file_missing', 'This recording is no longer on this device.', false, null, undefined);
      const bytes = file.size ?? takeFileSize(take.uri) ?? 0;
      setStep('creating_attempt');
      let attemptId = take.attemptId;
      if (!attemptId) {
        const key = await stableClientKey(take.attemptClientKey);
        const attempt = await api.createAttempt(sessionId!, { client_key: key, ordinal: take.ordinal ?? (retry_of ? 2 : 1), retry_of: retry_of ?? null, input_mode: 'voice' });
        attemptId = attempt.attempt_id;
        await update(take.id, { attemptId, state: 'uploading' });
      }
      // Bytes already stored: resume at upload-complete (the server requeues a failed transcription).
      if (take.assetId && (take.state === 'uploaded' || take.state === 'transcribing')) {
        setStep('verifying');
        const done = await api.uploadComplete(attemptId, { client_key: take.uploadClientKey, asset_id: take.assetId });
        await update(take.id, { state: 'transcribing' });
        return done.attempt.attempt_id;
      }
      setStep('requesting_upload');
      const upload = await api.createUpload(attemptId, { client_key: take.uploadClientKey, expected_bytes: bytes, mime: 'audio/mp4', duration_seconds_hint: take.durationMs / 1000 });
      await update(take.id, { assetId: upload.asset_id, bytes });
      setStep('uploading');
      const res = await expoFetch(upload.upload_url, { method: upload.method, headers: { ...upload.headers, 'Content-Type': 'audio/mp4' }, body: file });
      if (!res.ok && res.status !== 409) throw new ApiClientError(res.status, 'upload_failed', 'The upload didn’t finish.', true, null, undefined);
      await update(take.id, { state: 'uploaded' });
      setStep('verifying');
      const done = await api.uploadComplete(attemptId, { client_key: take.uploadClientKey, asset_id: upload.asset_id });
      await update(take.id, { state: 'transcribing' });
      return done.attempt.attempt_id;
    },
    onSuccess: (attemptId) => router.replace(`/attempt/${attemptId}/transcript`),
    onError: () => setStep('idle'),
  });

  const recordParams = [retry_of ? `retry_of=${retry_of}` : null, roleplay ? `roleplay=1&exchange=${exchange ?? '1'}` : null].filter(Boolean).join('&');
  const recordAgain = async () => {
    if (take) await remove(take.id, true);
    router.replace(`/practice/${sessionId}/record${recordParams ? `?${recordParams}` : ''}`);
  };
  const discard = async () => {
    if (take) await remove(take.id, true);
    router.replace('/(tabs)/today');
  };

  const err = send.error instanceof ApiClientError ? send.error : null;
  const errorMessage = err
    ? err.code === 'offline' || err.code === 'timeout' || err.code === 'upload_failed'
      ? 'Your recording is saved on this device. Try sending it again.'
      : err.status === 413 || err.status === 422
        ? err.message
        : err.status === 429
          ? err.message
          : err.code === 'file_missing'
            ? err.message
            : 'Couldn’t send this recording yet. Your take is still saved here.'
    : send.isError
      ? 'Couldn’t send this recording yet. Your take is still saved here.'
      : null;

  return (
    <Screen
      footer={
        take && fileExists ? (
          <Button title={send.isPending ? STEP_LABEL[step] || 'Sending…' : 'Use recording'} onPress={() => send.mutate()} loading={send.isPending} accessibilityHint="Uploads this take privately and starts transcription" />
        ) : undefined
      }>
      <Eyebrow>Your take</Eyebrow>
      <Heading>Here’s what you recorded.</Heading>
      {interrupted ? (
        <Card tone="lavender">
          <Body>Recording stopped. Review this take or record again.</Body>
        </Card>
      ) : null}
      {!take ? (
        <Card>
          <Body>This recording isn’t available anymore.</Body>
          <Button title="Record again" onPress={recordAgain} />
        </Card>
      ) : !fileExists ? (
        <Card>
          <Body>This recording is no longer on this device. Device storage may have cleared it, or it expired after 24 hours.</Body>
          <Button title="Record again" onPress={recordAgain} />
          <Button title="Discard" variant="ghost" onPress={discard} />
        </Card>
      ) : (
        <>
          <Card>
            <Label>Duration {mmss(take.durationMs)}</Label>
            <Player source={{ uri: take.uri }} label="your recording" />
            <Label>Playback stays on this device until you tap Use recording.</Label>
          </Card>
          {errorMessage ? <ErrorBox message={errorMessage} action={err && (err.status === 413 || err.status === 422) ? recordAgain : () => send.mutate()} actionTitle={err && (err.status === 413 || err.status === 422) ? 'Record again' : 'Try sending again'} /> : null}
          {send.isPending ? <Label style={{ textAlign: 'center' }}>{STEP_LABEL[step]}</Label> : null}
          <Button title="Record again" variant="secondary" onPress={recordAgain} disabled={send.isPending} />
          <Button title="Discard" variant="ghost" onPress={discard} disabled={send.isPending} />
          <Label style={{ marginTop: spacing.sm }}>Your recording is transcribed by an AI service and kept for up to 24 hours. You’ll confirm the words before anything is assessed.</Label>
        </>
      )}
    </Screen>
  );
}
