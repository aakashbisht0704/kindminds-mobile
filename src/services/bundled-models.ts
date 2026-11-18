/**
 * The models that ship inside the full app.
 *
 * Keeping them in the APK means the essential models are available before a
 * connection exists. Shruti and Mirage are small enough for the normal asset
 * path; the text model is not, so it is streamed out of the APK by the native
 * `ModelAsset` module. Either way the file lands in the same model directory the
 * download path uses, is registered in the manifest, and the copy is atomic: a
 * partial file never replaces a working model.
 */

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';

import { KINDMINDS_LITE } from '../config';
import { modelFile, registerModel } from './model-pack';
import { BUNDLED_TEXT_ASSET, MODEL_ASSETS, type BundledAsset } from './model-assets';
import { copyModelAsset, modelAssetAvailable } from './model-asset-native';

export const BUNDLED_MODELS: readonly BundledAsset[] = MODEL_ASSETS;
export const BUNDLED_TEXT = KINDMINDS_LITE ? null : BUNDLED_TEXT_ASSET;
/** True when this build carries the text model in its own APK. */
export const BUNDLED_TEXT_MODEL = BUNDLED_TEXT !== null;
export const BUNDLED_BYTES =
  BUNDLED_MODELS.reduce((total, model) => total + model.bytes, 0) + (BUNDLED_TEXT?.bytes ?? 0);

export type BundledInstallProgress = (fraction: number, detail: string) => void;

/**
 * Copy the included models into app storage. Safe to call on every launch:
 * existing complete files are kept, and a missing or truncated file is replaced
 * from the bundled asset.
 */
export async function installBundledModels(
  onProgress?: BundledInstallProgress,
): Promise<number> {
  if (KINDMINDS_LITE) return 0;

  const total = BUNDLED_MODELS.length + (BUNDLED_TEXT ? 1 : 0);
  let done = 0;
  let installed = 0;

  for (const model of BUNDLED_MODELS) {
    const target = modelFile(model.name);
    // The bundled file is exact; a 90%-complete copy would still fail to load
    // at the moment a person needs it.
    const complete = target.exists && (target.size ?? 0) >= model.bytes;
    if (complete) {
      registerModel(model.name, model.kind);
    } else {
      const asset = Asset.fromModule(model.module);
      await asset.downloadAsync();
      const sourceUri = asset.localUri ?? asset.uri;
      if (sourceUri.startsWith('file://')) {
        const source = new File(sourceUri);
        if (!source.exists) {
          throw new Error(`The included ${model.name} file could not be read.`);
        }
      }

      const temporary = new File(`${target.uri}.part`);
      if (temporary.exists) temporary.delete();
      // copyAsync handles file://, asset:// and content:// sources, whereas the
      // object API's File.copy only accepts real paths.
      await copyAsync({ from: sourceUri, to: temporary.uri });
      if (!temporary.exists || (temporary.size ?? 0) === 0) {
        throw new Error(`The included ${model.name} file could not be copied.`);
      }
      if (target.exists) target.delete();
      temporary.move(target);
      registerModel(model.name, model.kind);
      installed += 1;
    }
    done += 1;
    onProgress?.(done / total, `${model.name} is ready`);
  }

  if (BUNDLED_TEXT) {
    const target = modelFile(BUNDLED_TEXT.name);
    const complete = target.exists && (target.size ?? 0) >= BUNDLED_TEXT.bytes;
    if (complete) {
      registerModel(BUNDLED_TEXT.name, BUNDLED_TEXT.kind);
    } else {
      if (!modelAssetAvailable()) {
        throw new Error('This build cannot read its included model.');
      }
      onProgress?.(done / total, 'Copying the included text model');
      await copyModelAsset(BUNDLED_TEXT.assetPath, target.uri, BUNDLED_TEXT.bytes);
      registerModel(BUNDLED_TEXT.name, BUNDLED_TEXT.kind);
      installed += 1;
    }
    done += 1;
    onProgress?.(done / total, `${BUNDLED_TEXT.name} is ready`);
  }

  return installed;
}
