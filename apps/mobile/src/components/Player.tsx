import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, type AudioSource } from 'expo-audio';
import { mmss } from '../lib/format';
import { colors, minTouch, radius, spacing } from '../lib/theme';
import { Label } from './ui';

const RATES = [0.8, 1, 1.2] as const;

/**
 * Playback control: play/pause/replay, position and duration, 0.8x/1x/1.2x.
 * Stops on unmount (navigation, sign-out). Labeled "AI-generated voice" when
 * the source is synthesized. Playback never overlaps a new recording because
 * the recording screen is a separate route.
 */
export function Player({ source, aiGenerated, label, onPlay, disabled, errorText }: { source: AudioSource | null; aiGenerated?: boolean; label?: string; onPlay?: () => void; disabled?: boolean; errorText?: string | null }) {
  const player = useAudioPlayer(source ?? undefined, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // player may already be released
      }
    };
  }, [player]);

  const toggle = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration - 0.05)) void player.seekTo(0);
    player.play();
    onPlay?.();
  };
  const replay = () => {
    void player.seekTo(0);
    player.play();
    onPlay?.();
  };
  const changeRate = (r: (typeof RATES)[number]) => {
    setRate(r);
    player.setPlaybackRate(r, 'high');
  };
  const unavailable = disabled || !source;

  return (
    <View style={styles.wrap}>
      <View style={styles.controls}>
        <Pressable
          onPress={toggle}
          disabled={unavailable}
          accessibilityRole="button"
          accessibilityLabel={status.playing ? `Pause ${label ?? 'playback'}` : `Play ${label ?? 'playback'}`}
          style={[styles.play, unavailable && { opacity: 0.4 }]}>
          <Text style={styles.playIcon}>{status.playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={styles.track}>
            <View style={[styles.progress, { width: `${status.duration > 0 ? Math.min(100, (status.currentTime / status.duration) * 100) : 0}%` }]} />
          </View>
          <View style={styles.meta}>
            <Label>
              {mmss(status.currentTime * 1000)} / {status.duration > 0 ? mmss(status.duration * 1000) : '--:--'}
            </Label>
            <Pressable onPress={replay} disabled={unavailable} accessibilityRole="button" accessibilityLabel="Replay from start" style={styles.smallButton}>
              <Text style={styles.smallButtonText}>Replay</Text>
            </Pressable>
          </View>
        </View>
      </View>
      <View style={styles.rates} accessibilityRole="radiogroup">
        {RATES.map((r) => (
          <Pressable
            key={r}
            onPress={() => changeRate(r)}
            accessibilityRole="radio"
            accessibilityState={{ checked: rate === r }}
            accessibilityLabel={`Playback speed ${r}x`}
            style={[styles.rate, rate === r && styles.rateActive]}>
            <Text style={[styles.rateText, rate === r && { color: colors.surface }]}>{r}x</Text>
          </Pressable>
        ))}
        {aiGenerated ? <Label style={{ marginLeft: 'auto' }}>AI-generated voice</Label> : null}
      </View>
      {errorText ? <Label style={{ color: colors.error }}>{errorText}</Label> : null}
      {status.error ? <Label style={{ color: colors.error }}>Audio is unavailable right now.</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.lavender, borderRadius: radius.card, padding: spacing.md, gap: spacing.sm },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  play: { width: minTouch, height: minTouch, borderRadius: minTouch / 2, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  playIcon: { color: colors.surface, fontSize: 18, fontWeight: '700' },
  track: { height: 6, borderRadius: 3, backgroundColor: '#D9D1F7', overflow: 'hidden' },
  progress: { height: 6, backgroundColor: colors.primary },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  smallButton: { minHeight: 32, paddingHorizontal: spacing.sm, justifyContent: 'center' },
  smallButtonText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
  rates: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rate: { minWidth: 48, minHeight: 36, paddingHorizontal: spacing.sm, borderRadius: 999, borderWidth: 1, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  rateActive: { backgroundColor: colors.primary },
  rateText: { color: colors.primary, fontWeight: '600', fontSize: 14 },
});
