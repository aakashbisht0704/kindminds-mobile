/**
 * The offline knowledge assistant.
 *
 * One request = deterministic retrieval + one bounded completion + hard
 * validation. The model is a language interface to the approved records: it can
 * explain, answer, clarify or apply them, but every fact it is allowed to use is
 * rendered into the prompt, and every answer is checked against those records
 * before a single word reaches the screen.
 */

import type { KnowledgeEntry, TopicId } from '../knowledge';
import { generateText, type LocalModelBackend } from './local-llm';
import {
  buildSystemPrompt,
  buildUserPrompt,
  maxTokensFor,
  stopSequences,
  toPromptRecord,
  unsupportedMessage,
  type AnswerLanguage,
  type AssistantMode,
} from './prompts';
import { search, findById, type SearchHit } from './retrieval';
import { validateAnswer, type ValidationFailure } from './validation';

export type FallbackReason = 'no_model' | 'timeout' | 'rejected';

export type AssistantOptions = {
  /** UI hint. When omitted the mode is inferred from the question. */
  mode?: AssistantMode;
  language?: AnswerLanguage | 'auto';
  /** Record the person tapped, used as the primary source. */
  sourceId?: TopicId;
  /** 1-based step for CLARIFY. */
  stepIndex?: number;
  history?: readonly { role: 'user' | 'assistant'; content: string }[];
  timeoutMs?: number;
  onToken?: (partial: string) => void;
};

export type AssistantOutcome =
  | {
      kind: 'answer';
      mode: AssistantMode;
      language: AnswerLanguage;
      text: string;
      provenance: 'model';
      /** Wall-clock time this answer took on this device, for the UI to show. */
      elapsedMs: number;
      primary: KnowledgeEntry;
      sources: KnowledgeEntry[];
    }
  | {
      kind: 'fallback';
      mode: AssistantMode;
      language: AnswerLanguage;
      /** Empty: the UI keeps showing the approved record, which is the safe answer. */
      text: '';
      provenance: 'record';
      reason: FallbackReason;
      detail?: ValidationFailure;
      primary: KnowledgeEntry;
      sources: KnowledgeEntry[];
    }
  | {
      kind: 'unsupported';
      mode: AssistantMode;
      language: AnswerLanguage;
      text: string;
      provenance: 'none';
      primary: null;
      sources: [];
    };

/**
 * Deadline policy.
 *
 * A fixed timeout is a guess, and a wrong guess is what makes a working model
 * look broken on a slow phone. The budget is therefore derived from the prompt
 * size and the throughput this device actually measured on its last answer,
 * with a floor and a cap so the card can never hang indefinitely. The first
 * answer on an unmeasured device gets the cap instead of an estimate: being
 * generous once is better than abandoning an answer that was about to arrive,
 * and it is the only way the device ever gets to measure itself.
 */
export const MIN_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Rough characters-per-token for English prose; only used to size the budget. */
const CHARS_PER_TOKEN = 4;

export function estimateTimeout(
  promptChars: number,
  maxTokens: number,
  measured?: { prefillTps: number; decodeTps: number } | null,
): number {
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);

  /**
   * First answer on an unmeasured device: spend the whole cap.
   *
   * The conservative defaults describe a mid-range phone, and when they are
   * wrong about slow hardware they are wrong in the worst possible way: the
   * answer is abandoned just before it would have arrived, and the device never
   * gets to measure itself because the measurement only lands on a completed
   * answer. Measured on the x86_64 emulator: a 450-token prompt was cut off at
   * the 48 s conservative budget, which is under a minute of extra patience for
   * an answer that does arrive. Only the first answer pays this; every later one
   * uses this device's own rates.
   */
  if (!measured || measured.prefillTps <= 0 || measured.decodeTps <= 0) {
    return MAX_TIMEOUT_MS;
  }

  const seconds = promptTokens / measured.prefillTps + maxTokens / measured.decodeTps;
  // 1.5x headroom: sampler variance and the first-token cost are real.
  const budget = seconds * 1500;
  return Math.round(Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, budget)));
}

/** Below this BM25 score a "match" is a coincidence, not a topic. */
const UNSUPPORTED_SCORE = 2.6;

const DEVANAGARI = /[\u0900-\u097F]/;

/** Words that only appear when someone is writing Hindi in Latin script. */
const HINGLISH_MARKERS = [
  'hai', 'hain', 'kya', 'kaise', 'kaisa', 'karo', 'karna', 'karna', 'kar', 'mujhe', 'mera', 'meri',
  'aap', 'tum', 'hum', 'nahi', 'nahin', 'paani', 'pani', 'madad', 'chahiye', 'bhai', 'theek',
  'thik', 'jaldi', 'abhi', 'yahan', 'wahan', 'ghaav', 'khoon', 'saans', 'dard', 'bachao', 'bacha',
  'matlab', 'iska', 'uska', 'kuch', 'bahut', 'zyada', 'kam', 'achha', 'acha', 'batao', 'bata',
  'samajh', 'padha', 'pehle', 'baad', 'wala', 'wali', 'hoga', 'hogi', 'gaya', 'gayi', 'raha', 'rahi',
];

export function detectLanguage(text: string, requested: AnswerLanguage | 'auto' = 'auto'): AnswerLanguage {
  if (requested !== 'auto') return requested;
  // An explicit request wins: "explain this in Hindi" is typed in English but
  // asks for Devanagari output.
  if (/hinglish/i.test(text)) return 'hinglish';
  if (/(?:in|into)\s+hindi|hindi\s+(?:mein|me|mai)|हिंदी|हिन्दी/i.test(text)) return 'hi';
  if (DEVANAGARI.test(text)) return 'hi';
  const lower = ` ${text.toLowerCase()} `;
  const hits = HINGLISH_MARKERS.filter((marker) => lower.includes(` ${marker} `)).length;
  return hits >= 1 ? 'hinglish' : 'en';
}

const STEP_QUERY = /\bstep\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*step\b|\bkadam\s*(\d{1,2})\b|\b(\d{1,2})\s*kadam\b/i;

const CLARIFY_HINT =
  /(what does|what do you mean|meaning of|means\b|explain|simpler|simple words|in plain|matlab|iska matlab|samjha|समझा|आसान|मतलब)/i;

// A SITUATION is the person describing what is happening to them, so the hints
// cover first-person surroundings and events in progress, not just "trapped".
const SITUATION_HINT =
  /(there is|there's|(?:i am|i'm|we are|we're)\s+(?:on|in|at|stuck|trapped|surrounded|running out|out of|under)|stuck|caught in|in my area|near me|nearby|someone is|someone near|surrounded|(?:is|are|keep|keeps)\s+(?:rising|coming up|spreading|getting worse|shaking)|just happened|started|घिर गए|फंस|यहाँ|yahan|paas|trapped|badh raha|aag lag)/i;

export function parseStepIndex(query: string): number | undefined {
  const match = STEP_QUERY.exec(query);
  if (!match) return undefined;
  const value = Number(match[1] ?? match[2] ?? match[3] ?? match[4]);
  return Number.isFinite(value) && value >= 1 && value <= 20 ? value : undefined;
}

/** Choose how to answer. Deterministic rules only: no model decides routing. */
export function routeMode(query: string, hasMatch: boolean, options: AssistantOptions = {}): AssistantMode {
  if (options.mode) return options.mode;
  if (options.stepIndex || parseStepIndex(query)) return 'CLARIFY';
  if (hasMatch && /(what does|meaning of|matlab|मतलब)/i.test(query)) return 'CLARIFY';
  if (hasMatch && CLARIFY_HINT.test(query)) return 'REPHRASE';
  if (hasMatch && SITUATION_HINT.test(query)) return 'SITUATION';
  return 'QUESTION';
}

function pickSources(mode: AssistantMode, hits: SearchHit[], options: AssistantOptions): KnowledgeEntry[] {
  if (mode === 'REPHRASE' || mode === 'CLARIFY') {
    const pinned = options.sourceId ? findById(options.sourceId) : undefined;
    const primary = pinned ?? hits[0]?.entry;
    return primary ? [primary] : [];
  }
  if (hits.length === 0) return [];
  const top = hits[0]?.score ?? 0;
  const keep = mode === 'SITUATION' ? 3 : 2;
  return hits
    .filter((hit, index) => index === 0 || hit.score >= top * 0.55)
    .slice(0, keep)
    .map((hit) => hit.entry);
}

export type RunAssistantInput = {
  query: string;
  options?: AssistantOptions;
};

/**
 * Answer one message. Never throws: a missing model, a slow model or a rejected
 * answer all become a fallback that keeps the approved record on screen.
 */
export type AssistantPlan =
  | { kind: 'unsupported'; mode: AssistantMode; language: AnswerLanguage; text: string }
  | {
      kind: 'planned';
      query: string;
      mode: AssistantMode;
      language: AnswerLanguage;
      primary: KnowledgeEntry;
      sources: KnowledgeEntry[];
      stepIndex?: number;
      system: string;
      user: string;
    };

/**
 * Retrieval, routing and prompt assembly in one place.
 *
 * Exported so the evaluation harness and the app build byte-identical prompts;
 * a benchmark that pokes at private helpers would not be evidence about this
 * pipeline.
 */
export function planAssistantRequest(query: string, options: AssistantOptions = {}): AssistantPlan {
  const trimmed = query.trim();
  const language = detectLanguage(trimmed, options.language ?? 'auto');

  const hits = trimmed.length > 0 ? search(trimmed, 3) : [];
  const mode = routeMode(trimmed, hits.length > 0, options);
  const sources = pickSources(mode, hits, options);
  const stepIndex = options.stepIndex ?? parseStepIndex(trimmed);

  if (sources.length === 0 || (hits[0]?.score ?? 0) < UNSUPPORTED_SCORE) {
    return { kind: 'unsupported', mode, language, text: unsupportedMessage(language) };
  }

  return {
    kind: 'planned',
    query: trimmed,
    mode,
    language,
    primary: sources[0] as KnowledgeEntry,
    sources,
    stepIndex,
    system: buildSystemPrompt(mode, language),
    user: buildUserPrompt({
      mode,
      question: trimmed,
      records: sources.map(toPromptRecord),
      stepIndex,
      history: options.history,
    }),
  };
}

export async function runAssistant(
  backend: LocalModelBackend | null,
  input: RunAssistantInput,
): Promise<AssistantOutcome> {
  const plan = planAssistantRequest(input.query, input.options ?? {});

  if (plan.kind === 'unsupported') {
    return {
      kind: 'unsupported',
      mode: plan.mode,
      language: plan.language,
      text: plan.text,
      provenance: 'none',
      primary: null,
      sources: [],
    };
  }

  const { mode, language, primary, sources, stepIndex, system, user } = plan;
  const options = input.options ?? {};
  const toFallback = (reason: FallbackReason, detail?: ValidationFailure): AssistantOutcome => {
    // The failure code is a non-sensitive diagnostic; the user's words are not
    // logged with it.
    console.warn('[KindMinds] answer not shown', { mode, reason, failure: detail ?? null });
    return {
      kind: 'fallback',
      mode,
      language,
      text: '',
      provenance: 'record',
      reason,
      detail,
      primary,
      sources,
    };
  };

  if (!backend) return toFallback('no_model');

  const maxTokens = maxTokensFor(mode);
  const timeoutMs =
    options.timeoutMs ??
    estimateTimeout(system.length + user.length, maxTokens, backend.speed?.() ?? null);

  const startedAt = Date.now();
  const { text, timedOut } = await generateText(backend, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxTokens,
    temperature: 0.2,
    topP: 0.85,
    topK: 20,
    repeatPenalty: 1.1,
    stopSequences: stopSequences(),
    timeoutMs,
    onToken: options.onToken,
  });

  if (timedOut) return toFallback('timeout');

  const validated = validateAnswer({ mode, raw: text, records: sources, language, stepIndex });
  if (!validated.ok) return toFallback('rejected', validated.failure);

  return {
    kind: 'answer',
    mode,
    language,
    text: validated.text,
    provenance: 'model',
    elapsedMs: Date.now() - startedAt,
    primary,
    sources,
  };
}
