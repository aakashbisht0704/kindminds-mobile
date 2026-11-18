/**
 * Regenerate the in-app licence texts from the verbatim copies in `notices/`.
 *
 * The app must ship the Apache-2.0 licence and the publisher NOTICE of the model
 * it downloads, and it must ship the llama.cpp licence of the runtime that runs
 * it. Those texts live in `notices/` as the reviewed originals; this script
 * folds them into a TypeScript module so the Licence screen can show them
 * offline, without an asset loader and without a second hand-edited copy that
 * can drift from the original.
 *
 * Usage: bun scripts/build-notices.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const notices = join(root, 'notices');

function read(name: string): string {
  return readFileSync(join(notices, name), 'utf8').replace(/\r\n/g, '\n');
}

const licenses: Record<string, string> = {
  APACHE2: read('Qwen2.5-1.5B-Instruct-LICENSE.txt'),
  LLAMACPP: read('llama.cpp-LICENSE.txt'),
};

const header = `/**
 * GENERATED FILE - do not edit.
 *
 * Produced by \`bun scripts/build-notices.ts\` from the verbatim licence copies in
 * \`notices/\`. Re-run that script after updating those files; never hand-edit the
 * strings below, or the app and the reviewed originals will disagree.
 */

`;

const body = Object.entries(licenses)
  .map(([key, text]) => `export const ${key.toUpperCase()}: string = ${JSON.stringify(text)};\n`)
  .join('\n');

writeFileSync(join(root, 'src/core/ai/licences.generated.ts'), header + body);
console.log(`wrote src/core/ai/licences.generated.ts (${Object.keys(licenses).join(', ')})`);
