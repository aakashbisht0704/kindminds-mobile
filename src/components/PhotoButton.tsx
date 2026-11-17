/**
 * Photo description button.
 *
 * Uses the phone's file picker so no image-library permission is needed. The
 * image is copied into the app cache, described by the local multimodal model,
 * then deleted. The result is a description of visible text/hazards, never a
 * diagnosis.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import Svg, { Circle, Path } from 'react-native-svg';

import { describeImage } from '../services/local-ai';
import { hitSlop, palette, radius, space, type } from '../theme';

/** Picker returns a content:// URI; the SDK's File.copy cannot read those. */
function suffixFor(file: { type?: string | null }): string {
  const mime = file.type?.toLowerCase() ?? '';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic' || mime === 'image/heif') return '.heic';
  if (mime === 'image/gif') return '.gif';
  return '.jpg';
}

export function PhotoButton({
  onDescription,
  onError,
  enabled,
  compact = false,
}: {
  onDescription: (text: string) => void;
  onError?: (message: string) => void;
  enabled: boolean;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function report(message: string) {
    if (onError) onError(message);
    else setNotice(message);
  }

  async function handlePress() {
    if (busy) return;
    if (!enabled) {
      report('Photo description needs the Mirage model. Open Prepare → Shruti + Mirage to install it.');
      return;
    }

    setBusy(true);
    setNotice(null);
    let target: File | null = null;
    try {
      const picked = await File.pickFileAsync(undefined, 'image/*');
      const first = Array.isArray(picked) ? picked[0] : picked;
      if (!first) return;

      target = new File(Paths.cache, `kindminds-photo-${Date.now()}${suffixFor(first)}`);
      await copyAsync({ from: first.uri, to: target.uri });
      if (!target.exists || (target.size ?? 0) === 0) {
        throw new Error('The selected photo could not be read. Try another image.');
      }

      const description = await describeImage(target.uri);
      if (!description) {
        report('The vision model could not read that image. Try a brighter, closer photo.');
        return;
      }
      onDescription(description);
    } catch (error) {
      report(error instanceof Error ? error.message : 'Could not read that image.');
    } finally {
      try {
        if (target?.exists) target.delete();
      } catch {
        // Cache cleanup is best-effort.
      }
      setBusy(false);
    }
  }

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Describe a photo"
        accessibilityHint="Opens the photo picker and describes visible text and hazards on this phone"
        accessibilityState={{ busy }}
        hitSlop={hitSlop}
        android_ripple={{ color: 'rgba(249,115,22,0.12)', borderless: true }}
        onPress={() => void handlePress()}
        style={({ pressed }) => [
          styles.button,
          compact && styles.buttonCompact,
          {
            backgroundColor: enabled ? palette.raised : palette.raised,
            opacity: pressed ? 0.85 : busy ? 0.6 : 1,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={palette.inkMuted} />
        ) : (
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <Path
              d="M4 8.5h3l1.3-2h7.4l1.3 2h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5z"
              stroke={enabled ? palette.ink : palette.inkMuted}
              strokeWidth={1.7}
              fill="none"
            />
            <Circle cx={12} cy={13.5} r={3.1} stroke={enabled ? palette.ink : palette.inkMuted} strokeWidth={1.7} fill="none" />
          </Svg>
        )}
      </Pressable>
      {notice ? (
        <Text style={[type.caption, styles.notice]} numberOfLines={2}>
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.xs },
  wrapCompact: { alignItems: 'flex-start' },
  button: {
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  buttonCompact: { width: 44, height: 44 },
  notice: { color: palette.caution, maxWidth: 180, textAlign: 'center' },
});
