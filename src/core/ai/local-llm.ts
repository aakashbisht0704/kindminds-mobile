/**
 * On-device LLM adapter (generation layer).
 *
 * This file knows how to run one bounded completion and tidy its text. It knows
 * nothing about first aid: prompts live in `prompts.ts`, validation in
 * `validation.ts`, and the interaction modes in `assistant.ts`. That split is
 * what keeps the unsafe path (a model deciding medical content) impossible to
 * reach by accident.
 *
 * The native binding is injected rather than imported, so this module stays
 * pure TypeScript and testable without a device.
 */

import type { KnowledgeEntry } from '../knowledge';

export type GenerationMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type GenerationRequest = {
  messages: GenerationMessage[];
  maxTokens: number;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  stopSequences: readonly string[];
  /** Hard deadline for the whole generation. */
  timeoutMs: number;
  /** Optional stream hook, so the UI can show text while it is written. */
  onToken?: (partial: string) => void;
};

/** Measured throughput of the loaded model on this device. */
export type RuntimeSpeed = {
  prefillTps: number;
  decodeTps: number;
};

export type TokenStream = AsyncIterable<string>;

/** What a llama.cpp / MediaPipe LLM Inference binding must provide. */
export type LocalModelBackend = {
  isReady(): Promise<boolean>;
  loadModel(path: string): Promise<void>;
  generate(request: GenerationRequest): TokenStream;
  unload(): Promise<void>;
  /** Abandon the current generation, if the runtime supports it. */
  stop?(): void;
  /** Last measured throughput, used to size the next deadline. */
  speed?(): RuntimeSpeed | null;
};

const MAX_ANSWER_CHARS = 900;

export type GenerationOutcome = {
  /** Raw model text; validation happens before anything is shown. */
  text: string;
  timedOut: boolean;
};

/**
 * Run one completion to completion or to its deadline. Always resolves.
 * On timeout the backend is cancelled, so the llama context is not left busy
 * for the next request.
 */
export async function generateText(
  backend: LocalModelBackend,
  request: GenerationRequest,
): Promise<GenerationOutcome> {
  if (!(await backend.isReady())) return { text: '', timedOut: false };

  const chunks: string[] = [];
  const stream = backend.generate(request);
  const collect = (async () => {
    for await (const token of stream) {
      chunks.push(token);
      const partial = chunks.join('');
      if (request.onToken) request.onToken(trimDanglingSentence(dropRepeatedTail(cleanModelText(partial))));
      if (partial.length > MAX_ANSWER_CHARS) break;
    }
    return chunks.join('').trim();
  })();

  const text = await withTimeout(collect, request.timeoutMs, () => backend.stop?.());
  if (text === null) return { text: chunks.join('').trim(), timedOut: true };
  return { text, timedOut: false };
}

/**
 * A response is only shown if it shares vocabulary with the source record. This
 * catches a model that wanders into advice nobody approved, which is the one
 * failure mode that could actually hurt someone. The multi-record version used
 * by the assistant lives in `validation.ts`.
 */
export function isGrounded(response: string, entry: KnowledgeEntry): boolean {
  const words = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 3),
    );

  const responseWords = words(response);
  if (responseWords.size === 0) return false;

  const sourceWords = words([entry.summary, ...entry.steps.map((step) => step.text)].join(' '));
  let overlap = 0;
  for (const word of responseWords) if (sourceWords.has(word)) overlap += 1;
  const ratio = overlap / Math.min(responseWords.size, 40);

  // Any of the banned-numeric patterns (doses) also disqualifies the output.
  const hasDose = /\b\d+\s?(mg|ml|milligrams?|tablets?|pills?)\b/i.test(response);
  return ratio >= 0.18 && !hasDose;
}

/** Rough guard so a runaway sampler cannot pin the CPU and drain the battery. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // A backend that cannot be cancelled is left to finish on its own.
      }
      resolve(null);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Small models decorate their replies: `---` rules, `###` headings, and the
 * leftovers of their chat template. None of that belongs on a calm safety card.
 * The validator rejects the serious artefacts before this runs; this only
 * normalises whitespace and stray markers in text that already passed.
 */
export function cleanModelText(text: string): string {
  const withoutTokens = text
    // Chat-template control tokens, then a role name left bare without them.
    .replace(/<\|[^|>]*\|>/g, ' ')
    .replace(/^\s*(?:assistant|system|user)\s*[:\n]\s*/i, '')
    .replace(/<\/?(?:think|thinking|analysis|reasoning|answer|response)>/gi, ' ');
  return withoutTokens
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s*/, ''))
    .filter((line) => /[A-Za-z0-9\u0900-\u097F]/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A 2B model can settle into a loop and print the same sentences again. Stop at
 * the first sentence it repeats.
 */
export function dropRepeatedTail(text: string): string {
  const lines = text.split(/(?<=[.!?।])\s+/).filter((sentence) => sentence.length > 0);
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const sentence = lines[index] ?? '';
    const key = sentence.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();
    if (key.length === 0) continue;
    if (seen.has(key)) return lines.slice(0, index).join(' ').trim();
    seen.add(key);
  }
  return text;
}

/**
 * The token cap can cut the last sentence in half, which reads as a fault on a
 * card that is supposed to be calm. Keep whole sentences only.
 */
export function trimDanglingSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  if (/[.!?।]$/.test(trimmed)) return trimmed;
  const end = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
    trimmed.lastIndexOf('।'),
  );
  return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
}
