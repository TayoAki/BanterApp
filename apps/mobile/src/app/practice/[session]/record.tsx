import { useMutation, useQuery } from '@tanstack/react-query';
import { AudioModule, AudioQuality, IOSOutputFormat, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions, type RecordingStatus } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { File } from 'expo-file-system';
import { RECORDING_HARD_LIMIT_SECONDS } from '@marshmemos/contracts/api';
import { Waveform } from '../../../components/Waveform';
import { Body, Button, Card, ErrorBox, Eyebrow, Heading, Label, Loading, Screen } from '../../../components/ui';
import { api } from '../../../lib/api';
import { mmss } from '../../../lib/format';
import { newClientKey, stableClientKey } from '../../../lib/keys';
import { persistRecording, TAKE_TTL_MS, useTakes } from '../../../lib/takes';
import { track } from '../../../lib/telemetry';
import { colors, fontSizes, minTouch, spacing } from '../../../lib/theme';

/** Mono AAC in an MP4 container on both platforms; matches the server's accepted media. */
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  directory: 'document',
  android: { ...RecordingPresets.HIGH_QUALITY.android, outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { ...RecordingPresets.HIGH_QUALITY.ios, outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.HIGH },
};

type Phase = 'permission' | 'denied' | 'recording' | 'stopping' | 'stopped' | 'error';

export default function RecordScreen() {
  const { session: sessionId, retry_of, roleplay, exchange } = useLocalSearchParams<{ session: string; retry_of?: string; roleplay?: string; exchange?: string }>();
  const exchangeNo = roleplay ? Math.max(1, Number.parseInt(exchange ?? '1', 10) || 1) : null;
  const router = useRouter();
  const session = useQuery({ queryKey: ['session', sessionId], queryFn: () => api.session(sessionId!), enabled: !!sessionId });
  const addTake = useTakes((s) => s.add);
  const [phase, setPhase] = useState<Phase>('permission');
  const [notice, setNotice] = useState<string | null>(null);
  const samplesRef = useRef<number[]>([]);
  const [samples, setSamples] = useState<number[]>([]);
  const stoppingRef = useRef(false);
  const finishedRef = useRef(false);
  const lastDurationRef = useRef(0);
  const finishRef = useRef<(reason: 'user' | 'limit' | 'background' | 'interrupted', uriFromNative?: string | null) => Promise<void>>(async () => undefined);
  const nativeFinishedRef = useRef<string | null>(null);

  // The native recorder reports completion (including the 90-second automatic stop) here.
  const onStatus = useCallback((status: RecordingStatus) => {
    if (status.hasError) {
      setNotice('Recording stopped. Review this take or record again.');
      setPhase('error');
      return;
    }
    if (status.mediaServicesDidReset) setNotice('Recording stopped. Review this take or record again.');
    if (status.isFinished) {
      nativeFinishedRef.current = status.url;
      void finishRef.current('limit', status.url);
    }
  }, []);
  const recorder = useAudioRecorder(RECORDING_OPTIONS, onStatus);
  const state = useAudioRecorderState(recorder, 100);

  // Collect real metering samples for the waveform and remember the last non-zero duration
  // (native resets the counter to 0 once it stops).
  useEffect(() => {
    if (state.isRecording && typeof state.metering === 'number') {
      samplesRef.current = [...samplesRef.current.slice(-63), state.metering];
      setSamples(samplesRef.current);
    }
    if (state.durationMillis > 0) lastDurationRef.current = state.durationMillis;
  }, [state.metering, state.isRecording, state.durationMillis]);

  const finish = useCallback(
    async (reason: 'user' | 'limit' | 'background' | 'interrupted', uriFromNative?: string | null) => {
      if (stoppingRef.current || finishedRef.current) return;
      stoppingRef.current = true;
      setPhase('stopping');
      let uri: string | null = uriFromNative ?? null;
      try {
        if (!uriFromNative) await recorder.stop();
      } catch {
        // stop may throw if the recorder already finished natively
      }
      try {
        uri = uri ?? recorder.uri;
      } catch {
        uri = uri ?? nativeFinishedRef.current;
      }
      const durationMs = lastDurationRef.current;
      finishedRef.current = true;
      if (!uri) {
        setNotice('We couldn’t save that take. Try another one.');
        setPhase('error');
        stoppingRef.current = false;
        return;
      }
      try {
        const id = Crypto.randomUUID();
        const stored = persistRecording(uri, id);
        await addTake({
          id,
          sessionId: sessionId!,
          attemptId: null,
          uri: stored,
          durationMs,
          bytes: null,
          createdAt: Date.now(),
          expiresAt: Date.now() + TAKE_TTL_MS,
          state: 'recorded',
          assetId: null,
          uploadClientKey: newClientKey('upload'),
          attemptClientKey: exchangeNo ? `attempt:${sessionId}:rp:${exchangeNo}` : retry_of ? `attempt:${sessionId}:retry:${retry_of}` : `attempt:${sessionId}:1`,
          ordinal: exchangeNo ?? (retry_of ? 2 : 1),
          roleplay: Boolean(exchangeNo),
        });
        track('recording_finished', { reason, duration_ms: durationMs });
        if (reason !== 'user' && reason !== 'limit') setNotice('Recording stopped. Review this take or record again.');
        setPhase('stopped');
        const params = [`take=${id}`, retry_of ? `retry_of=${retry_of}` : null, exchangeNo ? `roleplay=1&exchange=${exchangeNo}` : null, reason !== 'user' && reason !== 'limit' ? 'interrupted=1' : null].filter(Boolean).join('&');
        router.replace(`/practice/${sessionId}/review-recording?${params}`);
      } catch {
        setNotice('We couldn’t keep that recording (low storage or an invalid file). Try another take.');
        setPhase('error');
      } finally {
        stoppingRef.current = false;
      }
    },
    [recorder, addTake, sessionId, retry_of, exchangeNo, router],
  );
  finishRef.current = finish;

  const begin = useCallback(async () => {
    setNotice(null);
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setPhase('denied');
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: false });
      await recorder.prepareToRecordAsync();
      samplesRef.current = [];
      setSamples([]);
      finishedRef.current = false;
      recorder.record({ forDuration: RECORDING_HARD_LIMIT_SECONDS });
      setPhase('recording');
    } catch {
      setNotice('The microphone couldn’t start. Close other audio apps and try again.');
      setPhase('error');
    }
  }, [recorder]);

  // Start right after the learner's tap on the previous screen; ask for permission only now.
  useEffect(() => {
    void begin();
  }, [begin]);

  // Hard limit guard in JS as well; the native forDuration stop reports through onStatus.
  useEffect(() => {
    if (phase !== 'recording') return;
    if (state.durationMillis >= (RECORDING_HARD_LIMIT_SECONDS + 1) * 1000) void finish('limit');
  }, [state.durationMillis, phase, finish]);

  // Backgrounding, screen lock, calls: stop and preserve the take. Never silently resume.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if ((next === 'background' || next === 'inactive') && phase === 'recording') void finish('background');
    });
    return () => sub.remove();
  }, [phase, finish]);

  // Navigation away: the hook releases the native recorder (which stops the
  // microphone); we only restore the audio mode. The released object must not
  // be touched here.
  useEffect(() => {
    return () => {
      setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    };
  }, []);

  const discard = async () => {
    stoppingRef.current = true;
    let uri: string | null = null;
    try {
      if (recorder.isRecording) await recorder.stop();
      uri = recorder.uri;
    } catch {
      // ignore
    }
    finishedRef.current = true;
    if (uri) {
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch {
        // best effort
      }
    }
    router.back();
  };

  const typeInstead = useMutation({
    mutationFn: async () => {
      // Same logical attempt as the voice take would have used; a voice attempt without words continues as typed.
      const key = await stableClientKey(exchangeNo ? `attempt:${sessionId}:rp:${exchangeNo}` : retry_of ? `attempt:${sessionId}:retry:${retry_of}` : `attempt:${sessionId}:1`);
      return api.createAttempt(sessionId!, { client_key: key, ordinal: exchangeNo ?? (retry_of ? 2 : 1), retry_of: retry_of ?? null, input_mode: 'typed' });
    },
    onSuccess: (attempt) => router.replace(`/attempt/${attempt.attempt_id}/transcript`),
  });

  const s = session.data;
  return (
    <Screen scroll={false}>
      <View style={styles.header}>
        <Pressable onPress={discard} accessibilityRole="button" accessibilityLabel="Back, discards the current take" style={styles.back}>
          <Text style={{ fontSize: 22, color: colors.ink }}>‹</Text>
        </Pressable>
        <View style={{ alignItems: 'center' }}>
          <Body style={{ fontWeight: '700' }}>{s ? s.app_title : ' '}</Body>
          <Label>{s ? `Framework ${s.framework_number}` : ''}</Label>
        </View>
        <View style={{ width: 44 }} />
      </View>
      <Heading style={{ textAlign: 'center' }}>Go on. We’re listening.</Heading>
      {session.isPending ? <Loading label="Loading prompt" /> : null}
      {s ? <Body muted style={{ textAlign: 'center' }}>{s.prompt.prompt}</Body> : null}

      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.lg }}>
        {phase === 'denied' ? (
          <Card>
            <Body>Microphone access is off. You can enable it in Settings or type your practice.</Body>
            <Button title="Open settings" variant="secondary" onPress={() => Linking.openSettings()} />
            <Button title="Type instead" onPress={() => typeInstead.mutate()} loading={typeInstead.isPending} />
          </Card>
        ) : null}
        {phase === 'error' ? (
          <Card>
            <ErrorBox message={notice ?? 'Recording stopped.'} />
            <Button title="Record again" onPress={() => void begin()} />
            <Button title="Type instead" variant="secondary" onPress={() => typeInstead.mutate()} loading={typeInstead.isPending} />
          </Card>
        ) : null}
        {phase === 'permission' ? <Loading label="Preparing the microphone" /> : null}
        {phase === 'recording' || phase === 'stopping' ? (
          <>
            <Waveform samples={samples} active={phase === 'recording'} />
            <Text style={styles.timer} accessibilityLiveRegion="polite" accessibilityLabel={`Recording, ${mmss(state.durationMillis)}`}>
              {mmss(state.durationMillis)}
            </Text>
            <Label style={{ textAlign: 'center' }}>60 second target · 90 second limit</Label>
          </>
        ) : null}
      </View>

      {phase === 'recording' || phase === 'stopping' ? (
        <View style={{ alignItems: 'center', gap: spacing.md, paddingBottom: spacing.xl }}>
          <Pressable
            onPress={() => void finish('user')}
            disabled={phase === 'stopping'}
            accessibilityRole="button"
            accessibilityLabel="Finish recording"
            accessibilityHint="Stops the microphone and shows your take"
            style={styles.stop}>
            <View style={styles.stopSquare} />
          </Pressable>
          <Body style={{ fontWeight: '600' }}>Finish recording</Body>
          <View style={styles.recRow}>
            <View style={styles.recDot} />
            <Text style={{ color: colors.error, fontWeight: '600' }}>{phase === 'stopping' ? 'Saving' : 'Recording'}</Text>
          </View>
          <Label>Only records while this screen is open.</Label>
          <Button title="Discard recording" variant="secondary" onPress={discard} style={{ alignSelf: 'center', minWidth: 220 }} />
          {typeInstead.isError ? <ErrorBox message="Couldn’t switch to typing right now." /> : null}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  timer: { fontSize: fontSizes.score, fontWeight: '700', color: colors.ink, textAlign: 'center', fontVariant: ['tabular-nums'] },
  stop: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', minWidth: minTouch, minHeight: minTouch },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.surface },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.error },
});
