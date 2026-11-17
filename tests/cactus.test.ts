import { describe, expect, test } from 'bun:test';

import { summarizeMirage } from '../src/core/ai/cactus-backend';
import { buildSystemPrompt, buildUserPrompt, toPromptRecord } from '../src/core/ai/prompts';
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

describe('assistant chat messages', () => {
  test('uses the approved record and the record-only system prompt', () => {
    const bleeding = KNOWLEDGE_BY_ID.get('bleeding');
    if (!bleeding) throw new Error('missing bleeding record');
    const system = buildSystemPrompt('REPHRASE', 'en');
    const user = buildUserPrompt({
      mode: 'REPHRASE',
      question: 'heavy bleeding',
      records: [toPromptRecord(bleeding)],
    });
    expect(system).toContain('Use only the approved records');
    expect(user).toContain(bleeding.title);
    for (const step of bleeding.steps) expect(user).toContain(step.text);
    for (const rule of bleeding.never) expect(user).toContain(rule);
  });
});
