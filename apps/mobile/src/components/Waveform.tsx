import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../lib/theme';

/**
 * Bars derived from actual metering samples (dBFS, roughly -160..0). When
 * metering is unavailable the component says so instead of animating a
 * decorative shape.
 */
export function Waveform({ samples, active, barCount = 32 }: { samples: number[]; active: boolean; barCount?: number }) {
  if (samples.length === 0) {
    return (
      <View style={styles.wrap} accessibilityLabel={active ? 'Recording. Level meter unavailable on this device.' : 'No recording level yet.'}>
        <Text style={styles.unavailable}>{active ? 'Recording · level meter unavailable' : ' '}</Text>
      </View>
    );
  }
  const recent = samples.slice(-barCount);
  const pad = barCount - recent.length;
  return (
    <View style={styles.wrap} accessibilityLabel={active ? 'Recording level meter' : 'Recording level history'} accessible>
      {Array.from({ length: pad }).map((_, i) => (
        <View key={`p${i}`} style={[styles.bar, { height: 4, opacity: 0.25 }]} />
      ))}
      {recent.map((db, i) => {
        const level = Math.min(1, Math.max(0, (db + 60) / 60)); // -60 dB..0 dB → 0..1
        return <View key={i} style={[styles.bar, { height: 6 + level * 54, opacity: 0.45 + level * 0.55 }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: spacing.md },
  bar: { width: 5, borderRadius: 3, backgroundColor: colors.primary },
  unavailable: { color: colors.muted, fontSize: 14 },
});
