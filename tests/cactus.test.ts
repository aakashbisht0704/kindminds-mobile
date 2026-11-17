import { describe, expect, test } from 'bun:test';

import { summarizeMirage } from '../src/core/ai/cactus-backend';
import { buildMessages } from '../src/core/ai/local-llm';
import { KNOWLEDGE_BY_ID } from '../src/core/knowledge';

describe('Mirage output normalisation', () => {
  test('turns a structured scene graph into readable text', () => {
    const raw = JSON.stringify({
      text: [{ string: 'SHELTER - EAST GATE' }, { string: 'WATER POINT 200 m' }],
      objects: [{ name: 'rectangle' }, { name: 'text' }],
    });
    const summary = summarizeMirage(raw);
    expect(summary).toContain('Visible text: SHELTER - EAST GATE; WATER POINT 200 m');
    expect(summary).toContain('Objects: rectangle, text');
  });

  test('passes through a plain description', () => {
    expect(summarizeMirage('A white sign with a black border.')).toBe(
      'A white sign with a black border.',
    );
  });

  test('falls back to reasoning when no text or objects were found', () => {
    expect(summarizeMirage(JSON.stringify({ reasoning: 'The image is unclear.' }))).toBe(
      'The image is unclear.',
    );
  });
});

describe('Woof chat messages', () => {
  test('uses the approved record and the grounding system prompt', () => {
    const bleeding = KNOWLEDGE_BY_ID.get('bleeding');
    if (!bleeding) throw new Error('missing bleeding record');
    const messages = buildMessages({ query: 'heavy bleeding', entry: bleeding, language: 'English' });
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Use ONLY those steps');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toContain(bleeding.title);
    for (const step of bleeding.steps) expect(messages[1]?.content).toContain(step.text);
    for (const rule of bleeding.never) expect(messages[1]?.content).toContain(rule);
  });
});
