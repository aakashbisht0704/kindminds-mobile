/**
 * Third-party attribution.
 *
 * The text model is Apache-2.0, so redistributing it (and the runtime that runs
 * it) requires shipping the licence and the publisher's NOTICE text with the
 * app and stating who wrote what. This module is the single source of that
 * statement; `notices/` holds the verbatim originals and
 * `src/core/ai/licences.generated.ts` is generated from them by
 * `bun scripts/build-notices.ts`.
 *
 * Nothing here is decorative: three of five components are non-commercial-era
 * survivors of a model swap, and one of them used to forbid commercial use.
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
  /** The publisher's requested attribution sentence, verbatim when they gave one. */
  notice?: string;
  /** The redistribution obligations that apply to this component. */
  obligations: string;
};

export const ATTRIBUTIONS: readonly Attribution[] = [
  {
    id: 'bonsai',
    role: 'Text model (downloaded by the user, not bundled)',
    name: 'PrismML Ternary Bonsai 2 2B',
    version: `Q2_0 GGUF · ${TEXT_MODEL.bytes.toLocaleString('en-US')} bytes · sha256 ${TEXT_MODEL.sha256}`,
    licence: TEXT_MODEL.licence,
    copyright: 'Copyright 2026-present Prism ML, Inc.',
    source: TEXT_MODEL.source,
    notice: 'Created using Bonsai by Prism ML.',
    obligations:
      'Ship the Apache-2.0 licence and this NOTICE text. Commercial use is permitted; no separate licence is needed.',
  },
  {
    id: 'qwen',
    role: 'Base model Bonsai 2 was distilled from',
    name: 'Qwen3.5-2B',
    version: '2B parameters, Apache-2.0',
    licence: 'Apache-2.0',
    copyright: 'Copyright 2026 Alibaba Cloud',
    source: 'https://huggingface.co/Qwen/Qwen3.5-2B',
    obligations: 'Retained through the publisher NOTICE; ship the Apache-2.0 licence.',
  },
  {
    id: 'llama-cpp',
    role: 'Inference engine that runs the GGUF on device',
    name: 'llama.cpp',
    version: 'b12445 (commit ef3848f), shipped inside llama.rn 0.13.0-rc.12',
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
  'KindMinds runs other people\u2019s models on your phone. They are Apache-2.0 (Bonsai, Shruti, Mirage) and MIT (llama.cpp), which permits commercial use, and their licences are reproduced in full below.';
