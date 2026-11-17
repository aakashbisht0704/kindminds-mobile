/**
 * Microphone capture for on-device speech-to-text.
 *
 * The PCM stream is captured at the exact format whisper.cpp expects (16 kHz,
 * mono, signed 16-bit), wrapped in a WAV container, and handed to whisper.rn.
 * The temporary file is deleted after transcription. Nothing is uploaded.
 */

import LiveAudioStream from '@fugood/react-native-audio-pcm-stream';
import { File, Paths } from 'expo-file-system';
import { PermissionsAndroid, Platform } from 'react-native';

import { base64ToBytes } from '../core/mesh/bytes';

const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

let subscription: { remove: () => void } | null = null;
let chunks: Uint8Array[] = [];
let recording = false;

export function isRecording(): boolean {
  return recording;
}

async function requestMicrophone(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
      title: 'Microphone access',
      message: 'KindMinds needs the microphone to turn your speech into text on this phone.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export async function startRecording(): Promise<void> {
  if (recording) return;
  if (!LiveAudioStream || typeof LiveAudioStream.init !== 'function') {
    throw new Error('The microphone module is not available in this build.');
  }
  const granted = await requestMicrophone();
  if (!granted) throw new Error('Microphone permission was denied. Allow it in Android settings, then try again.');

  chunks = [];
  // `init` is asynchronous on Android. Starting before it resolves would leave
  // the native recorder null and capture nothing at all.
  await LiveAudioStream.init({
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    bitsPerSample: BITS_PER_SAMPLE,
    audioSource: 6,
    // The native module drops the first two buffers to avoid a click. A 16 KB
    // buffer meant skipping ~1 s of speech; 4 KB keeps that under 0.3 s.
    bufferSize: 4096,
    wavFile: '',
  });
  subscription = LiveAudioStream.on('data', (data) => {
    try {
      chunks.push(base64ToBytes(data));
    } catch {
      // A malformed chunk must not kill the recording session.
    }
  });
  LiveAudioStream.start();
  recording = true;
}

function concat(chunksToJoin: Uint8Array[]): Uint8Array {
  const total = chunksToJoin.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunksToJoin) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function writeString(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** Minimal canonical WAV header for 16-bit PCM. */
function wavContainer(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeString(view, 36, 'data');
  view.setUint32(40, pcm.length, true);

  const output = new Uint8Array(44 + pcm.length);
  output.set(new Uint8Array(header), 0);
  output.set(pcm, 44);
  return output;
}

export async function stopRecording(): Promise<string> {
  if (!recording) throw new Error('No recording is running.');
  recording = false;
  try {
    await LiveAudioStream.stop();
  } catch {
    // Continue with whatever was captured.
  }
  // `stop()` only flips a flag; let the capture thread finish its current
  // 4 KB read (~128 ms) and release the AudioRecord before a new session
  // starts. Otherwise the old thread can null out the new recorder.
  await new Promise((resolve) => setTimeout(resolve, 250));
  subscription?.remove();
  subscription = null;

  const pcm = concat(chunks);
  chunks = [];
  // pcm.length is bytes; 16-bit mono is 2 bytes per sample.
  if (pcm.length < SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 0.35) {
    throw new Error('The recording was too short. Hold for a moment, speak, then tap stop.');
  }

  const file = new File(Paths.cache, `kindminds-voice-${Date.now()}.wav`);
  file.write(wavContainer(pcm));
  return file.uri;
}

export function discardRecording(uri: string | null): void {
  if (!uri) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Cache cleanup is best-effort.
  }
}
