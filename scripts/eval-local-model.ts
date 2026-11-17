/**
 * Developer tool: run the real assistant pipeline against a local llama-server,
 * so prompt and validator changes can be evaluated without waiting for
 * emulator-speed prefill.
 *
 * Usage (from the repo root, with a llama-server already listening):
 *   KM_SERVER=http://127.0.0.1:8099/v1/chat/completions \
 *     bun scripts/eval-local-model.ts "heavy bleeding" "panic attack"
 *
 * Environment:
 *   KM_SERVER  chat-completions URL (default http://127.0.0.1:8099/v1/chat/completions)
 *   KM_LANG    en | hi | hinglish | auto (default: auto, as in the app)
 *   KM_MODE    REPHRASE | QUESTION | CLARIFY | SITUATION (default: routed, as in the app)
 *   KM_SOURCE  record id to pin, e.g. bleeding (default: none)
 *   KM_STEP    1-based step for CLARIFY (default: parsed from the question)
 *   KM_JSON    write a machine-readable result file to this path
 *   KM_DUMP    write the exact messages instead of calling the server
 *
 * The prompt is built by the same functions the app uses (planAssistantRequest),
 * and llama.cpp applies the checkpoint's own chat template (jinja), which is the
 * branch the app selects too, so this exercises the shipped path rather than a
 * hand-written ChatML string.
 */

import { writeFileSync } from 'node:fs';

import { maxTokensFor, stopSequences, type AnswerLanguage, type AssistantMode } from '../src/core/ai/prompts';
import { validateAnswer } from '../src/core/ai/validation';
import { planAssistantRequest } from '../src/core/ai/assistant';

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
};

const LANGUAGE = (env('KM_LANG') ?? 'auto') as AnswerLanguage | 'auto';
const MODE = env('KM_MODE') as AssistantMode | undefined;
const SOURCE = env('KM_SOURCE');
const STEP = env('KM_STEP') ? Number.parseInt(env('KM_STEP') as string, 10) : undefined;

type ServerReply = {
  content: string;
  reasoning: string | null;
  prefillMs: number;
  prefillTps: number;
  decodeTps: number;
  tokens: number;
};

export type EvalRow = {
  query: string;
  mode: AssistantMode;
  language: AnswerLanguage;
  sources: string[];
  accepted: boolean;
  failure: string | null;
  detail: string | null;
  prefillTps: number;
  decodeTps: number;
  tokens: number;
  answer: string;
  reasoningLeaked: boolean;
};

/**
 * Ask a running llama-server (upstream build) with the app's exact messages.
 * The template is applied by llama.cpp itself, which is also what the app does
 * (`jinja: true`), so this uses the checkpoint's non-thinking branch.
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
      // The app re-processes the whole prompt for every answer (it keeps one
      // llama.rn context and no cross-request KV reuse), so measuring with a
      // warmed prompt cache would report a prefill speed the phone never sees.
      cache_prompt: false,
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

const rows: EvalRow[] = [];

for (const query of queries) {
  const plan = planAssistantRequest(query, {
    language: LANGUAGE,
    mode: MODE,
    sourceId: SOURCE as never,
    stepIndex: STEP,
  });
  if (plan.kind === 'unsupported') {
    console.log(
      `
=== ${JSON.stringify(query)} [${plan.mode}/${plan.language}] -> unsupported (no record passed the retrieval threshold)`,
    );
    rows.push({
      query,
      mode: plan.mode,
      language: plan.language,
      sources: [],
      accepted: false,
      failure: 'unsupported',
      detail: 'retrieval below threshold',
      prefillTps: 0,
      decodeTps: 0,
      tokens: 0,
      answer: plan.text,
      reasoningLeaked: false,
    });
    continue;
  }
  const { mode, language, sources } = plan;
  const system = process.env.KM_SYSTEM ?? plan.system;
  const user = process.env.KM_SUFFIX ? `${plan.user}\n${process.env.KM_SUFFIX}` : plan.user;
  if (process.env.KM_DUMP) {
    writeFileSync(
      `${process.env.TMP ?? '.'}/km-messages.json`,
      JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokensFor(mode) }, null, 2),
    );
    console.log(`messages written for ${mode}/${language}`);
    continue;
  }
  const reply = await runServer(system, user, maxTokensFor(mode));
  // Exactly what runAssistant passes, including the CLARIFY step, so the
  // harness measures the same validation the app performs.
  const verdict = validateAnswer({ mode, raw: reply.content, records: sources, language, stepIndex: plan.stepIndex });

  console.log(
    `
=== ${JSON.stringify(query)} [${mode}/${language}] prefill ${(reply.prefillMs / 1000).toFixed(1)}s ` +
      `(${reply.prefillTps.toFixed(1)} tok/s), decode ${reply.decodeTps.toFixed(1)} tok/s, ${reply.tokens} tokens`,
  );
  console.log(`sources: ${sources.map((entry) => entry.id).join(', ')}`);
  if (reply.reasoning) console.log(`reasoning leaked: ${JSON.stringify(reply.reasoning.slice(0, 120))}`);
  console.log(`raw: ${JSON.stringify(reply.content)}`);
  console.log(
    verdict.ok
      ? 'verdict: ACCEPTED'
      : `verdict: REJECTED (${verdict.failure}${verdict.detail ? `: ${verdict.detail}` : ''})`,
  );
  if (verdict.ok) console.log(`clean: ${JSON.stringify(verdict.text)}`);

  rows.push({
    query,
    mode,
    language,
    sources: sources.map((entry) => entry.id),
    accepted: verdict.ok,
    failure: verdict.ok ? null : verdict.failure,
    detail: verdict.ok ? null : (verdict.detail ?? null),
    prefillTps: reply.prefillTps,
    decodeTps: reply.decodeTps,
    tokens: reply.tokens,
    answer: verdict.ok ? verdict.text : reply.content,
    reasoningLeaked: Boolean(reply.reasoning),
  });
}

if (rows.length > 0) {
  const accepted = rows.filter((row) => row.accepted).length;
  console.log(`\nsummary: ${accepted}/${rows.length} accepted`);
  const target = process.env.KM_JSON;
  if (target) {
    writeFileSync(target, JSON.stringify(rows, null, 2));
    console.log(`results written to ${target}`);
  }
}
