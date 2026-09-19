import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Bubble } from '../components/Bubble';
import { Body, Button, Card, Gap, Heading, Label, Screen } from '../components/ui';
import { api } from '../lib/api';
import { brand, colors, spacing } from '../lib/theme';

export default function Welcome() {
  const router = useRouter();
  const catalog = useQuery({ queryKey: ['catalog', 'guest'], queryFn: api.catalog, retry: 1 });
  const [underage, setUnderage] = useState(false);
  const sampleId = catalog.data?.guest_sample_lesson_id ?? null;

  return (
    <Screen>
      <Gap size={spacing.xxl} />
      <View style={styles.brandRow}>
        <Text style={styles.brand}>{brand.name}</Text>
        <Bubble size={40} />
      </View>
      <Heading>{brand.tagline}</Heading>
      <Body muted>Learn ten small conversation frameworks, speak to a daily prompt, check the transcript, and get specific feedback on your own words.</Body>
      <Card tone="lavender">
        <Label style={{ color: colors.ink, fontWeight: '600' }}>For adults</Label>
        <Body>marshmemos is for adults (18+). Practice uses fictional adult scenarios. Nothing here predicts attraction or real-world outcomes.</Body>
      </Card>
      {underage ? (
        <Card>
          <Body>Thanks for checking. marshmemos isn’t available for people under 18.</Body>
        </Card>
      ) : null}
      <Gap />
      <Button
        title="Try a lesson"
        variant="secondary"
        disabled={!sampleId && !catalog.isPending}
        loading={catalog.isPending}
        onPress={() => sampleId && router.push(`/lesson/${sampleId}`)}
        accessibilityHint="Read one sample lesson without an account"
      />
      {!sampleId && !catalog.isPending ? <Label>No published sample lesson is available yet.</Label> : null}
      <Button title="Sign in" onPress={() => router.push('/auth')} accessibilityHint="Sign in with an email code to save voice practice" />
      <Button title="I’m under 18" variant="ghost" onPress={() => setUnderage(true)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  brand: { fontSize: 32, fontWeight: '800', color: colors.ink, letterSpacing: -0.5 },
});
