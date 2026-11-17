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

import { planAssistantRequest, runAssistant, type AssistantOptions } from '../src/core/ai/assistant';
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

const GOOD_ANSWER =
  'Put a cloth or clean pad directly on the wound and press down hard with both hands. ' +
  'If blood soaks through, add another pad on top and keep pressing.';

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
      expect(outcome.text).toContain('does not contain enough information');
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
  test('withTimeout resolves, and rejects on the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow();
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
    expect(cleanModelText('---\n### Answer\nPress hard.')).toBe('Press hard.');
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
