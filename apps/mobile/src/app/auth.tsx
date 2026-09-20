import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Screen } from '../components/ui';
import { useAuth } from '../lib/auth';
import { friendlyAuthError, isPlausibleEmail, PASSWORD_MIN_LENGTH } from '../lib/auth-errors';
import { colors, fontSizes, minTouch, radius, spacing } from '../lib/theme';

type Intent = 'sign_in' | 'create';

export default function Auth() {
  const router = useRouter();
  const { mode, signIn, createAccount, signInDevelopment } = useAuth();
  const [intent, setIntent] = useState<Intent>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devId, setDevId] = useState(Crypto.randomUUID());

  const submit = async () => {
    setError(null);
    if (!isPlausibleEmail(email)) {
      setError('Enter a valid email address.');
      return;
    }
    if (password.length === 0) {
      setError('Enter your password.');
      return;
    }
    if (intent === 'create' && password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      if (intent === 'create') await createAccount(email, password);
      else await signIn(email, password);
      // The root gate routes to onboarding or Today once the session is stored.
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const creating = intent === 'create';

  return (
    <Screen>
      <Gap size={spacing.xl} />
      <Eyebrow>{creating ? 'Create account' : 'Sign in'}</Eyebrow>
      <Heading>Save your voice practice.</Heading>
      <Body muted>Email and a password. Your transcripts, feedback and progress stay with your account until you delete them.</Body>
      {mode === 'fixture' ? (
        <Card tone="lavender">
          <Label style={{ color: colors.ink, fontWeight: '600' }}>Development build</Label>
          <Body>This build targets a fixture server, so it signs in with a local development identity.</Body>
          <TextInput value={devId} onChangeText={setDevId} style={styles.input} autoCapitalize="none" accessibilityLabel="Development user id" />
          <Button title="Continue (development)" onPress={() => signInDevelopment(devId.trim()).catch((e) => setError(String(e)))} />
        </Card>
      ) : null}
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
          editable={mode === 'password' && !busy}
          returnKeyType="next"
        />
        <Label>Password</Label>
        <View style={styles.passwordRow}>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder={creating ? `At least ${PASSWORD_MIN_LENGTH} characters` : 'Your password'}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete={creating ? 'new-password' : 'password'}
            textContentType={creating ? 'newPassword' : 'password'}
            style={[styles.input, { flex: 1 }]}
            accessibilityLabel="Password"
            editable={mode === 'password' && !busy}
            returnKeyType="done"
            onSubmitEditing={() => void submit()}
          />
          <Pressable onPress={() => setShowPassword((v) => !v)} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} style={styles.toggle}>
            <Text style={styles.toggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </Pressable>
        </View>
        <Button title={creating ? 'Create account' : 'Sign in'} onPress={() => void submit()} loading={busy} disabled={mode !== 'password'} />
        <Button
          title={creating ? 'Already have an account? Sign in' : 'New here? Create an account'}
          variant="ghost"
          disabled={busy}
          onPress={() => {
            setError(null);
            setIntent(creating ? 'sign_in' : 'create');
          }}
        />
        {creating ? <Label>marshmemos is for adults (18+). Creating an account confirms you are 18 or older.</Label> : null}
      </Card>
      {error ? <ErrorBox message={error} /> : null}
      <Button title="Cancel" variant="ghost" onPress={() => router.replace('/welcome')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: minTouch, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, paddingHorizontal: spacing.md, fontSize: fontSizes.body, color: colors.ink, backgroundColor: colors.surface },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  toggle: { minHeight: minTouch, minWidth: minTouch, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.sm },
  toggleText: { color: colors.primary, fontWeight: '600' },
});
