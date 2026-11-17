/**
 * Push-to-talk transcription.
 *
 * One tap starts, the next stops and transcribes with Shruti on the device. The audio file is deleted immediately after transcription. If no
 * voice model is installed, the button explains that instead of silently
 * recording something the app cannot read.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import Svg, { Line, Path, Rect } from 'react-native-svg';

import { discardRecording, startRecording, stopRecording } from '../services/voice-recorder';
import { transcribeVoice } from '../services/local-ai';
import { hitSlop, palette, radius, space, type } from '../theme';

type VoiceState = 'idle' | 'recording' | 'transcribing';

export function VoiceButton({
  onTranscript,
  onError,
  enabled,
  onUnavailable,
  compact = false,
}: {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  enabled: boolean;
  onUnavailable?: () => void;
  compact?: boolean;
}) {
  const [state, setState] = useState<VoiceState>('idle');
  const [notice, setNotice] = useState<string | null>(null);

  // When the parent owns the notice area (the assistant and chat screens do),
  // report there instead of drawing a 200pt label that can overflow the edge
  // of the composer.
  function report(message: string) {
    if (onError) onError(message);
    else setNotice(message);
  }

  async function handlePress() {
    if (state === 'transcribing') return;
    if (!enabled) {
      report('Voice input needs the Shruti model. Open Prepare → Shruti + Mirage to install it.');
      onUnavailable?.();
      return;
    }

    if (state === 'idle') {
      setNotice(null);
      try {
        await startRecording();
        setState('recording');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      } catch (error) {
        report(error instanceof Error ? error.message : 'Could not start the microphone.');
      }
      return;
    }

    if (state === 'recording') {
      setState('transcribing');
      let fileUri: string | null = null;
      try {
        fileUri = await stopRecording();
        const text = await transcribeVoice(fileUri);
        if (!text) {
          report('No speech was detected. Tap, wait a beat, then speak for a few seconds.');
          return;
        }
        setNotice(null);
        onTranscript(text);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (error) {
        report(error instanceof Error ? error.message : 'Could not transcribe that.');
      } finally {
        discardRecording(fileUri);
        setState('idle');
      }
    }
  }

  const recording = state === 'recording';
  const busy = state === 'transcribing';
  const color = recording ? palette.surface : enabled ? palette.accent : palette.inkMuted;

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          recording ? 'Stop recording and transcribe' : busy ? 'Transcribing' : 'Dictate with voice'
        }
        accessibilityHint={
          enabled
            ? 'Records a short message and turns it into text on this phone'
            : 'Install the Shruti voice model in Prepare to enable voice input'
        }
        accessibilityState={{ busy, disabled: busy }}
        hitSlop={hitSlop}
        android_ripple={{ color: 'rgba(35,78,130,0.12)', borderless: true }}
        onPress={() => void handlePress()}
        style={({ pressed }) => [
          styles.button,
          compact && styles.buttonCompact,
          {
            backgroundColor: recording ? palette.hazard : enabled ? palette.accentWash : palette.raised,
            opacity: pressed ? 0.85 : busy ? 0.6 : 1,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          },
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={palette.accent} />
        ) : recording ? (
          <View style={styles.stop} />
        ) : (
          <Svg width={20} height={20} viewBox="0 0 24 24">
            <Rect x={9} y={3.5} width={6} height={10.5} rx={3} stroke={color} strokeWidth={1.8} fill="none" />
            <Path d="M5.5 11a6.5 6.5 0 0 0 13 0" stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" />
            <Line x1={12} y1={17.5} x2={12} y2={21} stroke={color} strokeWidth={1.8} strokeLinecap="round" />
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
  stop: { width: 12, height: 12, borderRadius: 3, backgroundColor: palette.surface },
  notice: { color: palette.caution, maxWidth: 200, textAlign: 'center', fontSize: 12, lineHeight: 16 },
});
