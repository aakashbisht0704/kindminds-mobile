/**
 * Tests for the offline assistant pipeline: prompts, validation, routing and
 * the generate-and-check loop.
 *
 * The safety contract these tests pin down: a generated answer is shown only
 * when it is built from the approved record in front of it. Every other
 * outcome must fall back to the record itself, which is correct by
 * construction, and must never show a partial or invented instruction.
 */

import { describe, expect, test } from 'bun:test';

import {
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  estimateTimeout,
  planAssistantRequest,
  runAssistant,
  type AssistantOptions,
} from '../src/core/ai/assistant';
import {
  cleanModelText,
  dropRepeatedTail,
  generateText,
  isGrounded,
  trimDanglingSentence,
  withTimeout,
  type LocalModelBackend,
} from '../src/core/ai/local-llm';
import { buildSystemPrompt, buildUserPrompt, maxTokensFor, toPromptRecord } from '../src/core/ai/prompts';
import { validateAnswer } from '../src/core/ai/validation';
import { KNOWLEDGE_BY_ID } from '../src/core/knowledge';

const bleeding = KNOWLEDGE_BY_ID.get('bleeding');
if (!bleeding) throw new Error('test fixture missing: bleeding entry');

/**
 * A faithful rephrasing of the six-step bleeding record. REPHRASE must keep
 * every step, so a two-sentence stub would (correctly) be rejected.
 */
const GOOD_ANSWER =
  'Put a cloth or a clean pad straight on the wound. Press down hard with both hands. ' +
  'If blood soaks through, put another pad on top instead of removing the first. ' +
  'Lay the person flat and raise the hurt limb above heart level if you can. ' +
  'Keep pressing for at least 10 minutes before you look. ' +
  'If it still will not stop, press the artery above the wound with a finger.';

/** A backend that returns fixed text, optionally in several chunks. */
function backendWith(chunks: string[], ready = true): LocalModelBackend {
  return {
    isReady: async () => ready,
    loadModel: async () => {},
    unload: async () => {},
    generate: () =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
  };
}

function run(query: string, backend: LocalModelBackend | null, options?: AssistantOptions) {
  return runAssistant(backend, { query, options: { timeoutMs: 500, ...options } });
}

describe('prompt construction', () => {
  test('the system prompt carries the record-only contract and the mode task', () => {
    const prompt = buildSystemPrompt('QUESTION', 'en');
    expect(prompt).toContain('approved records');
    expect(prompt).toContain('Add nothing from your own knowledge');
    expect(prompt).toContain('Answer using only the approved records');
    expect(prompt).toContain('LANGUAGE: English');
  });

  test('each mode asks for something different', () => {
    const modes = ['REPHRASE', 'QUESTION', 'CLARIFY', 'SITUATION'] as const;
    const prompts = modes.map((mode) => buildSystemPrompt(mode, 'en'));
    expect(new Set(prompts).size).toBe(modes.length);
    expect(maxTokensFor('SITUATION')).toBeGreaterThan(maxTokensFor('CLARIFY'));
  });

  test('the user prompt renders the approved record in full', () => {
    const prompt = buildUserPrompt({
      mode: 'REPHRASE',
      question: 'heavy bleeding',
      records: [toPromptRecord(bleeding)],
    });
    expect(prompt).toContain(`TITLE: ${bleeding.title}`);
    for (const step of bleeding.steps) expect(prompt).toContain(step.text);
    for (const rule of bleeding.never) expect(prompt).toContain(rule);
    expect(prompt).toContain('<user_message>');
  });

  test('Hindi output asks for Devanagari and Hinglish for Latin script', () => {
    expect(buildSystemPrompt('QUESTION', 'hi')).toContain('Devanagari');
    expect(buildSystemPrompt('QUESTION', 'hinglish')).toContain('Hinglish');
  });
});

describe('deadline policy', () => {
  test('an unmeasured device gets the full cap, not a guess', () => {
    expect(estimateTimeout(2000, 140)).toBe(MAX_TIMEOUT_MS);
    expect(estimateTimeout(2000, 140, null)).toBe(MAX_TIMEOUT_MS);
  });

  test('a measured device gets a budget scaled to its own speed', () => {
    // 450 prompt tokens at 150 tok/s plus 140 tokens at 25 tok/s, with 1.5x headroom,
    // is under the 20 s floor; a 6 tok/s prefill device lands on the cap instead.
    const fast = estimateTimeout(1800, 140, { prefillTps: 150, decodeTps: 25 });
    const slow = estimateTimeout(1800, 140, { prefillTps: 6, decodeTps: 3 });
    expect(fast).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
    expect(fast).toBeLessThan(slow);
    expect(slow).toBe(MAX_TIMEOUT_MS);
  });

  test('the budget never drops below the product floor', () => {
    expect(estimateTimeout(10, 1, { prefillTps: 1000, decodeTps: 1000 })).toBe(MIN_TIMEOUT_MS);
  });
});

describe('validation', () => {
  const validate = (raw: string, mode: 'REPHRASE' | 'QUESTION' = 'REPHRASE') =>
    validateAnswer({ mode, raw, records: [bleeding], language: 'en' });

  test('accepts a faithful rephrasing that keeps the steps', () => {
    const outcome = validate(GOOD_ANSWER);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.text).toBe(GOOD_ANSWER);
  });

  test('rejects a reasoning trace instead of hiding it', () => {
    const outcome = validate(`Thinking Process:\n1. Analyse the request.\n\n${GOOD_ANSWER}`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('reasoning_marker');
  });

  test('rejects template artefacts such as headings and empty bullets', () => {
    const outcome = validate(`### Answer\n- \n${GOOD_ANSWER}`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('template_artifact');
  });

  test('rejects a dose that is not in the approved record', () => {
    const outcome = validate('Press hard on the wound and give 500 mg of paracetamol.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['unsafe_advice', 'new_number']).toContain(outcome.failure);
  });

  test('rejects an answer that abandons the approved steps', () => {
    const outcome = validate('Stay calm and rest. Everything will be fine soon.');
    expect(outcome.ok).toBe(false);
  });

  test('rejects an empty answer', () => {
    const outcome = validate('   ');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure).toBe('empty');
  });

  // Measured against the online model: the prompt requires the approved warnings
  // to be kept, and the bleeding record's two `never` rules are rendered into the
  // prompt like its steps. Counting only steps rejected a reply that kept all six
  // steps and both warnings, because the model also named the record on a lead
  // line. The sentence ceiling has to cover the warnings it is asked to keep.
  test('accepts a reply that keeps every step and every approved warning', () => {
    const withWarnings = [
      `Severe bleeding`,
      GOOD_ANSWER,
      ...bleeding.never.map((rule) => `- ${rule}`),
    ].join('\n');

    const outcome = validate(withWarnings);
    expect(outcome.ok).toBe(true);
  });

  // Measured false rejection: the model numbered its steps, the sentence counter
  // counted each "1." as a sentence, and two good in-app answers were thrown
  // away. List markers are formatting and must not count as sentences.
  test('accepts a numbered list that keeps every approved step in order', () => {
    const numbered = GOOD_ANSWER.split(/(?<=\.)\s+/)
      .map((sentence, index) => `${index + 1}. ${sentence}`)
      .join('\n');
    const outcome = validate(numbered);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.text).toContain('1.');
  });

  test('a numbered list still cannot smuggle in a new number', () => {
    const outcome = validate('1. Press down hard on the wound with both hands for 500 minutes.');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['new_number', 'missing_step']).toContain(outcome.failure);
  });

  test('stops rejecting a three-item numbered answer for sentence count', () => {
    const answer =
      '1. Put a cloth or a clean pad straight on the wound.\n' +
      '2. Press down hard with both hands.\n' +
      '3. Keep pressing for at least 10 minutes before you look.';
    const outcome = validateAnswer({ mode: 'QUESTION', raw: answer, records: [bleeding], language: 'en' });
    if (!outcome.ok) expect(outcome.failure).not.toBe('too_many_sentences');
  });

  test('a CLARIFY answer may name the step it explains', () => {
    const answer = 'Step 3 means if blood soaks through, add another pad on top and do not remove the first one.';
    const outcome = validateAnswer({ mode: 'CLARIFY', raw: answer, records: [bleeding], language: 'en', stepIndex: 3 });
    expect(outcome.ok).toBe(true);
  });

  test('a CLARIFY answer still cannot invent a number', () => {
    const answer = 'Step 3 means press down hard and give 500 mg of paracetamol.';
    const outcome = validateAnswer({ mode: 'CLARIFY', raw: answer, records: [bleeding], language: 'en', stepIndex: 3 });
    expect(outcome.ok).toBe(false);
  });

  // Measured false rejection: "rescue breaths" (step 6) was matched to the word
  // "breathing" in step 2, so a correctly ordered CPR answer was reported as
  // out of order. Each step is now searched for after the previous one.
  test('accepts a CPR answer whose later steps reuse an earlier step word', () => {
    const cpr = KNOWLEDGE_BY_ID.get('cpr');
    if (!cpr) throw new Error('test fixture missing: cpr entry');
    const answer =
      'Shout for help and tap their shoulders. Tilt the head back and check for normal breathing for 10 seconds. ' +
      'Place the heel of your hand on the centre of the chest and push hard and fast, 100 to 120 times a minute. ' +
      'Let the chest come all the way back up between pushes. If trained, give 2 rescue breaths after every 30 compressions.';
    const outcome = validateAnswer({ mode: 'SITUATION', raw: answer, records: [cpr], language: 'en' });
    expect(outcome.ok).toBe(true);
  });

  test('still rejects CPR steps given in the wrong order', () => {
    const cpr = KNOWLEDGE_BY_ID.get('cpr');
    if (!cpr) throw new Error('test fixture missing: cpr entry');
    const scrambled =
      'If trained, give 2 rescue breaths after every 30 compressions. ' +
      'Shout for help and tap their shoulders. Tilt the head back and check for normal breathing for 10 seconds.';
    const outcome = validateAnswer({ mode: 'SITUATION', raw: scrambled, records: [cpr], language: 'en' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['step_order', 'missing_step']).toContain(outcome.failure);
  });
});

describe('assistant outcomes', () => {
  test('shows a validated model answer with its provenance', async () => {
    const outcome = await run('heavy bleeding', backendWith([GOOD_ANSWER]), { mode: 'REPHRASE' });
    expect(outcome.kind).toBe('answer');
    if (outcome.kind === 'answer') {
      expect(outcome.provenance).toBe('model');
      expect(outcome.primary.id).toBe('bleeding');
      expect(outcome.text).toContain('clean pad');
    }
  });

  test('falls back to the record when no model is installed', async () => {
    const outcome = await run('heavy bleeding', null);
    expect(outcome.kind).toBe('fallback');
    if (outcome.kind === 'fallback') {
      expect(outcome.reason).toBe('no_model');
      // An empty text keeps the approved record visible instead of replacing it.
      expect(outcome.text).toBe('');
      expect(outcome.primary.id).toBe('bleeding');
    }
  });

  test('falls back when the model output fails validation', async () => {
    const outcome = await run('heavy bleeding', backendWith(['Take two tablets every four hours.']), {
      mode: 'REPHRASE',
    });
    expect(outcome.kind).toBe('fallback');
    if (outcome.kind === 'fallback') expect(outcome.reason).toBe('rejected');
  });

  test('reports a timeout separately from a rejection', async () => {
    const silent: LocalModelBackend = {
      isReady: async () => true,
      loadModel: async () => {},
      unload: async () => {},
      generate: () => (async function* () {
        await new Promise(() => {});
      })(),
    };
    const outcome = await run('heavy bleeding', silent, { timeoutMs: 20 });
    expect(outcome.kind).toBe('fallback');
    if (outcome.kind === 'fallback') expect(outcome.reason).toBe('timeout');
  });

  test('a question with no matching record is refused without guessing', async () => {
    const outcome = await run('how do I repair a diesel generator injector pump', backendWith([GOOD_ANSWER]));
    expect(outcome.kind).toBe('unsupported');
    if (outcome.kind === 'unsupported') {
      expect(outcome.provenance).toBe('none');
      // The refusal still refuses, but it names what the records do cover so the
      // person has somewhere to go instead of a dead end.
      expect(outcome.text).toContain('will not guess');
      expect(outcome.text).toContain('bleeding');
      expect(outcome.text).toContain('SOS');
      // Nothing generated is shown when retrieval found no record.
      expect(outcome.text).not.toContain('clean pad');
    }
  });

  test('everyday words still reach the right record', () => {
    // People do not type the knowledge base's vocabulary; these all refused
    // before prefix matching and the synonym table existed.
    const cases: [string, string][] = [
      ['I am thirsty', 'water'],
      ['my hand is cut', 'bleeding'],
      ['someone fainted', 'shock'],
      ['I am hungry', 'food'],
      ['my kid is scared', 'children'],
      ['trapped in rubble', 'earthquake'],
      ['phone is dying', 'power'],
    ];
    for (const [query, expected] of cases) {
      const plan = planAssistantRequest(query, {});
      expect(plan.kind).toBe('planned');
      if (plan.kind === 'planned') {
        const ids: string[] = plan.sources.map((entry) => entry.id);
        expect(ids).toContain(expected);
      }
    }
  });
});

describe('routing and retrieval', () => {
  test('a record tap is pinned as the source for a rephrase', () => {
    const plan = planAssistantRequest('explain this', { mode: 'REPHRASE', sourceId: 'burns' });
    expect(plan.kind).toBe('planned');
    if (plan.kind === 'planned') {
      expect(plan.mode).toBe('REPHRASE');
      expect(plan.primary.id).toBe('burns');
    }
  });

  test('step questions become a CLARIFY request for that step', () => {
    const plan = planAssistantRequest('what does step 2 mean', { sourceId: 'bleeding' });
    expect(plan.kind).toBe('planned');
    if (plan.kind === 'planned') {
      expect(plan.mode).toBe('CLARIFY');
      expect(plan.stepIndex).toBe(2);
    }
  });

  test('a described situation routes to SITUATION with several sources', () => {
    const plan = planAssistantRequest('the flood water is rising and we are on the roof');
    expect(plan.kind).toBe('planned');
    if (plan.kind === 'planned') {
      expect(plan.mode).toBe('SITUATION');
      expect(plan.sources.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('Devanagari and Hinglish questions both find the bleeding record', () => {
    for (const query of ['खून बहुत बह रहा है', 'khoon band nahi ho raha']) {
      const plan = planAssistantRequest(query);
      expect(plan.kind).toBe('planned');
      if (plan.kind === 'planned') {
        expect(plan.language).not.toBe('en');
        expect(plan.sources[0]?.id).toBe('bleeding');
      }
    }
  });
});

describe('generation helpers', () => {
  test('withTimeout resolves, and reports a deadline as null', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
    // The timeout is a value, not an exception: callers must handle it as a
    // normal outcome (fall back to the record) and never crash the card.
    await expect(withTimeout(new Promise(() => {}), 10)).resolves.toBeNull();
  });

  test('generateText always resolves and reports a timeout', async () => {
    const silent: LocalModelBackend = {
      isReady: async () => true,
      loadModel: async () => {},
      unload: async () => {},
      generate: () => (async function* () {
        await new Promise(() => {});
      })(),
    };
    const outcome = await generateText(silent, {
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
      temperature: 0.2,
      topP: 0.85,
      topK: 20,
      repeatPenalty: 1.1,
      stopSequences: [],
      timeoutMs: 20,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.text).toBe('');
  });

  test('cleaning strips chat-template leftovers', () => {
    expect(cleanModelText('<|im_start|>assistant\nPress hard.')).toBe('Press hard.');
    // Validation rejects headings outright; cleaning only normalises text that
    // already passed, so it strips the hashes and keeps the words.
    expect(cleanModelText('---\n### Answer\nPress hard.')).toBe('Answer\nPress hard.');
    expect(dropRepeatedTail('Press hard on the wound. Press hard on the wound.')).toBe(
      'Press hard on the wound.',
    );
    expect(trimDanglingSentence('Press hard on the wound. If blood soaks')).toBe(
      'Press hard on the wound.',
    );
  });

  test('legacy grounding still recognises record vocabulary', () => {
    expect(isGrounded(GOOD_ANSWER, bleeding)).toBe(true);
    expect(isGrounded('You should probably just relax and rest.', bleeding)).toBe(false);
  });
});
