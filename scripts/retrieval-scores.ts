/**
 * Developer tool: show what retrieval returns for a phrase, with scores.
 *
 * Used to calibrate the refusal floor: a question the knowledge base covers must
 * score above it, and a question it does not cover must stay below it. Prints
 * the same numbers `planAssistantRequest` decides on.
 *
 * Usage:
 *   bun scripts/retrieval-scores.ts "my hand is cut" "there is a fire" ...
 */

import { search } from '../src/core/ai/retrieval';
import { planAssistantRequest } from '../src/core/ai/assistant';

const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('usage: bun scripts/retrieval-scores.ts "query" ["query" ...]');
  process.exit(1);
}

for (const query of queries) {
  const hits = search(query, 3);
  const plan = planAssistantRequest(query, {});
  const top = hits[0];
  const verdict = plan.kind === 'unsupported' ? 'REFUSED' : `planned ${plan.mode} → ${plan.sources.map((s) => s.id).join('+')}`;
  const scored = hits.map((hit) => `${hit.entry.id}:${hit.score.toFixed(2)}`).join('  ');
  console.log(
    `${JSON.stringify(query).padEnd(42)} ${verdict.padEnd(34)} ` +
      `top=${(top?.score ?? 0).toFixed(2)}  ${scored}`,
  );
}
