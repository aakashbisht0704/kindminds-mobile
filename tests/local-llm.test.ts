/**
 * Guard tests for the on-device assistant.
 *
 * The model is allowed to rephrase an approved record and nothing else. These
 * tests pin the two failure modes that matter: a model that wanders into new
 * advice, and a model that never answers. Both must fall back to the verbatim
 * record rather than leaving the user with a blank or invented instruction.
 */

import { describe, expect, test } from 'bun:test';

import { KNOWLEDGE_BY_ID } from '../src/core/knowledge';
import {
  buildPrompt,
  cleanModelText,
  dropRepeatedTail,
  isGrounded,
  localAssist,
  trimDanglingSentence,
  withTimeout,
  type LocalModelBackend,
} from '../src/core/ai/local-llm';

const bleeding = KNOWLEDGE_BY_ID.get('bleeding');
if (!bleeding) throw new Error('test fixture missing: bleeding entry');

function backendWith(text: string, ready = true): LocalModelBackend {
  return {
    isReady: async () => ready,
    loadModel: async () => {},
    unload: async () => {},
    generate: () => (async function* () {
      yield text;
    })(),
  };
}

const request = { query: 'heavy bleeding', entry: bleeding, language: 'English' };

describe('grounding', () => {
  test('accepts a rephrasing that reuses the record vocabulary', () => {
    const answer = 'Press hard on the wound. If blood soaks through, add another pad on top.';
    expect(isGrounded(answer, bleeding)).toBe(true);
  });

  test('rejects invented dosage advice even when the topic matches', () => {
    const answer = 'Press the wound and take 500 mg tablets every four hours.';
    expect(isGrounded(answer, bleeding)).toBe(false);
  });

  test('rejects an answer that shares no vocabulary with the record', () => {
    expect(isGrounded('You should probably just relax and rest.', bleeding)).toBe(false);
  });
});

describe('prompt construction', () => {
  test('includes the approved steps and the hard limits', () => {
    const prompt = buildPrompt(request);
    for (const step of bleeding.steps) expect(prompt).toContain(step.text);
    for (const rule of bleeding.never) expect(prompt).toContain(rule);
    expect(prompt).toContain('Use ONLY those steps');
  });
});

describe('localAssist fallback', () => {
  test('returns the verbatim record when no backend is installed', async () => {
    const result = await localAssist(null, request);
    expect(result.provenance).toBe('record');
    expect(result.text).toContain(bleeding.summary);
    for (const step of bleeding.steps) expect(result.text).toContain(step.text);
  });

  test('returns the record when the backend is not ready', async () => {
    const result = await localAssist(backendWith('anything', false), request);
    expect(result.provenance).toBe('record');
  });

  test('retries once when the model stops after a word or two', async () => {
    let calls = 0;
    const flaky: LocalModelBackend = {
      isReady: async () => true,
      loadModel: async () => {},
      unload: async () => {},
      generate: () => (async function* () {
        calls += 1;
        yield calls === 1
          ? 'Press.'
          : 'Press hard on the wound. If blood soaks through, add another pad on top.';
      })(),
    };
    const result = await localAssist(flaky, request);
    expect(calls).toBe(2);
    expect(result.provenance).toBe('model');
  });

  test('reports a timeout separately from a rejected answer', async () => {
    const silent: LocalModelBackend = {
      isReady: async () => true,
      loadModel: async () => {},
      unload: async () => {},
      generate: () => (async function* () {
        await new Promise(() => {});
      })(),
    };
    const result = await localAssist(silent, request, { timeoutMs: 10 });
    expect(result.reason).toBe('timeout');
  });

  test('says why the record came back when the wording wanders', async () => {
    const result = await localAssist(backendWith('Rest and drink plenty of fluids today.'), request, {
      timeoutMs: 200,
    });
    expect(result.provenance).toBe('record');
    expect(result.reason).toBe('ungrounded');
  });

  test('returns the model phrasing only when it is grounded', async () => {
    const answer = 'Press hard on the wound. Add another pad if blood soaks through.';
    const result = await localAssist(backendWith(answer), request, { timeoutMs: 200 });
    expect(result.provenance).toBe('model');
    expect(result.text).toBe(answer);
  });

  test('discards an ungrounded model answer', async () => {
    const result = await localAssist(backendWith('Take 500 mg tablets and rest.'), request, {
      timeoutMs: 200,
    });
    expect(result.provenance).toBe('record');
    expect(result.reason).toBe('ungrounded');
  });
});

describe('withTimeout', () => {
  test('returns the value when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });

  test('returns null when the work never finishes', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 10)).resolves.toBeNull();
  });

  test('cancels the backend when the deadline passes', async () => {
    let stopped = false;
    const result = await withTimeout(new Promise<number>(() => {}), 5, () => {
      stopped = true;
    });
    expect(result).toBeNull();
    expect(stopped).toBe(true);
  });
});

describe('model output tidying', () => {
  test('drops chat-template leftovers, rules, and headings', () => {
    const raw = '---\n\n---\n  </think>\n\n### Answer\nApply a cloth or clean pad.';
    expect(cleanModelText(raw)).toBe('Answer\nApply a cloth or clean pad.');
  });

  test('keeps a reply that is already plain prose', () => {
    const clean = 'Press down hard with both hands and keep pressing.';
    expect(cleanModelText(clean)).toBe(clean);
  });

  test('cuts a sentence that the token cap stopped mid-way', () => {
    expect(trimDanglingSentence('Press hard on the wound. The last sentence')).toBe(
      'Press hard on the wound.',
    );
  });

  test('leaves text without any full sentence alone', () => {
    expect(trimDanglingSentence('Press hard on the wound')).toBe('Press hard on the wound');
  });

  test('stops at the sentence a looping model prints twice', () => {
    const looped =
      'Keep pressing with a cloth. Add another pad on top. Keep pressing with a cloth. Add another pad on top.';
    expect(dropRepeatedTail(looped)).toBe('Keep pressing with a cloth. Add another pad on top.');
  });

  test('keeps an answer that never repeats itself', () => {
    const answer = 'Press the wound. Add a pad if blood soaks through. Keep pressing for ten minutes.';
    expect(dropRepeatedTail(answer)).toBe(answer);
  });
});
