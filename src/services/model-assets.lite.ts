/** The lite build deliberately carries no model weights. */
import type { BundledAsset, BundledAssetFile } from './model-assets';

export const MODEL_ASSETS: readonly BundledAsset[] = [];

export const BUNDLED_TEXT_ASSET: BundledAssetFile | null = null;
