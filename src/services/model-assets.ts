/** Model files packaged inside the full app. Lite resolves the empty variant. */
import { MODEL_URLS } from './downloads';
import type { ModelKind } from './model-pack';

export type BundledAsset = {
  kind: ModelKind;
  name: string;
  bytes: number;
  module: number;
};

/**
 * A model that ships in the APK's `assets/` directory and is streamed out by the
 * native `ModelAsset` module.
 *
 * The text model cannot go through Metro: a ~940 MiB `require()` fails in the
 * asset transform ("Cannot create a string longer than 0x1fffffe8 characters"),
 * because Node strings are capped at 512 MiB. Small models use the normal
 * `expo-asset` path below; the big one uses this.
 */
export type BundledAssetFile = {
  kind: ModelKind;
  name: string;
  bytes: number;
  /** Path inside `android/app/src/main/assets/`. */
  assetPath: string;
};

export const MODEL_ASSETS: readonly BundledAsset[] = [
  {
    kind: 'voice',
    name: MODEL_URLS.voice.name,
    bytes: MODEL_URLS.voice.bytes,
    module: require('../../assets/models/shruti.cact'),
  },
  {
    kind: 'vision',
    name: MODEL_URLS.vision.name,
    bytes: MODEL_URLS.vision.bytes,
    module: require('../../assets/models/mirage.cact'),
  },
] as const;

export const BUNDLED_TEXT_ASSET: BundledAssetFile | null = {
  kind: 'text',
  name: MODEL_URLS.text.name,
  bytes: MODEL_URLS.text.bytes,
  assetPath: 'models/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
};
