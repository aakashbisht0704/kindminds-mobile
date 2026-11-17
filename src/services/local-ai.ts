/**
 * Process-wide access to the native model runtimes.
 *
 * - Bonsai 2 2B: GGUF through llama.rn (question answering from the records)
 * - Shruti: `.cact` through the native Cactus 4.1 bridge (speech-to-text)
 * - Mirage: `.cact` through the native Cactus 4.1 bridge (vision)
 *
 * A missing native module or model file is a normal state, not a crash: callers
 * get `null` and fall back to the approved offline record.
 */

import { runAssistant, type AssistantOptions, type AssistantOutcome } from '../core/ai/assistant';
import { LlamaBackend, type LlamaBackendConfig } from '../core/ai/llama-backend';
import { MirageBackend, ShrutiBackend } from '../core/ai/cactus-backend';
import { listModels, type LocalModel } from './model-pack';

let llama: LlamaBackend | null = null;
let shruti: ShrutiBackend | null = null;
let mirage: MirageBackend | null = null;

export function llamaBackend(): LlamaBackend {
  if (!llama) llama = new LlamaBackend();
  return llama;
}

export function shrutiBackend(): ShrutiBackend {
  if (!shruti) shruti = new ShrutiBackend();
  return shruti;
}

export function mirageBackend(): MirageBackend {
  if (!mirage) mirage = new MirageBackend();
  return mirage;
}

export type LoadedTextModel = { backend: LlamaBackend; model: LocalModel };
export type LoadedVoiceModel = { backend: ShrutiBackend; model: LocalModel };
export type LoadedVisionModel = { backend: MirageBackend; model: LocalModel };

function prefer(models: LocalModel[], kind: LocalModel['kind'], needle: string): LocalModel | null {
  // Prefer the known filename even if an old manifest mislabelled its kind.
  return (
    models.find((model) => model.name.toLowerCase().includes(needle)) ??
    models.find((model) => model.kind === kind) ??
    null
  );
}

export async function loadTextModel(): Promise<LoadedTextModel | null> {
  const models = await listModels();
  // Bonsai 2 is the shipped text model; a Woof file from an older install still
  // works if it is the only text model on the device.
  const model = prefer(models, 'text', 'bonsai') ?? prefer(models, 'text', 'woof');
  if (!model) return null;
  const backend = llamaBackend();
  await backend.loadModel(model.uri);
  return { backend, model };
}

export async function loadVoiceModel(): Promise<LoadedVoiceModel | null> {
  const models = await listModels();
  const model = prefer(models, 'voice', 'shruti');
  if (!model) return null;
  const backend = shrutiBackend();
  await backend.loadModel(model.uri);
  return { backend, model };
}

export async function loadVisionModel(): Promise<LoadedVisionModel | null> {
  const models = await listModels();
  const model = prefer(models, 'vision', 'mirage');
  if (!model) return null;
  const backend = mirageBackend();
  await backend.loadModel(model.uri);
  return { backend, model };
}

/** How long the text model may sit idle in RAM before it is released. */
const TEXT_MODEL_IDLE_UNLOAD_MS = 5 * 60 * 1000;

let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleUnload(): void {
  if (idleUnloadTimer) clearTimeout(idleUnloadTimer);
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    // Only the LLM is released here; the small Cactus models stay warm.
    void llama?.unload();
    llama = null;
  }, TEXT_MODEL_IDLE_UNLOAD_MS);
}

/** Runtime tuning for benchmarks; the shipped defaults live in llama-backend. */
export function configureTextRuntime(config: Partial<LlamaBackendConfig>): void {
  llama = new LlamaBackend(config);
}

/**
 * Run one assistant request against the approved knowledge base.
 *
 * Returns a structured outcome: an answer, a fallback that keeps the approved
 * record (with the reason), or an unsupported-question message. It never throws
 * and never answers from model memory.
 */
export async function assistQuery(
  query: string,
  options: AssistantOptions = {},
): Promise<AssistantOutcome> {
  let loaded: LoadedTextModel | null = null;
  try {
    loaded = await loadTextModel();
  } catch (error) {
    console.warn('[KindMinds] Bonsai could not start', error);
    loaded = null;
  }
  armIdleUnload();
  const outcome = await runAssistant(loaded?.backend ?? null, { query, options });
  armIdleUnload();
  return outcome;
}

const IMAGE_PROMPT = [
  'You are an offline disaster assistant looking at a photo on the user\'s phone.',
  'Describe only what is visible: any text, labels, signs, objects, and immediate hazards.',
  'Do not diagnose injuries. Do not recommend treatment. Do not invent details.',
  'If the image is unclear, say that plainly.',
  'Keep the answer under four short sentences.',
].join(' ');

/** Describe a photo with Mirage. This is a description, not a diagnosis. */
export async function describeImage(imageUri: string): Promise<string | null> {
  let loaded: LoadedVisionModel | null;
  try {
    loaded = await loadVisionModel();
  } catch (error) {
    console.warn('[KindMinds] Mirage could not start', error);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The Mirage vision model could not start on this phone. ${detail}`);
  }
  if (!loaded) {
    throw new Error('The Mirage vision model is not installed. Open Prepare → Shruti + Mirage to install it.');
  }
  try {
    const text = await loaded.backend.describe(imageUri, IMAGE_PROMPT);
    return text.length > 0 ? text : null;
  } catch (error) {
    console.warn('[KindMinds] Mirage description failed', error);
    throw new Error('The vision model could not read that image. Try a brighter, closer photo.');
  }
}

/**
 * Transcribe a PCM WAV recorded by this app with Shruti.
 *
 * Returns an empty string only when the model genuinely heard no speech.
 * Missing or broken models throw, so the UI can say what actually went wrong
 * instead of blaming the microphone.
 */
export async function transcribeVoice(filePath: string): Promise<string> {
  let loaded: LoadedVoiceModel | null;
  try {
    loaded = await loadVoiceModel();
  } catch (error) {
    console.warn('[KindMinds] Shruti could not start', error);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`The Shruti voice model could not start on this phone. ${detail}`);
  }
  if (!loaded) {
    throw new Error('The Shruti voice model is not installed. Open Prepare → Shruti + Mirage to install it.');
  }
  try {
    const text = await loaded.backend.transcribe(filePath);
    return text.trim();
  } catch (error) {
    console.warn('[KindMinds] Shruti transcription failed', error);
    throw new Error('The voice model could not read that recording. Try again, speaking a little longer.');
  }
}

export async function releaseLocalModels(): Promise<void> {
  await Promise.all([llama?.unload(), shruti?.release(), mirage?.release()]);
  llama = null;
  shruti = null;
  mirage = null;
}
