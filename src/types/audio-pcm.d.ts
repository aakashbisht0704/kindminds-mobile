declare module '@fugood/react-native-audio-pcm-stream' {
  export type AudioPcmOptions = {
    sampleRate: number;
    channels: 1 | 2;
    bitsPerSample: 8 | 16;
    audioSource?: number;
    wavFile: string;
    bufferSize?: number;
  };

  export type AudioPcmSubscription = { remove: () => void };

  const AudioRecord: {
    init: (options: AudioPcmOptions) => void;
    start: () => void;
    stop: () => Promise<string>;
    on: (event: 'data', callback: (data: string) => void) => AudioPcmSubscription;
  };

  export default AudioRecord;
}
