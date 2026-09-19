import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SourceExampleDto } from '@marshmemos/contracts/api';
import { colors, fontSizes, radius, spacing } from '../lib/theme';
import { Label, Pill } from './ui';

const USE_LABEL: Record<SourceExampleDto['teaching_use'], string> = {
  demonstration: 'Demonstration',
  mixed_demo: 'Mixed demonstration',
  context_dependent: 'Context dependent',
  comparison: 'Comparison',
  critique: 'For critique, not imitation',
};

/**
 * Renders a source example exactly as supplied (whitespace-normalized only),
 * separately from the editorial note. Long quotes scroll inside a bounded
 * box instead of being truncated.
 */
export function SourceQuote({ example, compact }: { example: SourceExampleDto; compact?: boolean }) {
  return (
    <View style={styles.wrap} accessibilityLabel={`Source example ${example.example_id}`}>
      <View style={styles.header}>
        <Label>Original source · {example.source_filename} · p. {example.source_pages.join(', ')}</Label>
        <Pill tone={example.teaching_use === 'critique' ? 'error' : example.teaching_use === 'context_dependent' ? 'accent' : 'lavender'}>
          {USE_LABEL[example.teaching_use]}
        </Pill>
      </View>
      <ScrollView style={[styles.quoteBox, compact && { maxHeight: 160 }]} nestedScrollEnabled showsVerticalScrollIndicator>
        <Text style={styles.quote} selectable>
          {example.text_verbatim}
        </Text>
      </ScrollView>
      <View style={styles.editorial}>
        <Label style={{ color: colors.ink, fontWeight: '600' }}>Editorial note</Label>
        <Text style={styles.editorialText}>{example.editorial_note}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  header: { gap: spacing.xs },
  quoteBox: { maxHeight: 260, backgroundColor: colors.surface, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  quote: { fontSize: fontSizes.body, lineHeight: 26, color: colors.ink, fontStyle: 'italic' },
  editorial: { backgroundColor: colors.lavender, borderRadius: radius.button, padding: spacing.md, gap: spacing.xs },
  editorialText: { fontSize: fontSizes.label, lineHeight: 20, color: colors.ink },
});
