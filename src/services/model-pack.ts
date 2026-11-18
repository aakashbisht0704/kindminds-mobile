/**
 * On-device AI model packs.
 *
 * Models are large and user-supplied: the app never downloads one in the field.
 * A person imports a GGUF text model, a whisper.cpp voice model, and optionally
 * a vision projector before the disaster, and this service keeps them in the
 * app's documents directory with a small manifest so the correct file is loaded
 * for the correct job.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';

export const MODEL_DIRECTORY_NAME = 'models';
const MANIFEST_NAME = 'manifest.json';

export type ModelKind = 'text' | 'voice' | 'vision';

export type LocalModel = {
  name: string;
  uri: string;
  sizeBytes: number;
  kind: ModelKind;
};

type Manifest = Partial<Record<string, ModelKind>>;

export function modelDirectory(): Directory {
  return new Directory(Paths.document, MODEL_DIRECTORY_NAME);
}

export function ensureModelDirectory(): void {
  const directory = modelDirectory();
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
}

function manifestFile(): File {
  return new File(modelDirectory(), MANIFEST_NAME);
}

function readManifest(): Manifest {
  try {
    const file = manifestFile();
    if (!file.exists) return {};
    const parsed = JSON.parse(file.textSync()) as Manifest;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeManifest(manifest: Manifest): void {
  ensureModelDirectory();
  manifestFile().write(JSON.stringify(manifest));
}

/** Filename fallback for packs imported before the manifest existed. */
export function inferModelKind(name: string): ModelKind {
  const lower = name.toLowerCase();
  // Vision projectors first: a multimodal companion file is never the text model.
  if (lower.includes('mmproj') || lower.includes('-vision') || lower.includes('projector')) return 'vision';
  if (lower.includes('mirage')) return 'vision';
  if (lower.includes('shruti') || lower.includes('whistle')) return 'voice';
  if (lower.includes('qwen') || lower.includes('bonsai') || lower.includes('ternary')) return 'text';
  if (lower.includes('woof')) return 'text';
  // `.cact` is the Cactus runtime format; the filename decides the role.
  if (lower.endsWith('.cact')) return lower.includes('vision') ? 'vision' : 'voice';
  return 'text';
}

const MODEL_EXTENSIONS = ['.gguf', '.bin', '.cact'];

function isModelFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return MODEL_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * A picker returns a content:// URI whose basename is not a usable filename
 * (`image%3A1000105062`). Decode it, keep only the last segment, and make sure
 * the result has an extension the model scanner recognises.
 */
function pickedName(uri: string, fallbackExtension: string): string {
  const raw = uri.split('/').pop() ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  const leaf = decoded.split(/[\\/:]/).pop() ?? '';
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '');
  if (cleaned.length === 0) return `imported-model-${Date.now()}${fallbackExtension}`;
  return MODEL_EXTENSIONS.some((extension) => cleaned.toLowerCase().endsWith(extension))
    ? cleaned
    : `${cleaned}-${Date.now()}${fallbackExtension}`;
}

export async function listModels(): Promise<LocalModel[]> {
  try {
    ensureModelDirectory();
    const manifest = readManifest();
    const files = modelDirectory()
      .list()
      .filter((entry): entry is File => entry instanceof File && isModelFile(entry));

    return files
      .map((file) => ({
        name: file.name,
        uri: file.uri,
        sizeBytes: file.size ?? 0,
        kind: manifest[file.name] ?? inferModelKind(file.name),
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Import a model the user already has on the device (downloaded before the event). */
export async function importModel(kind: ModelKind): Promise<LocalModel | null> {
  try {
    ensureModelDirectory();
    const picked = await File.pickFileAsync(undefined, '*/*');
    const first = Array.isArray(picked) ? picked[0] : picked;
    if (!first) return null;

    const fallback = kind === 'text' ? '.gguf' : '.cact';
    const name = pickedName(first.uri, fallback);
    const target = new File(modelDirectory(), name);
    if (target.exists) target.delete();
    // The picker hands back a content:// URI on Android; File.copy cannot read
    // those, but the legacy copy uses ContentResolver.openInputStream.
    await copyAsync({ from: first.uri, to: target.uri });

    const manifest = readManifest();
    manifest[name] = kind;
    writeManifest(manifest);

    return {
      name: target.name,
      uri: target.uri,
      sizeBytes: target.size ?? 0,
      kind,
    };
  } catch {
    return null;
  }
}

/** Record a model that was downloaded directly into the model directory. */
export function registerModel(name: string, kind: ModelKind): void {
  const manifest = readManifest();
  manifest[name] = kind;
  writeManifest(manifest);
}

/** A destination path inside the model directory. */
export function modelFile(name: string): File {
  ensureModelDirectory();
  return new File(modelDirectory(), name);
}

export async function deleteModel(model: LocalModel): Promise<void> {
  try {
    const file = new File(model.uri);
    if (file.exists) file.delete();
    const manifest = readManifest();
    delete manifest[model.name];
    writeManifest(manifest);
  } catch {
    // A failed delete must not crash the settings screen.
  }
}

export function formatModelSize(bytes: number): string {
  if (bytes <= 0) return 'unknown size';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Plain-language guidance shown next to each import button. */
export const MODEL_RECOMMENDATIONS: Record<ModelKind, { title: string; detail: string; example: string }> = {
  text: {
    title: 'Qwen2.5 1.5B text model',
    detail:
      'Qwen2.5-1.5B-Instruct, Q4_K_M GGUF. Answers from the approved records only. 986 MB, Apache-2.0.',
    example: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  },
  voice: {
    title: 'Shruti voice model',
    detail: 'Udgam Shruti .cact model. Hindi, Hinglish and Indian English speech-to-text.',
    example: 'shruti.cact',
  },
  vision: {
    title: 'Mirage vision model',
    detail: 'Cactus Mirage .cact model. Describes visible text, labels and hazards.',
    example: 'mirage.cact',
  },
};
