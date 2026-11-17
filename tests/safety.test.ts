/**
 * Safety gate tests: crisis routing and model-output rejection.
 */

import { describe, expect, test } from 'bun:test';

import { assessQuery, containsUnsafeAdvice } from '../src/core/ai/safety';
import { KNOWLEDGE_BY_ID } from '../src/core/knowledge';
import { runAssistant } from '../src/core/ai/assistant';
import type { LocalModelBackend } from '../src/core/ai/local-llm';

describe('crisis routing', () => {
  test('self-harm language is routed to support and grounding', () => {
    const result = assessQuery('I want to kill myself');
    expect(result.severity).toBe('self-harm');
    expect(result.suggestedTopic).toBe('grounding');
    expect(result.message).toContain('You matter');
  });

  test('immediate medical language is routed to SOS and records', () => {
    const result = assessQuery('he is not breathing and unconscious');
    expect(result.severity).toBe('emergency');
    expect(result.message).toContain('SOS button');
  });

  test('wellness language picks a relevant record', () => {
    expect(assessQuery('I miss him, he died').suggestedTopic).toBe('grief');
    expect(assessQuery('I am so angry and furious').suggestedTopic).toBe('anger');
    expect(assessQuery("I can't sleep, nightmares").suggestedTopic).toBe('sleep');
    expect(assessQuery('I feel completely alone').suggestedTopic).toBe('loneliness');
    expect(assessQuery('I am panicking and shaking').suggestedTopic).toBe('grounding');
  });

  test('ordinary survival queries stay normal', () => {
    expect(assessQuery('how do I make water safe').severity).toBe('normal');
  });
});

describe('model output safety', () => {
  test('rejects dosages, diagnoses, and new medicines', () => {
    expect(containsUnsafeAdvice('Give 500 mg of paracetamol.')).toBe(true);
    expect(containsUnsafeAdvice('Take two tablets every four hours.')).toBe(true);
    expect(containsUnsafeAdvice('They have an infection and need antibiotics.')).toBe(true);
    expect(containsUnsafeAdvice('You are diagnosed with a fracture.')).toBe(true);
  });

  test('accepts ordinary approved-record language', () => {
    expect(containsUnsafeAdvice('Press hard on the wound. Add another pad if blood soaks through.')).toBe(false);
    expect(containsUnsafeAdvice('Push hard and fast, 5 to 6 cm deep, 100 to 120 times a minute.')).toBe(false);
  });

  test('the assistant rejects a grounded-looking answer that contains a dose', async () => {
    const bleeding = KNOWLEDGE_BY_ID.get('bleeding');
    if (!bleeding) throw new Error('missing bleeding record');

    const backend: LocalModelBackend = {
      isReady: async () => true,
      loadModel: async () => {},
      unload: async () => {},
      generate: () =>
        (async function* () {
          yield 'Press hard on the wound and give 500 mg of paracetamol.';
        })(),
    };

    const result = await runAssistant(backend, {
      query: 'heavy bleeding',
      options: { mode: 'REPHRASE', sourceId: 'bleeding', timeoutMs: 500 },
    });
    expect(result.provenance).toBe('record');
    expect(result.kind).toBe('fallback');
  });
});
