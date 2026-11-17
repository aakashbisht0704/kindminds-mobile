/** Model files packaged inside the full app. Lite resolves the empty variant. */
import { MODEL_URLS } from './downloads';
import type { ModelKind } from './model-pack';

export type BundledAsset = {
  kind: ModelKind;
  name: string;
  bytes: number;
  module: number;
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
