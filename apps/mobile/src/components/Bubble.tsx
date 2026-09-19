import { StyleSheet, View } from 'react-native';
import { colors } from '../lib/theme';

/** Small original speech-bubble mark built from views; decorative, hidden from screen readers. */
export function Bubble({ size = 56 }: { size?: number }) {
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.body, { width: size, height: size * 0.78, borderRadius: size * 0.28 }]}>
        <View style={[styles.eye, { left: size * 0.3, top: size * 0.32, width: size * 0.1, height: size * 0.1 }]} />
        <View style={[styles.eye, { left: size * 0.58, top: size * 0.32, width: size * 0.1, height: size * 0.1 }]} />
      </View>
      <View style={[styles.tail, { left: size * 0.22, top: size * 0.7, borderTopWidth: size * 0.2, borderLeftWidth: size * 0.12, borderRightWidth: size * 0.12 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { backgroundColor: colors.surface, borderWidth: 2, borderColor: colors.ink, position: 'relative' },
  eye: { position: 'absolute', backgroundColor: colors.ink, borderRadius: 99 },
  tail: { position: 'absolute', width: 0, height: 0, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderTopColor: colors.ink },
});
