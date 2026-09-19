import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, contentMaxWidth, fontSizes, minTouch, radius, spacing } from '../lib/theme';

export function Screen({ children, scroll = true, footer, testID }: PropsWithChildren<{ scroll?: boolean; footer?: ReactNode; testID?: string }>) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']} testID={testID}>
      {scroll ? (
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
          <View style={styles.column}>{children}</View>
        </ScrollView>
      ) : (
        <View style={[styles.scrollContent, { flex: 1 }]}>
          <View style={[styles.column, { flex: 1 }]}>{children}</View>
        </View>
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

export function Eyebrow({ children }: PropsWithChildren) {
  return (
    <Text style={styles.eyebrow} accessibilityRole="text">
      {children}
    </Text>
  );
}

export function Heading({ children, style }: PropsWithChildren<{ style?: StyleProp<TextStyle> }>) {
  return (
    <Text style={[styles.heading, style]} accessibilityRole="header" maxFontSizeMultiplier={1.6}>
      {children}
    </Text>
  );
}

export function Body({ children, muted, style, selectable }: PropsWithChildren<{ muted?: boolean; style?: StyleProp<TextStyle>; selectable?: boolean }>) {
  return (
    <Text style={[styles.body, muted && styles.muted, style]} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Label({ children, style }: PropsWithChildren<{ style?: StyleProp<TextStyle> }>) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

export function Card({ children, tone = 'surface', style }: PropsWithChildren<{ tone?: 'surface' | 'lavender'; style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, tone === 'lavender' && styles.cardLavender, style]}>{children}</View>;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  accessibilityLabel,
  accessibilityHint,
  style,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        variant === 'danger' && styles.buttonDanger,
        pressed && { opacity: 0.85 },
        isDisabled && { opacity: 0.5 },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={variant === 'primary' || variant === 'danger' ? colors.surface : colors.primary} />
      ) : (
        <Text style={[styles.buttonText, (variant === 'secondary' || variant === 'ghost') && { color: colors.primary }]} maxFontSizeMultiplier={1.4}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Pill({ children, tone = 'lavender' }: PropsWithChildren<{ tone?: 'lavender' | 'success' | 'muted' | 'accent' | 'error' }>) {
  const bg = tone === 'success' ? '#E3F3EA' : tone === 'muted' ? '#EEF0F4' : tone === 'accent' ? '#FFF3D1' : tone === 'error' ? '#FBE4E7' : colors.lavender;
  const fg = tone === 'success' ? colors.success : tone === 'muted' ? colors.muted : tone === 'error' ? colors.error : colors.ink;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{children}</Text>
    </View>
  );
}

export function ErrorBox({ message, action, actionTitle }: { message: string; action?: () => void; actionTitle?: string }) {
  return (
    <View style={styles.errorBox} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <Text style={styles.errorText}>{message}</Text>
      {action && actionTitle ? <Button title={actionTitle} onPress={action} variant="secondary" style={{ marginTop: spacing.md }} /> : null}
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading} accessibilityLiveRegion="polite" accessibilityLabel={label}>
      <ActivityIndicator color={colors.primary} />
      <Text style={[styles.label, { marginTop: spacing.sm }]}>{label}</Text>
    </View>
  );
}

export function Row({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Gap({ size = spacing.lg }: { size?: number }) {
  return <View style={{ height: size }} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scrollContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, alignItems: 'center' },
  column: { width: '100%', maxWidth: contentMaxWidth, gap: spacing.md, paddingTop: spacing.md },
  footer: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: spacing.sm, alignItems: 'center', backgroundColor: colors.canvas },
  eyebrow: { fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase', color: colors.muted, fontWeight: '600' },
  heading: { fontSize: fontSizes.heading, lineHeight: 34, fontWeight: '700', color: colors.ink },
  body: { fontSize: fontSizes.body, lineHeight: 25, color: colors.ink },
  muted: { color: colors.muted },
  label: { fontSize: fontSizes.label, lineHeight: 20, color: colors.muted },
  card: { backgroundColor: colors.surface, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.border },
  cardLavender: { backgroundColor: colors.lavender, borderColor: colors.lavender },
  button: { minHeight: minTouch, borderRadius: radius.button, paddingHorizontal: spacing.xl, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.primary },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonDanger: { backgroundColor: colors.error },
  buttonText: { color: colors.surface, fontSize: fontSizes.body, fontWeight: '600' },
  pill: { alignSelf: 'flex-start', paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: 999 },
  pillText: { fontSize: fontSizes.label, fontWeight: '600' },
  errorBox: { backgroundColor: '#FBE4E7', borderRadius: radius.card, padding: spacing.lg },
  errorText: { color: colors.error, fontSize: fontSizes.body, lineHeight: 24 },
  loading: { padding: spacing.xl, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
