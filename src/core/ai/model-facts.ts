/**
 * The facts about the models this app downloads.
 *
 * Kept as a pure module with no React Native imports so the downloader, the
 * attribution screen, the docs, and the unit tests can all read the same
 * numbers. A model identity is a claim about bytes: size and digest are the
 * only things that decide whether the file on the phone is the model we
 * audited, so they live in exactly one place.
 */

export type ModelFacts = {
  /** Filename inside the app's model directory. */
  name: string;
  url: string;
  bytes: number;
  /** Publisher digest. Only present when the publisher publishes one. */
  sha256?: string;
  licence: string;
  source: string;
};

/**
 * PrismML Ternary Bonsai 2 2B, Q2_0.
 *
 * Verified against the publisher's SHA256SUMS and by hashing the downloaded file
 * on the host: 546,689,504 bytes, digest below. Apache-2.0, base Qwen/Qwen3.5-2B.
 * The ternary weights are stored in a Hadamard-rotated basis, so it needs a
 * llama.cpp new enough to understand `prism.hadamard.*` (see llama-backend.ts).
 */
export const TEXT_MODEL: ModelFacts = {
  name: 'Ternary-Bonsai-2-2B-Q2_0.gguf',
  url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-2B-gguf/resolve/main/Ternary-Bonsai-2-2B-Q2_0.gguf',
  bytes: 546_689_504,
  sha256: 'c2893fa6f951daee8b7263d5f49b455e57989ef56417a22125b03566dc560650',
  licence: 'Apache-2.0',
  source: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-2B-gguf',
};

/** Udgam Shruti, bundled in the full APK, run by the Cactus 4.1 bridge. */
export const VOICE_MODEL: ModelFacts = {
  name: 'shruti.cact',
  url: 'https://huggingface.co/udgamlabs/Shruti/resolve/main/shruti.cact',
  bytes: 29_546_527,
  licence: 'Apache-2.0',
  source: 'https://huggingface.co/udgamlabs/Shruti',
};

/** Cactus Mirage, bundled in the full APK, run by the Cactus 4.1 bridge. */
export const VISION_MODEL: ModelFacts = {
  name: 'mirage.cact',
  url: 'https://huggingface.co/Cactus-Compute/mirage/resolve/main/mirage.cact',
  bytes: 21_611_043,
  licence: 'Apache-2.0',
  source: 'https://huggingface.co/Cactus-Compute/mirage',
};
