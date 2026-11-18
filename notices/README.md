# Third-party notices

These are the verbatim licence files for the models and engine this app ships or
downloads. They are the reviewed originals; the strings the app displays are
generated from them, so a change here is the only way to change what the app
shows.

| File | Covers | Licence |
| --- | --- | --- |
| `Qwen2.5-1.5B-Instruct-LICENSE.txt` | Qwen2.5-1.5B-Instruct weights (text model, downloaded by the user) | Apache-2.0 |
| `llama.cpp-LICENSE.txt` | llama.cpp, the inference engine inside `llama.rn` | MIT |

The model licence was downloaded unmodified from
[`Qwen/Qwen2.5-1.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct/blob/main/LICENSE),
the upstream repository of the weights; the GGUF file the app downloads is a
quantised conversion published by
[`bartowski/Qwen2.5-1.5B-Instruct-GGUF`](https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF),
whose model card declares Apache-2.0 and the base model above. That repository
ships no separate NOTICE file, so there is no NOTICE text to retain; the
attribution the app shows credits both Qwen (Alibaba Cloud) and the quantiser.

## Why this directory exists

Apache-2.0 §4 requires that a recipient of a redistributed Work receives a copy
of the licence plus any NOTICE text the publisher shipped. The MIT licence for
llama.cpp requires the copyright and permission notice to travel with the binary.
The app shows both under **Prepare → Licences and attribution**, offline.

## Regenerating the in-app copy

`src/core/ai/licences.generated.ts` is produced from these files:

```sh
bun scripts/build-notices.ts
```

Never edit that generated module by hand. `tests/attribution.test.ts` compares
it against these files and fails on any difference, and also checks that the
size and SHA-256 the app quotes for the text model match the ones the downloader
enforces.
