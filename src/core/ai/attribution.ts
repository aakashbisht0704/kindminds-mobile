/**
 * Third-party attribution.
 *
 * The text model is Apache-2.0, so redistributing it (and the runtime that runs
 * it) requires shipping the licence with the app and stating who wrote what.
 * This module is the single source of that statement; `notices/` holds the
 * verbatim originals and `src/core/ai/licences.generated.ts` is generated from
 * them by `bun scripts/build-notices.ts`.
 *
 * Every component here is Apache-2.0 or MIT, which permits commercial use.
 */

import { TEXT_MODEL, VISION_MODEL, VOICE_MODEL } from './model-facts';

export type Attribution = {
  id: string;
  /** What this component does inside the app. */
  role: string;
  name: string;
  /** Exact artefact identity, so a reader can confirm the claim. */
  version: string;
  licence: string;
  copyright: string;
  source: string;
  /** The attribution sentence shown to the reader, when the publisher asked for one. */
  notice?: string;
  /** The redistribution obligations that apply to this component. */
  obligations: string;
};

export const ATTRIBUTIONS: readonly Attribution[] = [
  {
    id: 'qwen2.5',
    role: 'Text model (downloaded by the user, not bundled)',
    name: 'Qwen2.5-1.5B-Instruct',
    version: `Q4_K_M GGUF · ${TEXT_MODEL.bytes.toLocaleString('en-US')} bytes · sha256 ${TEXT_MODEL.sha256}`,
    licence: TEXT_MODEL.licence,
    copyright: 'Copyright 2024-present Alibaba Cloud',
    source: TEXT_MODEL.source,
    notice: 'Quantised to GGUF by Bartowski.',
    obligations:
      'Ship the Apache-2.0 licence. Commercial use is permitted; no separate licence is needed.',
  },
  {
    id: 'qwen-upstream',
    role: 'Upstream weights the GGUF was converted from',
    name: 'Qwen/Qwen2.5-1.5B-Instruct',
    version: '1.5B parameters, Apache-2.0',
    licence: 'Apache-2.0',
    copyright: 'Copyright 2024-present Alibaba Cloud',
    source: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct',
    obligations: 'Ship the Apache-2.0 licence.',
  },
  {
    id: 'llama-cpp',
    role: 'Inference engine that runs the GGUF on device',
    name: 'llama.cpp',
    version: 'standard upstream build, shipped inside llama.rn 0.12.9 (no fork, no patches)',
    licence: 'MIT',
    copyright: 'Copyright (c) 2023-2026 The ggml authors',
    source: 'https://github.com/ggml-org/llama.cpp',
    obligations: 'Ship the MIT copyright notice and permission notice.',
  },
  {
    id: 'shruti',
    role: 'Speech-to-text model (bundled, Cactus 4.1 runtime)',
    name: 'Udgam Shruti',
    version: `${VOICE_MODEL.name} · ${VOICE_MODEL.bytes.toLocaleString('en-US')} bytes`,
    licence: VOICE_MODEL.licence,
    copyright: 'Copyright the Shruti authors (see the model card)',
    source: VOICE_MODEL.source,
    obligations: 'Ship the Apache-2.0 licence.',
  },
  {
    id: 'mirage',
    role: 'Vision model (bundled, Cactus 4.1 runtime)',
    name: 'Cactus Mirage',
    version: `${VISION_MODEL.name} · ${VISION_MODEL.bytes.toLocaleString('en-US')} bytes`,
    licence: VISION_MODEL.licence,
    copyright: 'Copyright the Cactus authors (see the model card)',
    source: VISION_MODEL.source,
    obligations: 'Ship the Apache-2.0 licence.',
  },
];

/** One sentence the About/Licences area shows before the list. */
export const ATTRIBUTION_SUMMARY =
  'KindMinds runs other people\u2019s models on your phone. They are Apache-2.0 (Qwen2.5, Shruti, Mirage) and MIT (llama.cpp), which permits commercial use, and their licences are reproduced in full below.';
