/**
 * Developer tool: run the real assistant pipeline against a local llama.cpp
 * binary, so prompt and validator changes can be evaluated without waiting for
 * emulator-speed prefill.
 *
 * Usage (from the repo root):
 *   bun scripts/eval-local-model.ts "heavy bleeding" "how do I stop bleeding?"
 *
 * Environment:
 *   KM_LLAMA_CLI  path to llama-cli (default: /tmp/llama-b11556/llama-cli.exe)
 *   KM_GGUF       path to the model (default: /tmp/bonsai.gguf)
 *   KM_LANG       en | hi | hinglish (default: en)
 *
 * The prompt is built by the same functions the app uses, then rendered as the
 * ChatML text llama.cpp's jinja template produces with enable_thinking=false,
 * which is the branch the app selects too.
 */

import { writeFileSync } from 'node:fs';

import { maxTokensFor, stopSequences } from '../src/core/ai/prompts';
import { validateAnswer } from '../src/core/ai/validation';
import { planAssistantRequest } from '../src/core/ai/assistant';
import type { AnswerLanguage } from '../src/core/ai/prompts';

const LANGUAGE = (process.env.KM_LANG ?? 'en') as AnswerLanguage;

type ServerReply = { content: string; reasoning: string | null; prefillMs: number; prefillTps: number; decodeTps: number; tokens: number };

/**
 * Ask a running llama-server (upstream build) with the app's exact messages.
 *
 * The template is applied by llama.cpp itself, which is also what the app does
 * (`jinja: true`), so this exercises the checkpoint's own non-thinking branch
 * rather than a hand-written ChatML string.
 */
async function runServer(system: string, user: string, maxTokens: number): Promise<ServerReply> {
  const url = process.env.KM_SERVER ?? 'http://127.0.0.1:8099/v1/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      top_p: 0.85,
      top_k: 20,
      repeat_penalty: 1.1,
      stop: stopSequences(),
      chat_template_kwargs: { enable_thinking: false },
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`server ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as {
    choices: { message: { content?: string; reasoning_content?: string | null } }[];
    timings?: Record<string, number>;
  };
  const message = body.choices[0]?.message ?? {};
  const timings = body.timings ?? {};
  return {
    content: message.content ?? '',
    reasoning: message.reasoning_content ?? null,
    prefillMs: timings.prompt_ms ?? 0,
    prefillTps: timings.prompt_per_second ?? 0,
    decodeTps: timings.predicted_per_second ?? 0,
    tokens: timings.predicted_n ?? 0,
  };
}

const queries = process.argv.slice(2);
if (queries.length === 0) {
  console.error('usage: bun scripts/eval-local-model.ts "query" ["query" ...]');
  process.exit(1);
}
for (const query of queries) {
  const plan = planAssistantRequest(query, { language: LANGUAGE });
  if (plan.kind === 'unsupported') {
    console.log(`
=== ${JSON.stringify(query)} [${plan.mode}/${plan.language}] -> unsupported (no record passed the retrieval threshold)`);
    continue;
  }
  const { mode, language, sources } = plan;
  const system = process.env.KM_SYSTEM ?? plan.system;
  const user = process.env.KM_SUFFIX ? `${plan.user}
${process.env.KM_SUFFIX}` : plan.user;
  if (process.env.KM_DUMP) {
    writeFileSync(`${process.env.TMP ?? '/tmp'}/km-messages.json`, JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokensFor(mode),
    }, null, 2));
    console.log(`messages written for ${mode}/${language}`);
    continue;
  }
  const reply = await runServer(system, user, maxTokensFor(mode));
  const verdict = validateAnswer({ mode, raw: reply.content, records: sources, language });

  console.log(
    `
=== ${JSON.stringify(query)} [${mode}/${language}] prefill ${(reply.prefillMs / 1000).toFixed(1)}s ` +
      `(${reply.prefillTps.toFixed(1)} tok/s), decode ${reply.decodeTps.toFixed(1)} tok/s, ${reply.tokens} tokens`,
  );
  console.log(`sources: ${sources.map((entry) => entry.id).join(', ')}`);
  if (reply.reasoning) console.log(`reasoning leaked: ${JSON.stringify(reply.reasoning.slice(0, 120))}`);
  console.log(`raw: ${JSON.stringify(reply.content)}`);
  console.log(verdict.ok ? 'verdict: ACCEPTED' : `verdict: REJECTED (${verdict.failure})`);
  if (verdict.ok) console.log(`clean: ${JSON.stringify(verdict.text)}`);
}
