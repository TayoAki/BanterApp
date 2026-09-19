import { StyleSheet, Text, View } from 'react-native';
import type { CriterionOrigin } from '@marshmemos/contracts/types';
import { colors, fontSizes, spacing } from '../lib/theme';
import { Label } from './ui';

const ORIGIN_LABEL: Record<CriterionOrigin, string> = {
  source_rule: 'Source rule',
  example_derived: 'From the example · exercise target',
  exercise_rule: 'Exercise target',
};

/** One criterion with its 0–3 score, origin label, evidence and reason. */
export function CriterionRow({ label, origin, score, evidence, reason, showEvidence = true }: { label: string; origin: CriterionOrigin; score: number | null; evidence: string[]; reason: string; showEvidence?: boolean }) {
  const scoreText = score === null ? '—' : `${score}/3`;
  const state = score === null ? 'not assessed' : score >= 2 ? 'clear' : score === 1 ? 'developing' : 'absent';
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${scoreText}, ${state}. ${reason}`}>
      <View style={styles.head}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.label}>{label}</Text>
          <Label>{ORIGIN_LABEL[origin]}</Label>
        </View>
        <View style={styles.scoreWrap}>
          <Text style={[styles.score, score !== null && score >= 2 && { color: colors.success }, score === 0 && { color: colors.error }]}>{scoreText}</Text>
          <Label>{state}</Label>
        </View>
      </View>
      {showEvidence && evidence.length > 0 ? (
        <View style={styles.evidence}>
          {evidence.map((q) => (
            <Text key={q} style={styles.quote}>
              “{q}”
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.reason}>{reason}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  label: { fontSize: fontSizes.body, fontWeight: '600', color: colors.ink },
  scoreWrap: { alignItems: 'flex-end' },
  score: { fontSize: 22, fontWeight: '700', color: colors.ink },
  evidence: { backgroundColor: colors.lavender, borderRadius: 10, padding: spacing.sm, gap: 4 },
  quote: { fontSize: fontSizes.label, lineHeight: 20, color: colors.ink, fontStyle: 'italic' },
  reason: { fontSize: fontSizes.label, lineHeight: 20, color: colors.muted },
});
