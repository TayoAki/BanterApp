import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { colors, fontSizes, minTouch, radius, spacing } from '../lib/theme';

type Step = 'email' | 'code' | 'done';

export default function Auth() {
  const router = useRouter();
  const { mode, sendCode, verifyCode, signInDevelopment } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devId, setDevId] = useState(Crypto.randomUUID());

  const submitEmail = async () => {
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    try {
      await sendCode(email);
      setStep('code');
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setError(null);
    if (code.trim().length < 6) {
      setError('Enter the code from your email.');
      return;
    }
    setBusy(true);
    try {
      await verifyCode(email, code);
      setStep('done');
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Gap size={spacing.xl} />
      <Eyebrow>Sign in</Eyebrow>
      <Heading>Save your voice practice.</Heading>
      <Body muted>We’ll email you a one-time code. No password.</Body>
      {mode === 'development' ? (
        <Card tone="lavender">
          <Label style={{ color: colors.ink, fontWeight: '600' }}>Development build</Label>
          <Body>No Supabase project is configured, so this build signs in with a local development identity against the fixture server.</Body>
          <TextInput value={devId} onChangeText={setDevId} style={styles.input} autoCapitalize="none" accessibilityLabel="Development user id" />
          <Button title="Continue (development)" onPress={() => signInDevelopment(devId.trim()).catch((e) => setError(String(e)))} />
        </Card>
      ) : null}
      {step === 'email' ? (
        <Card>
          <Label>Email</Label>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            style={styles.input}
            accessibilityLabel="Email address"
            editable={mode === 'supabase'}
          />
          <Button title="Send code" onPress={submitEmail} loading={busy} disabled={mode !== 'supabase'} />
        </Card>
      ) : null}
      {step === 'code' ? (
        <Card>
          <Label>Code sent to {email.trim()}</Label>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="123456"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            style={styles.input}
            accessibilityLabel="One-time code"
          />
          <Button title="Continue" onPress={submitCode} loading={busy} />
          <Button title="Send a new code" variant="ghost" onPress={submitEmail} disabled={busy} />
          <Button title="Use a different email" variant="ghost" onPress={() => setStep('email')} disabled={busy} />
        </Card>
      ) : null}
      {step === 'done' ? <Body>Signed in. Taking you to today’s practice…</Body> : null}
      {error ? <ErrorBox message={error} /> : null}
      <Button title="Cancel" variant="ghost" onPress={() => router.replace('/welcome')} />
    </Screen>
  );
}

function friendlyAuthError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/rate|too many/i.test(msg)) return 'Too many attempts. Wait a moment before trying again.';
  if (/expired|invalid|otp/i.test(msg)) return 'That code is invalid or expired. Request a new one.';
  if (/not configured/i.test(msg)) return msg;
  return 'Sign-in didn’t work. Check your connection and try again.';
}

const styles = StyleSheet.create({
  input: { minHeight: minTouch, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: spacing.md, fontSize: fontSizes.body, color: colors.ink, backgroundColor: colors.surface },
});
