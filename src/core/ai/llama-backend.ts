/**
 * llama.rn adapter for the Bonsai 2 chat model.
 *
 * Runtime facts this file depends on, and the reason the dependency is pinned
 * to llama.rn 0.13.0-rc.12 (llama.cpp build 12445, commit ef3848f):
 *
 * Bonsai 2 stores its ternary weights in a Hadamard-rotated basis and records
 * that in `prism.hadamard.*` GGUF metadata. Build 10256 - the one inside
 * llama.rn 0.12.9 - knows the `qwen35` architecture and the ternary `Q2_0`
 * tensor type, but nothing about `prism.hadamard`, so it reads rotated weights
 * as if they were plain Q2_0. The model still loads and generates, and answers
 * in mixed-script gibberish. Build 12445 implements LLM_KV_PRISM_HADAMARD_* in
 * llama-arch.cpp / llama-model.cpp and answers coherently from the same bytes.
 *
 * That is also why `jinja: true` is not cosmetic: llama.cpp applies the
 * checkpoint's own Qwen3.5 chat template with `enable_thinking: false`, which is
 * the template's empty-think branch - not a guess at the format and not
 * post-hoc tag stripping.
 *
 * The native binding is loaded lazily so the rest of the app still works when
 * the module is missing, the model file is absent, or the phone is too small.
 */

import type { LlamaContext } from 'llama.rn';

import type { GenerationRequest, LocalModelBackend, RuntimeSpeed, TokenStream } from './local-llm';

type LlamaModule = typeof import('llama.rn');

export type LlamaBackendConfig = {
  contextSize: number;
  batchSize: number;
  threads: number;
};

export const DEFAULT_LLAMA_CONFIG: LlamaBackendConfig = {
  contextSize: 2048,
  batchSize: 256,
  threads: 4,
};

function nativePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

function loadLlamaModule(): LlamaModule {
  // Loaded at call time, not import time: a missing native module must not
  // prevent the rest of the app from starting.
  return require('llama.rn') as LlamaModule;
}

function tokenStream(run: (emit: (token: string) => void, done: (error?: Error) => void) => void): TokenStream {
  const buffer: string[] = [];
  const waiters: ((result: IteratorResult<string>) => void)[] = [];
  let ended = false;
  let failure: Error | null = null;

  const emit = (token: string) => {
    if (!token) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value: token, done: false });
      return;
    }
    buffer.push(token);
  };

  const finish = (error?: Error) => {
    if (ended) return;
    ended = true;
    failure = error ?? null;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.({ value: undefined as unknown as string, done: true });
    }
  };

  run(emit, finish);

  const iterator: AsyncIterator<string> = {
    next(): Promise<IteratorResult<string>> {
      if (buffer.length > 0) {
        return Promise.resolve({ value: buffer.shift() as string, done: false });
      }
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve({ value: undefined as unknown as string, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
    return(): Promise<IteratorResult<string>> {
      finish();
      return Promise.resolve({ value: undefined as unknown as string, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

export class LlamaBackend implements LocalModelBackend {
  private context: LlamaContext | null = null;

  private modelPath: string | null = null;

  private config: LlamaBackendConfig;

  /** Measured on this device by the last completion; null until then. */
  private measuredSpeed: RuntimeSpeed | null = null;

  constructor(config: Partial<LlamaBackendConfig> = {}) {
    this.config = { ...DEFAULT_LLAMA_CONFIG, ...config };
  }

  async isReady(): Promise<boolean> {
    return this.context !== null;
  }

  get loadedModelPath(): string | null {
    return this.modelPath;
  }

  get runtimeConfig(): LlamaBackendConfig {
    return this.config;
  }

  async loadModel(path: string): Promise<void> {
    if (this.context && this.modelPath === path) return;

    await this.unload();
    const { initLlama } = loadLlamaModule();
    this.context = await initLlama({
      model: nativePath(path),
      n_ctx: this.config.contextSize,
      n_batch: this.config.batchSize,
      n_threads: this.config.threads,
      n_gpu_layers: 0,
      use_mlock: false,
      use_mmap: true,
    });
    this.modelPath = path;
  }

  generate(request: GenerationRequest): TokenStream {
    const context = this.context;
    if (!context) throw new Error('No text model is loaded.');

    return tokenStream((emit, done) => {
      void context
        .completion(
          {
            // The checkpoint's own chat template, applied by llama.cpp. Thinking
            // is disabled through the template, which is why the prompt ends
            // with the empty `thinking` block instead of a `thinking` section
            // that would have to be stripped afterwards.
            messages: request.messages,
            jinja: true,
            enable_thinking: false,
            reasoning_format: 'none',
            n_predict: request.maxTokens,
            temperature: request.temperature,
            top_p: request.topP,
            top_k: request.topK,
            penalty_repeat: request.repeatPenalty,
            stop: [...request.stopSequences],
            seed: -1,
          },
          (data) => emit(data.token ?? ''),
        )
        .then((result) => {
          // Real numbers from this device, used to size the next deadline
          // instead of trusting a fixed timeout.
          const timings = result?.timings;
          if (timings && timings.prompt_per_second > 0 && timings.predicted_per_second > 0) {
            this.measuredSpeed = {
              prefillTps: timings.prompt_per_second,
              decodeTps: timings.predicted_per_second,
            };
          }
          done();
        })
        .catch((error: unknown) => done(error instanceof Error ? error : new Error(String(error))));
    });
  }

  async unload(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.modelPath = null;
    if (!context) return;
    try {
      await context.release();
    } catch {
      // The native context may already be gone after an OS kill.
    }
  }

  /**
   * Stop the sampler when the caller's deadline expires. Without this the llama
   * context stays busy and the next request fails with "Context is busy" even
   * though the model is fine.
   */
  stop(): void {
    void this.context?.stopCompletion().catch(() => {
      // Nothing to cancel, or the context was released concurrently.
    });
  }
}
