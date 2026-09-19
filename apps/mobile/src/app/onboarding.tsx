import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { Body, Button, Card, ErrorBox, Eyebrow, Gap, Heading, Label, Screen } from '../components/ui';
import { api } from '../lib/api';
import { deviceTimeZone } from '../lib/format';
import { queryClient } from '../lib/query';
import { colors, fontSizes, minTouch, radius, spacing } from '../lib/theme';

const GOALS = [
  ['everyday_conversation', 'Everyday conversation'],
  ['dating', 'Dating and meeting people'],
  ['work_social', 'Work and social events'],
  ['general_confidence', 'General confidence'],
] as const;
const EXPERIENCE = [
  ['new', 'New to this'],
  ['some', 'Some practice'],
  ['comfortable', 'Fairly comfortable'],
] as const;

export default function Onboarding() {
  const router = useRouter();
  const [goal, setGoal] = useState<(typeof GOALS)[number][0] | null>(null);
  const [experience, setExperience] = useState<(typeof EXPERIENCE)[number][0] | null>(null);
  const [context, setContext] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.updatePreferences({
        goal,
        experience,
        social_context: context.trim() ? context.trim() : null,
        timezone: deviceTimeZone(),
        onboarding_completed: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['preferences'] });
      router.replace('/(tabs)/today');
    },
  });

  return (
    <Screen footer={<Button title={goal ? 'Save and start' : 'Skip for now'} onPress={() => save.mutate()} loading={save.isPending} />}>
      <Gap size={spacing.xl} />
      <Eyebrow>A little about you</Eyebrow>
      <Heading>What would you like to practice for?</Heading>
      <Card>
        <Label>Goal (optional)</Label>
        {GOALS.map(([id, label]) => (
          <Choice key={id} label={label} selected={goal === id} onPress={() => setGoal(goal === id ? null : id)} />
        ))}
      </Card>
      <Card>
        <Label>Experience (optional)</Label>
        {EXPERIENCE.map(([id, label]) => (
          <Choice key={id} label={label} selected={experience === id} onPress={() => setExperience(experience === id ? null : id)} />
        ))}
      </Card>
      <Card>
        <Label>Optional context</Label>
        <Body muted>A few words about where you’d use this. We don’t ask for dating histories.</Body>
        <TextInput value={context} onChangeText={setContext} maxLength={200} multiline style={styles.input} placeholder="e.g. team lunches, first dates, meetups" accessibilityLabel="Optional context" />
      </Card>
      <Card tone="lavender">
        <Label style={{ color: colors.ink, fontWeight: '600' }}>How audio works</Label>
        <Body>
          Recording starts only when you tap Start speaking and stops when you leave the screen. Nothing uploads until you choose Use recording. Your recording is transcribed by an AI service, you confirm the words, and only those confirmed words are assessed. Raw audio is kept for up to 24 hours; confirmed practice and progress stay until you delete them.
        </Body>
      </Card>
      {save.isError ? <ErrorBox message="Couldn’t save your preferences. Check your connection and try again." action={() => save.mutate()} actionTitle="Try again" /> : null}
    </Screen>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} style={[styles.choice, selected && styles.choiceSelected]}>
      <Text style={[styles.choiceText, selected && { color: colors.surface }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  choice: { minHeight: minTouch, justifyContent: 'center', paddingHorizontal: spacing.lg, borderRadius: radius.button, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.canvas },
  choiceSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  choiceText: { fontSize: fontSizes.body, color: colors.ink },
  input: { minHeight: 72, borderWidth: 1, borderColor: colors.border, borderRadius: radius.button, padding: spacing.md, fontSize: fontSizes.body, color: colors.ink, backgroundColor: colors.surface, textAlignVertical: 'top' },
});
