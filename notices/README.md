# Third-party notices

These are the verbatim licence and notice files for the models and engine this
app ships or downloads. They are the reviewed originals; the strings the app
displays are generated from them, so a change here is the only way to change
what the app shows.

| File | Covers | Licence |
| --- | --- | --- |
| `Ternary-Bonsai-2-2B-LICENSE.txt` | PrismML Ternary Bonsai 2 2B weights (text model, downloaded by the user) | Apache-2.0 |
| `Ternary-Bonsai-2-2B-NOTICE.txt` | Publisher NOTICE for Bonsai 2, naming the Qwen3.5-2B base model | — (retained as required) |
| `llama.cpp-LICENSE.txt` | llama.cpp, the inference engine inside `llama.rn` 0.13.0-rc.12 | MIT |

Both were downloaded unmodified from
[`prism-ml/Ternary-Bonsai-2-2B-gguf`](https://huggingface.co/prism-ml/Ternary-Bonsai-2-2B-gguf)
and [`ggml-org/llama.cpp`](https://github.com/ggml-org/llama.cpp).

## Why this directory exists

The model is Apache-2.0, and Apache-2.0 §4 requires that a recipient of a
redistributed Work receives a copy of the licence, plus any NOTICE text the
publisher shipped. Bonsai's NOTICE also asks for the visible sentence
"Created using Bonsai by Prism ML.", which the app shows under
**Prepare → Licences and attribution**. The MIT licence for llama.cpp requires
the copyright and permission notice to travel with the binary.

## Regenerating the in-app copy

`src/core/ai/licences.generated.ts` is produced from these files:

```sh
bun scripts/build-notices.ts
```

Never edit that generated module by hand. `tests/attribution.test.ts` compares
it against these files and fails on any difference, and also checks that the
size and SHA-256 the app quotes for Bonsai match the ones the downloader
enforces.
