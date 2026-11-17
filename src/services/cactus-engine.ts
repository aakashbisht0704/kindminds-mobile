/**
 * Access to the native Cactus 4.1 bridge.
 *
 * The bridge loads a single-file `.cact` archive (Shruti or Mirage), runs
 * speech-to-text or image description, and returns the engine's JSON. It is
 * separate from `cactus-react-native`, whose bundled engine only understands
 * unpacked Whisper/Parakeet/LFM2-VL model directories.
 */

type CactusEngineNative = {
  loadModel(path: string): Promise<number>;
  transcribe(wavPath: string): Promise<string>;
  describe(imagePath: string, optionsJson: string): Promise<string>;
};

/** Capability bits returned by `cactus_models()`. */
export const CACTUS_TEXT = 1;
export const CACTUS_SPEECH = 2;
export const CACTUS_VISION = 4;

let cached: CactusEngineNative | null | undefined;

/**
 * Resolve the native module lazily. `cactus-backend` is imported by pure unit
 * tests and by Node tooling, where React Native is not available yet.
 */
function nativeEngine(): CactusEngineNative | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    const reactNative = require('react-native') as {
      NativeModules: Record<string, CactusEngineNative | undefined>;
    };
    cached = reactNative.NativeModules.CactusEngine ?? null;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

export function cactusEngineAvailable(): boolean {
  return Boolean(nativeEngine());
}

function requireNative(): CactusEngineNative {
  const engine = nativeEngine();
  if (!engine) {
    throw new Error('The Cactus engine is not available in this build.');
  }
  return engine;
}

/** The native engine opens filesystem paths, not `file://` URIs. */
function nativePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

export const cactusEngine = {
  /** Load a `.cact` model and return the engine's capability bitmask. */
  loadModel(path: string): Promise<number> {
    return requireNative().loadModel(nativePath(path));
  },
  /** Transcribe a 16 kHz mono 16-bit WAV. Resolves to the engine JSON. */
  transcribe(wavPath: string): Promise<string> {
    return requireNative().transcribe(nativePath(wavPath));
  },
  /** Describe an image file. Resolves to the engine JSON. */
  describe(imagePath: string, optionsJson = '{}'): Promise<string> {
    return requireNative().describe(nativePath(imagePath), optionsJson);
  },
};
