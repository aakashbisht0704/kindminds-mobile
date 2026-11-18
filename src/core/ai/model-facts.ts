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
 * Qwen2.5-1.5B-Instruct, Q4_K_M, by Bartowski.
 *
 * 986,048,768 bytes exactly (the HTTP Content-Length and the HF file listing
 * agree), and the SHA-256 below is the file's LFS object id in that repository,
 * confirmed again by hashing the downloaded file. Apache-2.0, base
 * Qwen/Qwen2.5-1.5B-Instruct.
 *
 * This is a plain Qwen2 GGUF with a ChatML template and no rotated weights or
 * custom tensor types, so the standard llama.cpp that ships inside llama.rn
 * runs it. That is the whole reason it is here: no fork, no kernel work.
 */
export const TEXT_MODEL: ModelFacts = {
  name: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  bytes: 986_048_768,
  sha256: '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370',
  licence: 'Apache-2.0',
  source: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF',
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
