/**
 * Cactus 4.1 adapters for Shruti (speech-to-text) and Mirage (vision).
 *
 * Both models are single-file `.cact` archives. They are loaded through the
 * native `CactusEngine` bridge (see android/app/src/main/cpp/cactus_bridge.cpp)
 * rather than `cactus-react-native`, whose engine implements Whisper, Moonshine,
 * Parakeet and LFM2-VL but not the Whistle or Mirage architectures.
 */

import { CACTUS_SPEECH, CACTUS_VISION, cactusEngine } from '../../services/cactus-engine';

export class ShrutiBackend {
  private modelPath: string | null = null;

  async isReady(): Promise<boolean> {
    return this.modelPath !== null;
  }

  get loadedModelPath(): string | null {
    return this.modelPath;
  }

  async loadModel(path: string): Promise<void> {
    const capabilities = await cactusEngine.loadModel(path);
    if ((capabilities & CACTUS_SPEECH) === 0) {
      throw new Error('That file is not a Cactus speech model.');
    }
    this.modelPath = path;
  }

  async transcribe(filePath: string): Promise<string> {
    if (!this.modelPath) throw new Error('Shruti is not loaded.');
    // The native engine holds one model at a time. A vision request may have
    // swapped it, so make sure Shruti is current before transcribing.
    await cactusEngine.loadModel(this.modelPath);

    const raw = await cactusEngine.transcribe(filePath);
    const parsed = JSON.parse(raw) as { text?: string };
    const text = (parsed.text ?? '').trim();
    // Whisper-family models emit markers for silence; never insert those.
    if (/^[\[(](blank_audio|silence|music|applause|no speech)[\])]$/i.test(text)) return '';
    return text;
  }

  async release(): Promise<void> {
    this.modelPath = null;
  }
}

/**
 * Mirage returns a structured scene graph. Normalise the common shapes into
 * something a person can read in a hurry.
 */
export function summarizeMirage(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as {
      text?: string | { string?: string }[];
      objects?: (string | { name?: string })[];
      reasoning?: string;
      description?: string;
      caption?: string;
    };

    const parts: string[] = [];
    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      parts.push(parsed.text.trim());
    } else if (Array.isArray(parsed.text)) {
      const texts = parsed.text
        .map((item) => (typeof item === 'string' ? item : item.string))
        .filter((value): value is string => Boolean(value && value.trim()));
      if (texts.length > 0) parts.push(`Visible text: ${[...new Set(texts)].join('; ')}`);
    }

    if (typeof parsed.description === 'string' && parsed.description.trim()) {
      parts.push(parsed.description.trim());
    }
    if (typeof parsed.caption === 'string' && parsed.caption.trim()) {
      parts.push(parsed.caption.trim());
    }

    if (Array.isArray(parsed.objects)) {
      const objects = parsed.objects
        .map((item) => (typeof item === 'string' ? item : item.name))
        .filter((value): value is string => Boolean(value));
      if (objects.length > 0) {
        parts.push(`Objects: ${[...new Set(objects)].slice(0, 8).join(', ')}`);
      }
    }

    if (parts.length === 0 && parsed.reasoning) parts.push(parsed.reasoning);
    if (parts.length > 0) return parts.join('. ').slice(0, 700);
  } catch {
    // Plain-text response; return it below.
  }
  return raw.slice(0, 700);
}

export class MirageBackend {
  private modelPath: string | null = null;

  async isReady(): Promise<boolean> {
    return this.modelPath !== null;
  }

  get loadedModelPath(): string | null {
    return this.modelPath;
  }

  async loadModel(path: string): Promise<void> {
    const capabilities = await cactusEngine.loadModel(path);
    if ((capabilities & CACTUS_VISION) === 0) {
      throw new Error('That file is not a Cactus vision model.');
    }
    this.modelPath = path;
  }

  async describe(imagePath: string, _prompt: string): Promise<string> {
    if (!this.modelPath) throw new Error('Mirage is not loaded.');
    // The native engine holds one model at a time. A voice request may have
    // swapped it, so make sure Mirage is current before describing.
    await cactusEngine.loadModel(this.modelPath);

    // Mirage's 4.1 API takes a structured options object, not a free-form
    // prompt. Empty options asks for the model's normal scene description.
    const raw = await cactusEngine.describe(imagePath, '{}');
    return summarizeMirage(raw);
  }

  async release(): Promise<void> {
    this.modelPath = null;
  }
}
