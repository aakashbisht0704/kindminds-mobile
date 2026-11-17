/**
 * A one-minute grounding reset.
 *
 * Extended-exhale breathing (in 4, hold 2, out 6) is the simplest thing that
 * reliably lowers arousal without a network, a login, or a subscription. The
 * circle is the whole interface: it grows on the inhale, holds, and shrinks on
 * the exhale, so a person can follow it with their eyes while their hands shake.
 */

import { useEffect, useRef, useState } from 'react';
import * as Haptics from 'expo-haptics';
import { Animated, Easing, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionButton, AppText } from './ui';
import { palette, radius, space, type } from '../theme';

const PHASES = [
  { key: 'in', label: 'Breathe in', seconds: 4, scale: 1 },
  { key: 'hold', label: 'Hold', seconds: 2, scale: 1 },
  { key: 'out', label: 'Breathe out', seconds: 6, scale: 0.62 },
] as const;

const TOTAL_CYCLES = 6;

export function BreathingExercise({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number>(PHASES[0].seconds);
  const [cycle, setCycle] = useState(1);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const scale = useRef(new Animated.Value(0.62)).current;

  const phase = PHASES[phaseIndex] ?? PHASES[0];

  // Opening the sheet always starts from the same place: a half-open circle and
  // a person who has not yet begun. No stale timer survives a close.
  useEffect(() => {
    if (!visible) return;
    setPhaseIndex(0);
    setSecondsLeft(PHASES[0].seconds);
    setCycle(1);
    setRunning(false);
    setDone(false);
    scale.setValue(0.62);
  }, [visible, scale]);

  // One timeout at a time. Each tick either decrements the visible countdown or
  // advances the phase, which keeps pause/resume honest.
  useEffect(() => {
    if (!visible || !running || done) return;

    if (secondsLeft <= 0) {
      const next = (phaseIndex + 1) % PHASES.length;
      if (next === 0) {
        if (cycle >= TOTAL_CYCLES) {
          setRunning(false);
          setDone(true);
          return;
        }
        setCycle((current) => current + 1);
      }
      const nextPhase = PHASES[next] ?? PHASES[0];
      setPhaseIndex(next);
      setSecondsLeft(nextPhase.seconds);
      return;
    }

    const timer = setTimeout(() => setSecondsLeft((remaining) => remaining - 1), 1000);
    return () => clearTimeout(timer);
  }, [visible, running, done, phaseIndex, secondsLeft, cycle]);

  // A light tap marks each phase change without requiring the user to look at
  // the screen. Haptics are best-effort: a device without a vibrator is silent.
  useEffect(() => {
    if (!visible || !running || done) return;
    void Haptics.impactAsync(
      phase.key === 'in' ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Soft,
    ).catch(() => {});
  }, [phase, visible, running, done]);

  useEffect(() => {
    if (!done) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [done]);

  // The circle takes the length of the phase to reach its resting size, so the
  // animation itself is the pacing cue rather than a decorative extra.
  useEffect(() => {
    if (!visible) return;
    Animated.timing(scale, {
      toValue: phase.scale,
      duration: running ? phase.seconds * 1000 : 320,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [phase, visible, running, scale]);

  function start() {
    if (done) {
      setDone(false);
      setPhaseIndex(0);
      setSecondsLeft(PHASES[0].seconds);
      setCycle(1);
      scale.setValue(0.62);
    }
    setRunning(true);
  }

  function reset() {
    setRunning(false);
    setDone(false);
    setPhaseIndex(0);
    setSecondsLeft(PHASES[0].seconds);
    setCycle(1);
    scale.setValue(0.62);
  }

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg }]}>
        <View style={styles.topRow}>
          <AppText variant="caption" color={palette.inkMuted}>
            {done ? 'Reset complete' : `Cycle ${cycle} of ${TOTAL_CYCLES}`}
          </AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close breathing exercise"
            hitSlop={10}
            android_ripple={{ color: 'rgba(46,122,92,0.10)', borderless: true }}
            onPress={onClose}
            style={({ pressed }) => [styles.closeButton, { opacity: pressed ? 0.65 : 1 }]}
          >
            <AppText variant="caption" color={palette.jade} style={styles.close}>
              Close
            </AppText>
          </Pressable>
        </View>

        <View style={styles.copy}>
          <AppText variant="display" style={styles.title}>
            {done ? 'You are here.' : 'A minute to steady yourself'}
          </AppText>
          <AppText variant="body" color={palette.inkMuted} style={styles.subtitle}>
            {done
              ? 'Notice your shoulders. Take one more slow breath before you move.'
              : 'In for four, hold for two, out for six. Follow the circle, not the clock.'}
          </AppText>
        </View>

        <View style={styles.stage}>
          <View style={styles.halo} />
          <Animated.View style={[styles.breath, { transform: [{ scale }] }]} />
          <View style={styles.center} pointerEvents="none">
            {done ? (
              <AppText variant="display" color={palette.jade} style={styles.doneMark}>
                ✓
              </AppText>
            ) : (
              <>
                <AppText variant="title" color={palette.surface} style={styles.phase} accessibilityLiveRegion="polite">
                  {phase.label}
                </AppText>
                <AppText variant="display" color={palette.jadeDeep} style={styles.count}>
                  {String(secondsLeft)}
                </AppText>
              </>
            )}
          </View>
        </View>

        <View style={styles.dots} accessibilityLabel={`${cycle} of ${TOTAL_CYCLES} cycles`}>
          {Array.from({ length: TOTAL_CYCLES }, (_, index) => (
            <View
              key={index}
              style={[styles.dot, index < cycle - 1 || done ? styles.dotDone : null, index === cycle - 1 && !done ? styles.dotNow : null]}
            />
          ))}
        </View>

        <View style={styles.actions}>
          {done ? (
            <ActionButton label="Again" onPress={start} />
          ) : running ? (
            <ActionButton label="Pause" tone="ghost" onPress={() => setRunning(false)} />
          ) : (
            <ActionButton label="Start" onPress={start} />
          )}
          {!done ? (
            <ActionButton label="Reset" tone="ghost" onPress={reset} disabled={running} />
          ) : null}
        </View>

        <AppText variant="caption" color={palette.inkFaint} style={styles.footnote}>
          This is a grounding exercise, not a treatment. If breathing makes you dizzy, stop and breathe normally.
        </AppText>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.canvas,
    paddingHorizontal: space.xl,
  },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  close: { fontWeight: '700' },
  copy: { gap: space.sm, marginTop: space.xl },
  title: { color: palette.ink },
  subtitle: { maxWidth: 340 },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 280,
  },
  halo: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: radius.pill,
    backgroundColor: palette.jadeWash,
    opacity: 0.55,
  },
  breath: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: radius.pill,
    backgroundColor: palette.jade,
    opacity: 0.92,
  },
  center: { alignItems: 'center', justifyContent: 'center', gap: space.xs },
  phase: { fontWeight: '600' },
  count: { fontSize: 44, lineHeight: 52, fontWeight: '800', color: palette.surface },
  doneMark: { fontSize: 56, lineHeight: 64 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginBottom: space.xl },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: palette.line,
  },
  dotDone: { backgroundColor: palette.jade },
  dotNow: { backgroundColor: palette.jadeDeep, transform: [{ scale: 1.3 }] },
  actions: { gap: space.sm },
  footnote: { marginTop: space.lg, textAlign: 'center' },
});
