/**
 * Output validation for the offline assistant.
 *
 * These checks are rejection heuristics, not a proof of safety. They exist to
 * make one thing true: a generated answer is shown only when it is provably
 * built from the approved records in front of it. Anything else falls back to
 * the approved record itself, which is always correct by construction.
 *
 * Checks run on the raw model output, before any cosmetic cleaning, so that
 * reasoning traces and template artefacts are rejected rather than hidden.
 */

import type { KnowledgeEntry } from '../knowledge';
import { cleanModelText, dropRepeatedTail, trimDanglingSentence } from './local-llm';
import { maxSentencesFor, type AnswerLanguage, type AssistantMode } from './prompts';
import { stem, tokenize } from './retrieval';
import { containsUnsafeAdvice } from './safety';

export type ValidationFailure =
  | 'empty'
  | 'too_long'
  | 'too_many_sentences'
  | 'reasoning_marker'
  | 'repetition'
  | 'language_mismatch'
  | 'ungrounded'
  | 'unsafe_advice'
  | 'new_number'
  | 'missing_step'
  | 'step_order'
  | 'new_action'
  | 'template_artifact';

export type ValidationOutcome =
  | { ok: true; text: string }
  | { ok: false; failure: ValidationFailure; detail?: string };

/** Visible traces of the model's own scaffolding, never acceptable on screen. */
const MARKERS: readonly RegExp[] = [
  /<\|im_(?:start|end)\|>/i,
  /<\s*\/?\s*(?:think|thinking|reasoning|analysis)\s*>/i,
  /\b(?:as an ai|i am an ai|i'm an ai|disclaimer)\b/i,
  // Reasoning preambles this checkpoint produces when it ignores
  // enable_thinking=false. They are rejected, never silently stripped.
  /\bthinking process\b/i,
  /\banaly[sz]e (?:the|the provided) (?:request|question|records)\b/i,
  /^\s*(?:reasoning|thoughts?|analysis)\s*:/im,
  /^(?:assistant|system|user)\s*:/im,
  /^(?:note|n\.b\.|important note)\s*:/im,
];

const TEMPLATE_ARTIFACTS: readonly RegExp[] = [
  /^\s*#{1,6}\s+\S/m,
  /^\s*(?:-{3,}|\*{3,}|={3,})\s*$/m,
  /^\s*-\s*$/m,
];

/**
 * Procedures and medicines that must never appear unless the approved record
 * already contains them. A 2B model asked about a wound will happily invent
 * "apply an antibiotic ointment"; this catches that.
 */
const RISKY_TERMS: readonly string[] = [
  'antibiotic',
  'antibiotics',
  'antiseptic',
  'paracetamol',
  'ibuprofen',
  'aspirin',
  'morphine',
  'tramadol',
  'inject',
  'injection',
  'intravenous',
  'suture',
  'stitch',
  'stitches',
  'amputat',
  'defibrillat',
  'prescription',
  'dressing',
  'bandage',
];

const WORD = /[\p{L}\p{N}]+/gu;
const DEVANAGARI = /\p{Script=Devanagari}/u;

/**
 * A leading list marker is formatting, not a sentence and not a fact.
 *
 * The model enumerates short imperative steps ("1. Cool the burn.\n2. Cover...")
 * because the prompt asks for one sentence per approved step. Counting those
 * digits as sentence terminators doubled the sentence count and rejected
 * otherwise perfect answers (measured: "how to treat heat stroke" and "panic
 * attack" in the four-mode batch). The same digits would also trip the
 * new-number check, so they are removed once, before both checks, while the
 * text the person finally sees keeps its numbering.
 */
function withoutListMarkers(text: string): string {
  return text.replace(/^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+/gm, '');
}

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function normalizedNumbers(text: string): Set<string> {
  const matches = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return new Set(matches.map((value) => value.replace(',', '.').replace(/^0+(?=\d)/, '')));
}

function recordText(record: KnowledgeEntry): string {
  return [
    record.title,
    record.summary,
    ...record.steps.map((step) => step.text),
    ...record.never,
  ].join(' ');
}

/** Devanagari share of the letters, used to check the answer's language. */
function scriptMix(text: string): { devanagari: number; latin: number } {
  let devanagari = 0;
  let latin = 0;
  for (const character of text) {
    if (DEVANAGARI.test(character)) devanagari += 1;
    else if (/[A-Za-z]/.test(character)) latin += 1;
  }
  return { devanagari, latin };
}

function languageFailure(text: string, language: AnswerLanguage): boolean {
  const { devanagari, latin } = scriptMix(text);
  const letters = devanagari + latin;
  if (letters === 0) return true;
  const share = devanagari / letters;
  if (language === 'hi') return share < 0.6;
  // Hinglish and English both use Latin script; Hinglish may keep a word or two
  // of Devanagari if the person wrote it that way, but not whole sentences.
  return share > 0.15;
}

/**
 * Terms that identify one step and do not appear in any other step of the same
 * record. Those are what proves a step survived a paraphrase.
 */
function distinctiveTerms(step: string, otherSteps: readonly string[]): string[] {
  const own = [...new Set(tokenize(step))].filter((token) => token.length >= 4);
  if (own.length === 0) return [...new Set(tokenize(step))];
  const others = new Set(otherSteps.flatMap((other) => tokenize(other)));
  const unique = own.filter((token) => !others.has(token));
  return unique.length > 0 ? unique : own;
}

/**
 * Where a step's evidence starts, searching forward from `from`.
 *
 * Searching forward matters: a later step's words often appear earlier in the
 * answer as part of an earlier step. Recorded example: the CPR answer said
 * "check for normal breathing" for step 2 and "rescue breaths" for step 6, and
 * a whole-answer scan matched step 6 to the word in step 2 and reported the
 * answer as out of order. Steps must be found in sequence, so each search
 * starts after the previous match.
 */
function firstPosition(tokens: readonly string[], needles: readonly string[], from = 0): number {
  for (let index = Math.max(0, from); index < tokens.length; index += 1) {
    if (needles.includes(tokens[index] as string)) {
      return index;
    }
  }
  return -1;
}

export type ValidateInput = {
  mode: AssistantMode;
  raw: string;
  records: readonly KnowledgeEntry[];
  language: AnswerLanguage;
  /** 1-based step for CLARIFY; when set only that step must survive. */
  stepIndex?: number;
};

/**
 * Returns the display text on success. A failure carries the first rule that
 * rejected the answer, which is logged for development and shown to the user as
 * a plain-language fallback reason.
 */
export function validateAnswer(input: ValidateInput): ValidationOutcome {
  const { mode, raw, records, language, stepIndex } = input;
  if (records.length === 0) return { ok: false, failure: 'ungrounded' };

  if (MARKERS.some((pattern) => pattern.test(raw))) {
    return { ok: false, failure: 'reasoning_marker' };
  }
  if (TEMPLATE_ARTIFACTS.some((pattern) => pattern.test(raw))) {
    return { ok: false, failure: 'template_artifact' };
  }

  const cleaned = trimDanglingSentence(cleanModelText(raw));
  if (cleaned.length === 0) return { ok: false, failure: 'empty' };
  if (cleaned.length > 1200) return { ok: false, failure: 'too_long' };

  if (dropRepeatedTail(cleaned) !== cleaned) {
    return { ok: false, failure: 'repetition' };
  }

  // A REPHRASE must keep every step, so its sentence allowance has to scale with
  // the record; a fixed cap would make long records impossible to pass.
  const sentenceAllowance =
    mode === 'REPHRASE'
      ? Math.max(maxSentencesFor(mode), (records[0]?.steps.length ?? 0) + 2)
      : maxSentencesFor(mode);
  const sentenceCount = sentences(withoutListMarkers(cleaned)).length;
  if (sentenceCount > sentenceAllowance) {
    return { ok: false, failure: 'too_many_sentences', detail: `${sentenceCount} sentences` };
  }

  if (languageFailure(cleaned, language)) {
    return { ok: false, failure: 'language_mismatch' };
  }

  const sourceText = records.map(recordText).join(' ');
  const allowedNumbers = normalizedNumbers(sourceText);
  const usedNumbers = normalizedNumbers(withoutListMarkers(cleaned));
  for (const value of usedNumbers) {
    if (!allowedNumbers.has(value)) {
      return { ok: false, failure: 'new_number', detail: value };
    }
  }

  const sourceLower = sourceText.toLowerCase();
  const answerLower = cleaned.toLowerCase();
  for (const term of RISKY_TERMS) {
    if (answerLower.includes(term) && !sourceLower.includes(term)) {
      return { ok: false, failure: 'new_action', detail: term };
    }
  }

  if (containsUnsafeAdvice(cleaned)) {
    return { ok: false, failure: 'unsafe_advice' };
  }

  // Vocabulary floor: a reply that wanders away from the record is discarded
  // even if it contains no banned words.
  const answerTerms = new Set(tokenize(cleaned));
  const sourceTerms = new Set(tokenize(sourceText));
  if (answerTerms.size === 0) return { ok: false, failure: 'ungrounded' };
  let overlap = 0;
  for (const term of answerTerms) if (sourceTerms.has(term)) overlap += 1;
  const overlapRatio = overlap / answerTerms.size;
  const needed = mode === 'REPHRASE' ? 0.45 : 0.3;
  if (overlapRatio < needed) return { ok: false, failure: 'ungrounded' };

  // Step survival. Rephrasing must keep every step, in order; answers and
  // situation guidance only need the steps they actually use, still in order.
  const primary = mode === 'CLARIFY' && stepIndex ? null : records[0];
  const checkedRecord = primary ?? records[0];
  if (checkedRecord) {
    const allStepTexts = checkedRecord.steps.map((step) => step.text);
    const answerTokens = words(cleaned).map((word) => stem(word.toLowerCase()));
    const targets = stepIndex
      ? [checkedRecord.steps[stepIndex - 1]].filter(Boolean)
      : checkedRecord.steps;

    let previous = -1;
    let found = 0;
    for (const step of targets) {
      if (!step) continue;
      const others = allStepTexts.filter((text) => text !== step.text);
      const needles = distinctiveTerms(step.text, others);
      const position = firstPosition(answerTokens, needles, previous + 1);
      if (position < 0) continue;
      found += 1;
      if (position <= previous) return { ok: false, failure: 'step_order', detail: step.text };
      previous = position;
    }

    const required = stepIndex ? 1 : mode === 'REPHRASE' ? targets.length : Math.ceil(targets.length * 0.4);
    if (found < required) {
      return { ok: false, failure: 'missing_step', detail: `${found}/${required}` };
    }
  }

  return { ok: true, text: cleaned };
}
