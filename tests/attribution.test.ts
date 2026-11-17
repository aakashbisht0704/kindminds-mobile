/**
 * Attribution facts and licence shipping.
 *
 * A model swap is exactly when licence text goes stale, so these checks pin the
 * claims the app makes to the artefacts it actually downloads, and pin the
 * in-app licence copy to the reviewed originals in `notices/`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ATTRIBUTIONS, ATTRIBUTION_SUMMARY } from '../src/core/ai/attribution';
import { APACHE2, BONSAI_NOTICE, LLAMACPP } from '../src/core/ai/licences.generated';
import { TEXT_MODEL } from '../src/core/ai/model-facts';

const root = join(import.meta.dir, '..');

function noticeFile(name: string): string {
  return readFileSync(join(root, 'notices', name), 'utf8').replace(/\r\n/g, '\n');
}

describe('attribution', () => {
  test('every third-party component the app ships or downloads is listed', () => {
    const ids = ATTRIBUTIONS.map((entry) => entry.id);
    expect(ids).toContain('bonsai');
    expect(ids).toContain('qwen');
    expect(ids).toContain('llama-cpp');
    expect(ids).toContain('shruti');
    expect(ids).toContain('mirage');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the Bonsai claim matches the bytes the downloader requests', () => {
    const bonsai = ATTRIBUTIONS.find((entry) => entry.id === 'bonsai');
    expect(bonsai).toBeDefined();
    expect(bonsai?.version).toContain(TEXT_MODEL.sha256 ?? 'unpublished');
    expect(bonsai?.version).toContain(TEXT_MODEL.bytes.toLocaleString('en-US'));
    expect(bonsai?.licence).toBe('Apache-2.0');
    expect(bonsai?.source).toContain('prism-ml/Ternary-Bonsai-2-2B-gguf');
    expect(bonsai?.source).toBe(TEXT_MODEL.source);
  });

  test('the audited digest is a full SHA-256, not a placeholder', () => {
    expect(TEXT_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(TEXT_MODEL.bytes).toBe(546_689_504);
  });

  test('nothing the app ships is non-commercial', () => {
    for (const entry of ATTRIBUTIONS) {
      expect(entry.licence.toLowerCase()).not.toContain('nc');
      expect(entry.licence.toLowerCase()).not.toContain('non-commercial');
    }
    expect(ATTRIBUTION_SUMMARY).toContain('commercial use');
  });

  test('the summary points at both licences that apply', () => {
    expect(ATTRIBUTION_SUMMARY).toContain('Apache-2.0');
    expect(ATTRIBUTION_SUMMARY).toContain('MIT');
  });
});

describe('licence texts shipped in the app', () => {
  test('the Apache-2.0 text is the real licence, not a stub', () => {
    expect(APACHE2).toContain('Apache License');
    expect(APACHE2).toContain('Version 2.0, January 2004');
    expect(APACHE2).toContain('END OF TERMS AND CONDITIONS');
    expect(APACHE2.length).toBeGreaterThan(9000);
  });

  test('the llama.cpp MIT text was copied, not paraphrased', () => {
    expect(LLAMACPP).toContain('MIT License');
    expect(LLAMACPP).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  test('the publisher NOTICE names Prism ML and the Qwen base model', () => {
    expect(BONSAI_NOTICE).toContain('Created using Bonsai by Prism ML.');
    expect(BONSAI_NOTICE).toContain('Qwen3.5-2B');
    expect(BONSAI_NOTICE).toContain('Apache 2.0');
  });

  test('the generated module still matches notices/', () => {
    expect(APACHE2).toBe(noticeFile('Ternary-Bonsai-2-2B-LICENSE.txt'));
    expect(BONSAI_NOTICE).toBe(noticeFile('Ternary-Bonsai-2-2B-NOTICE.txt'));
    expect(LLAMACPP).toBe(noticeFile('llama.cpp-LICENSE.txt'));
  });
});
