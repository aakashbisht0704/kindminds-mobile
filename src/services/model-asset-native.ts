/**
 * Native helper for models that ship in the APK's `assets/` directory.
 *
 * `expo-asset` cannot carry a gigabyte: Metro refuses to package an asset that
 * large, and the copy would double the disk cost. The `ModelAsset` module
 * streams the entry out of the APK instead, so a phone has a working model
 * without any download.
 */

import { NativeModules } from 'react-native';

type ModelAssetModule = {
  copyAsset(assetPath: string, destination: string, expectedBytes: number): Promise<number>;
};

const native = (NativeModules as Record<string, ModelAssetModule | undefined>).ModelAsset;

export function modelAssetAvailable(): boolean {
  return typeof native?.copyAsset === 'function';
}

/**
 * Copy a bundled asset to `destination`, atomically. Resolves with the number
 * of bytes written; rejects with a plain-language message.
 */
export async function copyModelAsset(
  assetPath: string,
  destination: string,
  expectedBytes: number,
): Promise<number> {
  if (!native?.copyAsset) {
    throw new Error('This build cannot read its included model.');
  }
  const target = destination.startsWith('file://') ? destination.slice('file://'.length) : destination;
  return native.copyAsset(assetPath, target, expectedBytes);
}
