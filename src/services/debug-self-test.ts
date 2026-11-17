/**
 * TEMPORARY diagnostic harness (removed before delivery).
 *
 * Separates two failures that look identical from the outside:
 *  - the chat template / prompt is wrong, or
 *  - the runtime cannot execute the ternary weights on this CPU.
 */
import type { LlamaContext } from 'llama.rn';

export async function runSelfTest(context: LlamaContext, modelPath: string): Promise<void> {
  console.warn('[selftest] model', modelPath);

  // 1. What prompt does llama.cpp build from these messages?
  try {
    const formatted = await context.getFormattedChat(
      [
        { role: 'system', content: 'You are a terse assistant.' },
        { role: 'user', content: 'Say hello.' },
      ],
      undefined,
      { jinja: true, enable_thinking: false },
    );
    console.warn('[selftest] formatted prompt', JSON.stringify(formatted.prompt));
  } catch (error) {
    console.warn('[selftest] getFormattedChat failed', error);
  }

  // 2. Raw capability: a trivia question with no records and no system prompt.
  try {
    let text = '';
    await context.completion(
      {
        messages: [{ role: 'user', content: 'What is 2 + 2? Answer with the number only.' }],
        jinja: true,
        enable_thinking: false,
        reasoning_format: 'none',
        n_predict: 24,
        temperature: 0,
      },
      (data) => {
        text += data.token ?? '';
      },
    );
    console.warn('[selftest] math answer', JSON.stringify(text));
  } catch (error) {
    console.warn('[selftest] math completion failed', error);
  }

  // 3. Same question through a ChatML prompt built by hand, thinking disabled
  //    exactly as the checkpoint's own template does it.
  try {
    const prompt =
      '<|im_start|>system\nYou are a terse assistant.<|im_end|>\n' +
      '<|im_start|>user\nWhat is 2 + 2? Answer with the number only.<|im_end|>\n' +
      '<|im_start|>assistant\n thinking\n\n</think>\n\n';
    let text = '';
    await context.completion(
      {
        prompt,
        n_predict: 24,
        temperature: 0,
        stop: ['<|im_end|>'],
      },
      (data) => {
        text += data.token ?? '';
      },
    );
    console.warn('[selftest] raw chatml answer', JSON.stringify(text));
  } catch (error) {
    console.warn('[selftest] raw chatml failed', error);
  }
}
