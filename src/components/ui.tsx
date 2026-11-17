/**
 * UI primitives.
 *
 * Field-equipment rules baked in: every control is at least 44pt tall, the
 * primary action on a screen is never ambiguous, and any status that could
 * change a safety decision is rendered in words as well as colour (the palette
 * is a shortcut, never the only channel).
 */

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tapFeedback } from '../services/haptics';
import { hitSlop, palette, radius, severityColor, severityWash, shadow, space, type, type Severity } from '../theme';

export function Screen({
  children,
  scroll = true,
  padded = true,
  safeTop = true,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  /** Set false when the app shell already consumed the top inset. */
  safeTop?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const top = safeTop ? insets.top : space.sm;
  const contentStyle: StyleProp<ViewStyle> = [
    styles.screenContent,
    padded && { paddingHorizontal: space.lg },
    { paddingBottom: space.xxl * 2 },
  ];

  if (!scroll) {
    return <View style={[styles.screen, { paddingTop: top }]}>{children}</View>;
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[contentStyle, { paddingTop: top + space.sm }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

/** Shared screen masthead: brand mark, quiet status, then the screen title. */
export function ScreenHeader({
  title,
  subtitle,
  trailing,
}: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <View style={styles.headerText}>
          <AppText variant="display">{title}</AppText>
          {subtitle ? (
            <AppText variant="body" color={palette.inkMuted}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {trailing ? <View style={styles.headerTrailing}>{trailing}</View> : null}
      </View>
    </View>
  );
}

export function Card({
  children,
  severity,
  style,
}: {
  children: ReactNode;
  severity?: Severity;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.card,
        severity ? { borderColor: severityColor[severity], backgroundColor: severityWash[severity] } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return <Text style={[type.label, styles.sectionLabel]}>{children}</Text>;
}

/** Monospace readout for anything numeric a person may transcribe or compare. */
export function Readout({
  children,
  size = 15,
  color = palette.ink,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text numberOfLines={numberOfLines} style={[type.readout, { fontSize: size, color }, style]}>
      {children}
    </Text>
  );
}

export function AppText({
  children,
  variant = 'body',
  color = palette.ink,
  style,
  numberOfLines,
  accessibilityLiveRegion,
}: {
  children: ReactNode;
  variant?: 'display' | 'title' | 'body' | 'caption';
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
}) {
  return (
    <Text
      numberOfLines={numberOfLines}
      accessibilityLiveRegion={accessibilityLiveRegion}
      style={[type[variant], { color }, style]}
      // Body text is never truncated mid-word without a screen reader escape hatch.
      ellipsizeMode="tail"
    >
      {children}
    </Text>
  );
}

export function Pill({
  label,
  severity = 'neutral',
  solid = false,
}: {
  label: string;
  severity?: Severity;
  solid?: boolean;
}) {
  return (
    <View
      style={[
        styles.pill,
        solid
          ? { backgroundColor: severityColor[severity] }
          : { backgroundColor: severityWash[severity] },
      ]}
    >
      <Text style={[type.caption, { color: solid ? palette.surface : severityColor[severity], fontWeight: '600' }]}>
        {label}
      </Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  tone = 'primary',
  disabled = false,
  busy = false,
  hint,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  tone?: 'primary' | 'danger' | 'ghost' | 'soft' | 'inverse';
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
  accessibilityHint?: string;
}) {
  const backgroundColor =
    tone === 'primary'
      ? palette.primary
      : tone === 'danger'
        ? palette.hazard
        : tone === 'soft'
          ? palette.primaryWash
          : 'transparent';
  const textColor =
    tone === 'ghost'
      ? palette.ink
      : tone === 'soft'
        ? palette.primaryText
        : palette.surface;
  const borderColor =
    tone === 'ghost'
      ? palette.lineStrong
      : tone === 'inverse'
        ? palette.surface
        : backgroundColor;

  const ripple =
    tone === 'primary' || tone === 'danger'
      ? 'rgba(255,255,255,0.18)'
      : tone === 'inverse'
        ? 'rgba(0,0,0,0.12)'
        : 'rgba(249,115,22,0.10)';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      hitSlop={hitSlop}
      android_ripple={{ color: ripple }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor,
          borderColor,
          opacity: disabled ? 0.4 : pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        },
      ]}
    >
      {busy ? <ActivityIndicator color={textColor} size="small" /> : null}
      <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>
      {hint ? <Text style={[type.caption, { color: textColor, opacity: 0.7 }]}>{hint}</Text> : null}
    </Pressable>
  );
}

/** Two-column key/value row with the value in readout type. */
export function StatRow({
  label,
  value,
  severity,
}: {
  label: string;
  value: string;
  severity?: Severity;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={[type.body, styles.statLabel, { color: palette.inkMuted }]}>{label}</Text>
      <Readout
        color={severity ? severityColor[severity] : palette.ink}
        style={styles.statValue}
      >
        {value}
      </Readout>
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

/** Toggleable filter chip. Selected state is explicit, never colour-only. */
export function Chip({
  label,
  selected,
  onPress,
  severity = 'info',
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  severity?: Severity;
}) {
  const accent = severityColor[severity];
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      hitSlop={hitSlop}
      android_ripple={{ color: 'rgba(249,115,22,0.10)' }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? severityWash[severity] : palette.raised,
          opacity: pressed ? 0.9 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <Text style={[type.caption, { color: selected ? accent : palette.inkMuted, fontWeight: selected ? '700' : '500' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Single-value completion bar. The numeric readout always accompanies it. */
export function ProgressBar({ ratio, severity = 'safe' }: { ratio: number; severity?: Severity }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <View
      style={styles.progressTrack}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
    >
      <View
        style={[
          styles.progressFill,
          { width: `${clamped * 100}%`, backgroundColor: severityColor[severity] },
        ]}
      />
    </View>
  );
}

/** Labelled text input. One look for every field in the app. */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  maxLength,
  keyboardType = 'default',
  hint,
  trailing,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  keyboardType?: KeyboardTypeOptions;
  hint?: string;
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={[type.label, { color: palette.inkMuted }]}>{label}</Text>
      <View style={[styles.fieldRow, multiline ? styles.fieldRowTop : null]}>
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={hint}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={palette.inkFaint}
          multiline={multiline}
          maxLength={maxLength}
          keyboardType={keyboardType}
          selectionColor={palette.primary}
          style={[styles.input, multiline ? styles.inputMultiline : null]}
        />
        {trailing ? <View style={styles.fieldTrailing}>{trailing}</View> : null}
      </View>
      {maxLength ? (
        <Text style={[type.readout, styles.counter, { color: palette.inkFaint }]}>
          {`${value.length}/${maxLength}`}
        </Text>
      ) : null}
    </View>
  );
}

/** Compact pack/complete toggle. Text carries the state, colour is secondary. */
export function CheckButton({
  checked,
  onPress,
  label,
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      hitSlop={hitSlop}
      android_ripple={{ color: 'rgba(249,115,22,0.10)' }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.checkButton,
        checked && styles.checkButtonOn,
        { opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <View style={[styles.checkDot, checked && styles.checkDotOn]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      <Text style={[type.caption, { color: checked ? palette.safe : palette.inkMuted }]}>
        {checked ? 'Packed' : 'Pack'}
      </Text>
    </Pressable>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <AppText variant="title" color={palette.inkMuted}>
        {title}
      </AppText>
      <AppText variant="body" color={palette.inkFaint} style={{ marginTop: space.xs }}>
        {body}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.canvas },
  screenContent: { gap: space.lg },
  header: { gap: space.md, marginTop: space.sm },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  headerText: { flex: 1, gap: space.xs },
  headerTrailing: { flexShrink: 1, alignItems: 'flex-end', paddingTop: space.xs },
  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.line,
    padding: space.lg,
    gap: space.md,
    ...shadow,
  },
  sectionLabel: { color: palette.inkMuted, fontSize: 13, fontWeight: '700', letterSpacing: 0 },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  button: {
    minHeight: 54,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    overflow: 'hidden',
  },
  buttonLabel: { fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  statRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
  },
  statLabel: { flexShrink: 1 },
  statValue: { flexShrink: 1, textAlign: 'right' },
  divider: { height: StyleSheet.hairlineWidth * 2, backgroundColor: palette.line, marginVertical: space.xs },
  empty: { paddingVertical: space.xl, alignItems: 'flex-start' },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    minHeight: 44,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  progressTrack: {
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: palette.raised,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: radius.pill },
  field: { gap: space.xs },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fieldRowTop: { alignItems: 'flex-start' },
  fieldTrailing: { paddingTop: 2 },
  input: {
    flex: 1,
    minHeight: 50,
    borderRadius: radius.md,
    backgroundColor: palette.raised,
    color: palette.ink,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 16,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  counter: { alignSelf: 'flex-end', fontSize: 10 },
  checkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: palette.raised,
    minHeight: 44,
  },
  checkButtonOn: { backgroundColor: palette.safeDim },
  checkDot: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: palette.lineStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkDotOn: { backgroundColor: palette.safe, borderColor: palette.safe },
  checkMark: { color: palette.surface, fontSize: 13, fontWeight: '700', lineHeight: 16 },
});
