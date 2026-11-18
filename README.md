# KindMinds Kit

A fully local disaster-survival and wellbeing companion for Android. It works
without a network, a SIM, or a server:

- first-launch carousel and offline-kit installer
- three destinations — **Assist**, **Map**, **Chat** — plus a permanent one-tap
  **SOS** action in the tab bar
- a compact local map built around the user's area (about 8 MB), with search,
  place selection, directions, and a navigation banner
- a WhatsApp-style **Chat** screen over Bluetooth LE: rooms, sealed DMs,
  file/map-pack sharing, and location pings
- a BitChat-derived mesh engine with a native Android BLE peripheral + GATT
  server, not just scanning
- offline first-aid, water, shelter, hazard, and wellbeing knowledge base
- on-device question answering with **Qwen2.5-1.5B-Instruct** (Q4_K_M GGUF)
  through `llama.rn` and stock llama.cpp
- on-device speech-to-text with **Shruti** through the native Cactus 4.1 bridge
- on-device photo description with **Mirage** through the native Cactus 4.1 bridge
- guided breathing, mood check-in, and crisis routing
- 72-hour preparedness checklist and SOS alerts

The interface follows the supplied Figma direction with a warmer paper canvas,
a burnt-orange primary action, a deep blue accent, quiet borders, and system
sans typography. Tabular figures are used only for times, distances, counters,
and coordinates; there is no decorative monospace or uppercase badge noise.

## First launch

The app starts with a four-slide carousel that shows the real map, chat, and
assistant surfaces. The last slide installs:

| Item | Default | Size | Model |
| --- | --- | ---: | --- |
| Local area map | on | ~8 MB | bounded MBTiles pack, z8–15 + overzoom |
| Shruti voice input | included | 28 MB | `udgamlabs/Shruti` (`shruti.cact`) |
| Mirage vision | included | 21 MB | `Cactus-Compute/mirage` (`mirage.cact`) |
| Qwen2.5 text | later | 986 MB | `bartowski/Qwen2.5-1.5B-Instruct-GGUF` (`Q4_K_M`) |

Shruti and Mirage are packaged inside the full APK; onboarding copies them into
app storage, so they do not need a connection. The text model is deliberately
absent from the APK: it is an optional download from **Prepare → On-device
models**. Shruti and Mirage run through the official **Cactus 4.1** engine,
linked into the app's native library
(`android/app/src/main/cpp/cactus_bridge.cpp`), because the
`cactus-react-native` wrapper does not implement the Whistle (Shruti) or Mirage
architectures. The text model runs through `llama.rn` with the checkpoint's own
ChatML template. Downloads are atomic: an interrupted install never destroys a
working model or map.

## The text model: Qwen2.5-1.5B-Instruct Q4_K_M

| Fact | Value |
| --- | --- |
| Repository | `bartowski/Qwen2.5-1.5B-Instruct-GGUF` |
| File | `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` |
| Bytes | 986,048,768 (~941 MiB) |
| SHA-256 | `1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370` |
| Licence | Apache-2.0 (commercial use permitted) |
| Upstream weights | `Qwen/Qwen2.5-1.5B-Instruct` |
| GGUF | `qwen2` architecture, Q4_K_M, standard llama.cpp quantisation |
| Chat template | ChatML, embedded in the GGUF |

The size is the HTTP `Content-Length` of the download URL and the `size` the
Hugging Face file listing reports, both 986,048,768 bytes; the digest is that
file's LFS object id in the repository, and it matched a download hashed
independently on the host. The downloader verifies both size and digest and
deletes a mismatched file instead of loading it.

This model was chosen for steady-state behaviour, not for a benchmark headline:
it is a plain Qwen2 GGUF with a standard quantisation, so the stock llama.cpp
that ships inside `llama.rn` runs it. There is no rotated-weight basis, no custom
tensor type, no kernel work, and nothing to keep patched. On the host benchmark
below it is roughly **10× faster** than the ternary 2B it replaced at the same
prompt size.

A ~986 MB download does not always survive a mobile connection in one piece, so
the text model is fetched in a way that can be resumed. The bytes land in
`…gguf.part`, a dropped socket is retried three times from the bytes already on
disk, and a tap on **Download Qwen2.5 1.5B** after a failure asks the server for
the rest with an HTTP `Range` request instead of starting over. Free space is
checked before the transfer starts, the `.part` file is kept after a failure so
the next tap continues from it, and the in-place rename only happens when the
file matches the expected size. The digest is then checked with an async chunked
SHA-256 that keeps the UI responsive. The same path is used for the map pack.

### Prompt format

The model's own ChatML template is applied by llama.cpp (`jinja: true`), so the
prompt on the wire is the template the checkpoint was trained with, never a
hand-assembled string:

```text
<|im_start|>system ... <|im_end|>
<|im_start|>user ... <|im_end|>
<|im_start|>assistant
```

`<|im_end|>` is the end-of-turn marker and is passed as the only stop sequence.
Qwen2.5-Instruct has **no thinking mode**, so there is nothing to disable: the
adapter sets no `enable_thinking` and no reasoning-format flags at all. A model
that still emits a reasoning preamble or a template token is caught by the
validator and rejected rather than cleaned up after the fact.

## The runtime: standard `llama.rn`, no fork

The app runs **`llama.rn` 0.12.9**, the stable release, with the publisher's
prebuilt Android libraries. This repository contains no native patch, no
vendored llama.cpp and no custom kernels, and `android/gradle.properties` sets
no build-from-source flags. `node_modules` is the published package.

For the record, so nobody re-opens this door: an earlier revision used a ternary
Q2_0 2B checkpoint whose weights are stored in a Hadamard-rotated basis. That
model needed `llama.cpp` build 12445 (from `llama.rn` 0.13.0-rc.12) because build
10256 silently reads rotated weights as plain Q2_0 and emits mixed-script
gibberish from a model that loads and runs without error. It worked once the
dependency was pinned, but it was slow (about 1/10th of the current model at the
same prompt size) and it made the runtime a thing to maintain. It was dropped
for exactly that reason, and the app now matches the model by name only: a
leftover GGUF from that era is never auto-selected, because the standard runtime
cannot decode it and producing nonsense is worse than showing the record.

If `bun install` cannot run llama.rn's postinstall on your machine (it shells out
to `tar` and has failed on Windows with `Cannot connect to C:`), extract the
release archive instead:

```sh
curl -L https://github.com/mybigday/llama.rn/releases/download/v0.12.9/llama-rn-android-jni-libs.tar.gz -o rnlibs.tgz
# sha256 CDA945A7C0ED075A0B028C1C3C6F5B668532EB18B069ECC4793ED7CA6CDB65AC (as downloaded here)
tar --force-local -xzf rnlibs.tgz -C node_modules/llama.rn
```

The Shruti/Mirage/Cactus side is untouched by any of this and still builds
against the same NDK.

## Chat

The tab is called **Chat**. The pinned room stays at the top, then the people
closest to you sorted by distance, then the remaining room chips. Tapping a room
or person opens a WhatsApp-style thread with bubbles, day dividers, delivery
ticks, sender names in rooms, and a composer with attachments. Past conversations
collapse into a section below instead of cluttering the first screen.

- **Rooms** broadcast to every node in range: `#general` (pinned), `#local`,
  `#maps`, `#wellness`.
- **People nearby** open an end-to-end sealed text DM. Past conversations stay
  readable when the peer is out of range.
- **Location** is a pin message and updates the Map marker.
- **Files and map packs** are shared in `#maps`; direct file transfer is not
  sealed yet, so the UI does not pretend it is.
- Outgoing and incoming messages are persisted in SQLite, so room previews and
  threads survive a force-stop or restart.

Known limitation: a **first-contact DM cannot be sent yet**. Announcements carry
callsign, status, skills and position but no keys, and `MeshEngine.trustPeerKey`
has no UI, so neither side has the peer's X25519 key and
`sendDirect` returns `null`. The thread header honestly shows
`waiting for key`, but the composer's notice ("Saved locally. It will travel
when another node is in range.") is wrong in that state: nothing will travel
until a key arrives. Fixing this needs either keys in the announcement or a
verification screen that calls `trustPeerKey` with a compared fingerprint.

## Assist: four prompt modes, one knowledge base

Assist is the front door: a voice-first conversation over the on-device models.
`planAssistantRequest()` in `src/core/ai/assistant.ts` is the only place that
does retrieval, routing and prompt assembly, so the eval harness can build
byte-identical prompts.

| Mode | Trigger | Task the model is given |
| --- | --- | --- |
| `REPHRASE` | the person tapped an approved record | say that record in plainer words, every step and warning kept |
| `QUESTION` | a question with a matching record | answer from the records, in order, 2–4 sentences |
| `CLARIFY` | "what does step 3 mean" | explain the approved step asked about, no new actions |
| `SITUATION` | a described emergency | give the approved guidance that fits, most urgent action first |

Retrieval is BM25 over the ~28 approved records (~30 KB) with a hand-written
Hindi/Hinglish alias table, so "खून बहुत बह रहा है" and "khoon band nahi ho
raha" both reach the `bleeding` record. Tokenisation keeps combining marks
(`[^\p{L}\p{N}\p{M}]+`), because splitting Devanagari at vowel signs turned
"खून" into fragments and lost the match.

The assistant routes to breathing, SOS, kit, chat, and map, and never invents
doses, diagnoses, or first-aid steps. The preparedness checklist opens from
Assist as a sheet, with the three highest-priority missing items first and the
full 18-item list behind a toggle.

SOS is always one tap away. The tab-bar button opens a sheet whose primary
action sends immediately with safe defaults (medical, one person, current fix)
without scrolling or filling fields. Details are optional and below the send
action; incoming alerts show distance and an "I can help" acknowledge action.

## AI safety

The approved knowledge base is the **only** source of facts. Generated text can
never enter it: there is no write path from model output into a record.

For every request the assistant:

1. retrieves records and refuses below a BM25 floor (`UNSUPPORTED_SCORE = 2.6`)
   with a same-language message instead of guessing;
2. renders only those records into the prompt, then generates one bounded
   completion;
3. validates the raw output and shows it **only** if it passes every gate.

`src/core/ai/validation.ts` rejects, with a code the UI reports honestly:

| Code | What it catches |
| --- | --- |
| `empty`, `too_long`, `too_many_sentences` | shape |
| `reasoning_marker` | `Thinking Process`, `Analyze the request`, `as an AI`, `<think>` — these appear when the checkpoint ignores `enable_thinking=false` and are **rejected, never stripped** |
| `template_artifact` | headings, empty bullets, `---` rules |
| `repetition` | a tail loop |
| `language_mismatch` | Hindi asked for, Latin script returned (or the reverse) |
| `ungrounded` | vocabulary overlap with the records under 0.45 (REPHRASE) / 0.30 (others) |
| `new_number`, `new_action`, `unsafe_advice` | numbers, procedures or medicines absent from the record |
| `missing_step`, `step_order` | a step dropped, or steps presented out of approved order |

A rejection is not an error: the card keeps the **verbatim approved record** on
screen and says why the model answer was withheld (timeout vs rejected are
distinct messages). A failed gate can never replace the record with something
weaker.

Timeout policy: the deadline is derived, not magic.
`estimateTimeout(promptChars, maxTokens, measuredSpeed)` uses the throughput this
device measured on its last answer, with conservative defaults (prefill
25 tok/s, decode 10 tok/s) until it has measured, and clamps to 20 s – 120 s. On
a slow phone the honest outcome is the record fallback, and the UI says so.

Shruti fills a text field, and Mirage only describes visible content; neither is
allowed to diagnose or prescribe. Crisis language is routed by `assessQuery`:
self-harm gets a supportive card, grounding steps, and a breathing reset;
immediate medical language points to SOS and the approved record. Wellness
queries route to grounding, grief, sleep, anger, or loneliness records.

## Models and licences

| Role | Model | Format | Licence |
| --- | --- | --- | --- |
| Text | **Qwen2.5-1.5B-Instruct** (Bartowski GGUF) | Q4_K_M, 986 MB, downloaded | Apache-2.0 |
| Voice | Udgam **Shruti** | 16 kHz WAV → text, `.cact`, 28 MB | Apache-2.0 |
| Vision | Cactus **Mirage** | image → text/scene, `.cact`, 21 MB | Apache-2.0 |
| Runtime | **llama.cpp** via `llama.rn` 0.12.9, unpatched | prebuilt native libs | MIT |

All four are Apache-2.0 or MIT, so commercial use needs no separate licence.
The copyright lines and the full licence texts for every component are shown in
the app under **Prepare → Licences and attribution**, offline, and the same
verbatim originals live in [`notices/`](notices/README.md). The in-app strings
are generated from those files by `bun scripts/build-notices.ts`, and a test
fails if the two ever disagree.

The Cactus runtime only ships **arm64-v8a** Android libraries, so the **shipped**
full AI build is arm64-only. An x86_64 release build still exercises the text
model (`llama.rn` has x86_64 libraries); Shruti and Mirage stay unavailable there.

## Benchmarks

Everything in this section was measured, not estimated, and the hardware is
named because these numbers do not transfer between machines.

- **Host A** — Intel Core i5-13450HX (10 cores / 16 threads), 16 GB RAM,
  Windows, `llama.cpp` **b11556** `win-cpu-x64` (CPU only), `llama-server -c
  2048`, prompt cache **disabled** so every prompt is processed end to end,
  exactly as the app pays for it. Model: the 986,048,768-byte Q4_K_M file.
- **Emulator B** — Android emulator **x86_64**, AVD `Medium_Phone_API_36.1`
  (4 GB, `-gpu swiftshader_indirect`), full release APK, same file.
- **Phone C** — **no arm64 phone was available**. There are no phone numbers in
  this repository.

Prompt size matters more than anything else here, so for reference: the app's
real prompts are ~450 tokens (system rules plus one or two records), and every
number below is for that size unless it says otherwise.

### Threads and batch size (Host A)

Four configurations, one fresh `llama-server` each, the app's own prompt run
through `scripts/eval-local-model.ts` so the measured path is the shipped one.
`pwsh -File scripts/bench-matrix.ps1` reproduces the table.

| Threads | Batch | Prefill | Decode | Answer | Latency | Peak RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 128 | 6.9 s (65.4 tok/s) | 15.4 tok/s | 43 tok | 9.7 s | 1683 MB |
| 2 | 256 | 6.9 s (65.2 tok/s) | 14.8 tok/s | 62 tok | 11.1 s | 1700 MB |
| 4 | 128 | 3.6 s (123.5 tok/s) | 20.3 tok/s | 42 tok | 5.7 s | 1684 MB |
| 4 | 256 | 3.6 s (125.9 tok/s) | 22.0 tok/s | 43 tok | 5.6 s | 1701 MB |

- **Threads: 4 wins clearly.** Prefill is 1.9× faster than 2 threads and decode
  is ~1.4× faster, which is what `DEFAULT_LLAMA_CONFIG` already uses. On a phone
  with big.LITTLE cores this is a four-thread default, not "all cores"; a 2+2
  split is the phone-specific experiment to run on real hardware.
- **Batch: no measurable difference.** 128 vs 256 is 0.3% apart on prefill and
  within run-to-run noise on decode, and 128 saves ~17 MB peak RSS. The app keeps
  `n_batch: 256` because the difference is noise and a larger batch helps longer
  prompts; there is no evidence here to justify churn.
- **Peak RSS is `llama-server` with its default 4 slots**, so it overstates what
  the app needs. The app's own single-slot context measured **1.17 GB PSS** on
  the emulator (below).

### Routed batch: what the app does with ordinary questions (Host A)

Ten queries through `planAssistantRequest()` → the model → `validateAnswer()`.
Two consecutive runs accepted **7/10** and **8/10** (the `panic attack` answer
varied between runs); the table is the first run.

| Query | Mode | Sources | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| heavy bleeding | QUESTION | `bleeding` | 131.5 | 23.2 | 34 | accepted |
| someone is not breathing | SITUATION | `cpr`, `breathing` | 139.5 | 22.8 | 101 | accepted |
| how do I treat a burn | QUESTION | `burns` | 144.1 | 22.2 | 88 | accepted |
| how to treat heat stroke | QUESTION | `heat` | 130.4 | 22.0 | 75 | accepted |
| earthquake what to do | QUESTION | `earthquake` | 130.3 | 22.9 | 17 | accepted |
| no clean water to drink | QUESTION | `water`, `sanitation` | 131.0 | 22.2 | 75 | **rejected** `missing_step` (2/3) |
| panic attack | QUESTION | `panic`, `grounding` | 131.4 | 21.8 | 76 | **rejected** `missing_step` (1/3) |
| child is very scared | QUESTION | `children`, `panic` | 133.0 | 22.7 | 50 | accepted |
| Devanagari query | QUESTION (hi) | `bleeding` | 130.2 | 21.3 | 140 | **rejected** `ungrounded` |
| khoon band nahi ho raha | QUESTION (hinglish) | `bleeding`, `sleep` | 130.6 | 20.6 | 74 | accepted |

The rejections are the safety net, and the reasons are worth reading:

- `no clean water to drink`: the model merged the water record with a sanitation
  record and covered two of the three required steps. The record is shown
  instead, which says more.
- `panic attack`: covered only one distinctive step in one of the two runs, and
  passed the other time. This model is less consistent than a single run
  suggests, which is exactly why the validator, not the model, decides.
- The Devanagari query produced **mangled Hindi** and the vocabulary gate refused
  it. See the language section.

Prefill on the host ranged **106–160 tok/s** across the session depending on what
else the machine was doing, so treat prefill as "about 3–6 s for a real prompt"
and decode as "about 21–26 tok/s" rather than as precise constants.

### The four prompt modes, one query each (Host A)

| Mode | Query | Sources | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `REPHRASE` | heavy bleeding (record tapped) | `bleeding` | 113.8 | 22.1 | 97 | accepted |
| `QUESTION` | how do I treat a burn | `burns` | 144.1 | 22.2 | 88 | accepted |
| `CLARIFY` | what does step 3 mean (step 3) | `bleeding` | 113.2 | 22.6 | 20 | accepted |
| `SITUATION` | someone is not breathing | `cpr`, `breathing` | 112.2 | 21.4 | 104 | accepted |

All four modes answer. `REPHRASE` needed a prompt fix for this model: asked for
"one sentence per step" it wrote two sentences and dropped steps; asked for a
numbered list it reproduced all six steps in order, three runs out of three. A
1.5B model copies a numbered structure; it does not count to six.

### Language variants (Host A)

| Language | Query | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | --- | ---: | ---: | --- |
| Hindi (Devanagari) | "खून बहुत बह रहा है" | 112.5 | 21.8 | 103 | **rejected** `ungrounded` |
| Hinglish | khoon band nahi ho raha | 105.9 | 20.7 | 33 | accepted |

**This is the weakest part of the integration, and it is a model limit, not a
plumbing bug.** Retrieval handles Devanagari correctly — both queries reach the
`bleeding` record — but Qwen2.5-1.5B Q4_K_M cannot reliably *write* safety
instructions in Devanagari: asked for Hindi it produced nonsense (Spanish-looking
words and invented compounds) or answered in English, which the language gate then
refused. Hinglish "passes", but the answer is often plain English, because a
Latin-script check cannot tell Hinglish from English.

The honest consequences, all visible in the product: a Hindi user gets the
approved record verbatim (correct, but in English) and the app says why the model
answer was withheld. The right fix is not a bigger prompt — it is reviewed Hindi
translations of the ~28 records served directly as records, so no model
translation ever touches safety text. That is future work, not something to paper
over with generation.

### What the validator fixes were worth

Reading the rejected answers, not the failure codes, found four defects that were
throwing away correct text.

| Defect | Symptom | Fix | Effect |
| --- | --- | --- | --- |
| Sentence counting treated list markers as sentence ends, and numbered steps as invented numbers | a correct numbered answer rejected `too_many_sentences` | strip leading `1.` / `-` markers before the sentence and number checks | numbered answers accepted |
| Sentence allowance did not scale with the record, so a six-step record could never fit | burn answer with seven good sentences rejected | `QUESTION` allowance is now `max(5, steps + 3)`, `REPHRASE` is `steps + 2`: the record is the ceiling | burn answer accepted |
| Step-order check matched a later step to an earlier step's word ("rescue **breaths**" vs "**breathing**") | correctly ordered CPR answer rejected `step_order` | each step is searched for *after* the previous match | CPR answer accepted |
| `CLARIFY` rejected answers that name the step they explain ("Step 3 means ...") as an invented number | `new_number: 3` on a perfect answer | the requested step index is allowed for `CLARIFY` | CLARIFY 3/3 accepted |

None of these relaxes the safety contract: a scrambled answer is still rejected,
a numbered list still cannot introduce a number the record does not contain, a
`CLARIFY` answer still cannot add a dose, and the vocabulary, step-survival,
language and unsafe-advice gates are untouched. Every fix has a test.

### Android emulator: the honest numbers (Emulator B)

Measured in the app, from `logcat -s ReactNativeJS:*` (the adapter logs the real
timings llama.cpp reports) and `dumpsys meminfo`, on the full x86_64 release APK:

| Measurement | Value |
| --- | --- |
| Model download, in-app | 986,048,768 bytes, ~4 min (~4–6 MB/s over the emulator's NAT) |
| Digest verification, in-app | ~14 min (chunked SHA-256 over 986 MB; the UI stays responsive) |
| Context load | ~5–6 s with the file in page cache |
| Prompt | 450 tokens |
| Prefill | **73.8 s (6.1 tok/s)** |
| Decode | **60 tokens at 2.43 tok/s** (~25 s) |
| Total generation | **~98 s** |
| Peak app memory | **1.17 GB PSS / ~1.35 GB RSS** |

Two things follow, and both are uncomfortable:

1. **The emulator cannot be a performance proxy.** The same prompt and model take
   3.6 s of prefill on the host and 73.8 s here, a 20× penalty, because x86_64
   gets no NEON and this AVD has no useful SIMD path for the quantisation.
2. **~98 s of inference sits right against the 120 s deadline.** In one run the
   deadline fired first (`reason: 'timeout'`) and the record was shown; in another
   the answer arrived. A real phone should be far quicker, but this is the
   measured reason the first-answer budget policy changed.

The emulator did prove the thing it was there to prove: the model loads, the
prompt tokenises to 450 tokens, and the app generated **real text on device** —
"Put a cloth or clean pad directly on the wound. Press down hard with both hands
and keep pressing. If blood soaks through, add another pad on top..." — which
passed validation and was shown above the record.

### Deadline policy, changed because of the measurements

The old rule estimated a deadline from conservative defaults on an unmeasured
device, which gave ~48 s for a 450-token prompt. On hardware slower than the
assumption that is the worst outcome available: the answer is abandoned just
before it arrives, and the device never measures itself, because the measurement
is only recorded on a completed answer. So the first answer on an unmeasured
device now gets the full 120 s cap, and every later answer uses this device's own
measured rates. That is why the emulator produced an answer here instead of a
timeout, and it is the difference between "slow" and "broken" on a weak phone.

### What the two outcomes look like on screen

**Accepted.** Tapping **Heavy bleeding** on a device that answers in time shows a
card with the record title and its six numbered steps, then a
**From the approved records** block with the model's answer underneath. Captured
on the x86_64 emulator, the answer block read:

> Put a cloth or clean pad directly on the wound. Press down hard with both hands
> and keep pressing. If blood soaks through, add another pad on top. Lay the
> person flat and lift the injured limb above heart level if you can. Keep
> pressing for at least 10 minutes before looking.

That text was generated on the device, passed every validator gate, and was shown
with the record still visible above it, so the person can read the approved
wording even when the model's phrasing is thinner.

**Timed out.** On the same AVD with the previous deadline policy, the record card
rendered with its steps and red `Do not` warnings and beneath them the card said:

> *The local model took too long on this phone, so only the approved record is
> shown.*

The logcat trace was unambiguous: `RNLlama` loaded the file, initialised the
context, started `loadPrompt` with 450 tokens, then `nextToken: Decoding
Interrupted` when the deadline expired, followed by
`[KindMinds] answer not shown { mode: 'QUESTION', reason: 'timeout', failure: null }`.
Nothing partial was shown, and the record was never replaced.

Both outcomes are the designed behaviour, and together they are the honest
warning about the deadline: the emulator sits at ~98 s of inference against a
120 s cap, so on a slow phone the record fallback is the realistic outcome. The
screenshots are not committed, because this repository does not commit
screenshots (see `docs/README.md`).

### Not measured

- arm64 phone prefill/decode, first-token latency, RAM ceiling on 2–3 GB
  devices, thermal throttling, battery cost. The 1.17 GB PSS on the emulator is
  the only on-device memory number that exists, and an emulator is not a phone.
- Whether a real phone finishes inside the 120 s cap. The emulator takes ~98 s and
  the host 3.6 s of prefill; a phone should sit between them, but nobody has
  measured it.
- Download behaviour on a flaky mobile connection at 986 MB (the resume logic is
  covered by unit tests and by the map pack, not by a real 4G transfer). On the
  emulator the download took ~4 minutes and the digest check ~14 minutes.
- Hindi/Devanagari generation quality above the refusal threshold. It is measured
  as unreliable, not as good.
## Build

Requirements: Node 20+, Bun, JDK 21, Android SDK 36, NDK 27.x, CMake 3.22.
`JAVA_HOME` must point at a JDK 21 (`C:/Program Files/Android/Android Studio/jbr`
on this machine); the system Java 8 fails the build.

```sh
bun install
bun run setup:native    # only if llama.rn's postinstall failed on Windows
npx expo start          # development / Metro
npx expo run:android    # debug native build
```

Release build with the JS bundle embedded:

```sh
cd android
./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

### Lite and full variants

| Variant | Size | Contents |
| --- | ---: | --- |
| Full arm64 | 103 MB | map, Chat, SOS, records, bundled Shruti + Mirage, optional Qwen2.5 |
| Lite arm64 | 29 MB | map, Chat, SOS, records, wellbeing; no model weights |
| Lite x86_64 | 82 MB | emulator/UI build; no model weights or AI native libs |

A **full** (non-lite) `x86_64` build is the way to exercise the text model in the
emulator: `llama.rn` ships x86_64 libraries, so the text model downloads, loads
and answers there, while the Cactus bridge compiles to an empty stub. That makes
Shruti and Mirage unavailable on the emulator, but the whole answer pipeline is
testable end to end — slowly. See the emulator note under benchmarks. Use the
**release** x86_64 APK for this: the dev bundle gets truncated over
`adb reverse` and the app dies with `Compiling JS failed: ':' expected` at a
different line each attempt.

The lite build swaps in an empty model-asset manifest, so it carries no Shruti
or Mirage weights, and strips the llama/Cactus native libraries. It still
installs the local map and keeps the approved records, Chat, SOS, and wellbeing
tools. The full APK is the one to install on a phone.

```sh
# Full AI build (arm64): force the full JS bundle and unset lite flags.
cd android
rm -rf app/build/generated/assets/createBundleReleaseJsAndAssets app/build/intermediates/assets/release/mergeReleaseAssets
find app/build -name index.android.bundle -delete
env -u EXPO_PUBLIC_KINDMINDS_LITE -u KINDMINDS_LITE ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a

# Lite arm64: delete the previous variant's JS bundle first.
rm -rf app/build/generated/assets/createBundleReleaseJsAndAssets app/build/intermediates/assets/release/mergeReleaseAssets
find app/build -name index.android.bundle -delete
EXPO_PUBLIC_KINDMINDS_LITE=1 ./gradlew app:assembleRelease -PkindmindsLite=true -PreactNativeArchitectures=arm64-v8a
```

Expo inlines `EXPO_PUBLIC_*` values into the JS bundle, but Gradle does not
treat that environment value as a task input. Deleting the generated bundle
before switching variants prevents a lite APK from shipping the full AI UI (or
the reverse). The same rule applies to the x86_64 lite build.

Autolinking is cached separately. Delete the generated autolinking output
before switching variants so a stale `PackageList.java` cannot leak one
variant's native packages into the other:

```sh
rm -rf app/build/generated/autolinking ../build/generated/autolinking
```

`metro.config.js` blocklists `android/**/.cxx`, because a Gradle clean deletes
CMake temp directories under it while Metro is watching, and Metro then dies
with `ENOENT` on a vanished path.

### Cactus engine bridge

`react-native.config.js` excludes `cactus-react-native` on Android. Its bundled
engine implements Whisper, Moonshine, Parakeet and LFM2-VL, but not the Whistle
(Shruti) or Mirage architectures, and it only understands the older unpacked
weight-directory format. The bundled Shruti and Mirage models are single-file
`.cact` archives for the Cactus 4.1 engine.

Voice and vision therefore go through `android/app/src/main/cpp/cactus_bridge.cpp`,
which links the arm64 `libcactus.a` from Cactus 4.1 and exposes `loadModel`,
`transcribe` and `describe` to JS as the `CactusEngine` native module. The
archive is arm64-only; on the lite x86_64 build the bridge compiles to nothing
and the AI buttons stay disabled.

Shruti is a Cactus Whistle model, not Whisper. The bridge passes no Whisper
special tokens; the 4.1 engine detects Hindi, Hinglish or English itself.

Built APKs are copied to `dist/` for convenience. The x86_64 lite APK is
provided because the Cactus runtime has no x86_64 Android library; building the
full AI app for x86_64 is not supported by Cactus.

## Verification

```sh
npm run verify          # tsc --noEmit + unit tests
```

Unit tests cover the mesh protocol, fragmentation, relay policy, rooms, DMs,
location messages, file transfer and SHA-256 rejection, chat derivations, tile
validation, coordinate/offline place search, route framing and fallback, map
pan direction, SOS payloads, crisis routing, the model-answer pipeline (prompts,
retrieval, validation, fallback reasons, the deadline policy), the attribution
and licence claim, and Devanagari tokenisation.

The prompt and validator can be evaluated against the real model without the
emulator:

```sh
# terminal 1: any recent upstream llama.cpp; this model needs nothing special
cd Temp/llama-b11556 && ./llama-server.exe -m ../qwen2.5-1.5b-q4km.gguf -c 2048 -t 4 --port 8099 --no-webui

# terminal 2: the app's exact prompts and validator, one line per query
KM_SERVER=http://127.0.0.1:8099/v1/chat/completions \
  bun scripts/eval-local-model.ts "heavy bleeding" "panic attack"

# four modes explicitly, and the language variants
KM_MODE=REPHRASE KM_SOURCE=bleeding bun scripts/eval-local-model.ts "heavy bleeding"
KM_MODE=CLARIFY KM_SOURCE=bleeding KM_STEP=3 bun scripts/eval-local-model.ts "what does step 3 mean"
KM_LANG=hi bun scripts/eval-local-model.ts "खून बहुत बह रहा है"
```

The harness prints the mode, the retrieved sources, real timings, the raw
output, and the validator verdict with its failure code, and can write JSON
(`KM_JSON=…`) for a table. `cache_prompt` is disabled so prefill is measured the
way the phone pays for it: the app re-processes the whole prompt on every answer.

### Download and answer flow on an Android runtime (emulator)

Run this against a full `x86_64` **release** build on a 4 GB AVD. It needs the
headroom for a ~1 GB model plus its KV cache:

```sh
cd android
./gradlew app:assembleRelease -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/release/app-release.apk
```

1. **Prepare → On-device models → Download Qwen2.5 1.5B.** The progress bar
   should start at the percentage already on disk, not at zero.
2. Put the emulator in airplane mode mid-download. After three quick retries the
   card says the connection dropped and how many MB are saved; the `.part` file
   stays in `files/models`.
3. Leave airplane mode on, close the app, reopen it and tap **Download Qwen2.5
   1.5B**. The transfer continues from those MB and finishes at 986,048,768 bytes,
   then the integrity row runs (long on an emulator: ~14 minutes for the chunked
   SHA-256) before the card says installed and verified.
4. **Assist → Heavy bleeding.** The card title and record appear immediately; the
   answer appears when generation finishes. On this AVD that took ~98 s
   (73.8 s prefill at 6.1 tok/s, then 60 tokens at 2.43 tok/s), so expect to
   watch the progress row for a while.
5. `logcat -s RNLlama:* ReactNativeJS:*` is the measurement tool: it shows
   `Context initialized`, the prompt token count, and
   `[KindMinds] inference timings { promptTokens, promptMs, prefillTps,
   predictedTokens, decodeTps }` on success, or
   `[KindMinds] answer not shown { reason: 'timeout' }` if the deadline wins.
   `dumpsys meminfo org.kindminds.kit` gives the memory reading (1.17 GB PSS for
   this model on the emulator).
6. Removing the model, or the OS killing the app, must leave the record fallback
   working: the assistant shows the approved record and never a partial answer.
## Two-phone mesh test

The mesh has no servers: two phones have to find each other over Bluetooth LE.
Do this with both phones unlocked and the app open on the Chat tab.

1. Install the same build on both phones.
2. Grant **Nearby devices** (Bluetooth) when asked. Bluetooth must be on, and
   both phones must be in range (a few metres is enough).
3. Open **Chat**. Within ~15 seconds each phone should show a link, then a peer.
4. If a phone shows `0 links`, the two radios never connected. If it shows
   `1 link` but `0 peers`, the link is up but no announcement arrived — that is a
   frame-delivery problem, not a discovery problem.

Kit → Device and data shows the numbers to report back:

| Row | Meaning |
| --- | --- |
| `Radio` | `ready` (advertising + scanning), `scanning only` (no peripheral), `off`, `unauthorized`, `unsupported` |
| `Links` | open BLE links vs. phones that announced themselves |
| `Frames out / in` | raw fragments written and received since launch |
| `Last radio note` | the last transport error, verbatim |

Presence is automatic: a node announces on boot, on every new link, and every
15 seconds. The **Announce** button is only a nudge, not a requirement.

A message typed with no link open is held for up to three minutes and sent when
a link appears; after that it stays in the history as unsent.

## Documentation

Deeper material lives in [`docs/`](docs/README.md): architecture, the mesh wire
protocol, the offline map, data and privacy, building and releasing,
troubleshooting, and the test plan. `CONTRIBUTING.md` and `SECURITY.md` cover
workflow and reporting.

## Known limits

- **No arm64 phone has run this build.** Real-device prefill/decode, the RAM
  ceiling on 2â€“3 GB phones, thermal throttling, and flaky-4G download behaviour
  are unmeasured. Every phone number in this repository is a target, not a
  measurement. The emulator needs 1.17 GB PSS for this model, so a 2 GB phone is
  a genuine risk even though the weights are "only" 986 MB.
- The emulator is a correctness harness, not a performance proxy: x86_64 has no
  NEON and takes 73.8 s of prefill for a prompt the host does in 3.6 s.
- **Hindi (Devanagari) generation is unreliable** on this 1.5B model: the model
  produces mangled Hindi or English, both of which the validator refuses, so the
  user gets the approved (English) record. Hinglish is accepted, but the answer
  is often plain English because a script check cannot tell them apart. Fixing
  this needs reviewed Hindi translations served as records, not a bigger prompt.
- The first answer on an unmeasured device may take up to the 120 s cap. That is
  deliberate: a slower answer beats an abandoned one, and it is what lets the
  device measure itself for later answers.
- `UNSUPPORTED_SCORE = 2.6`, the vocabulary-overlap floors (0.45 REPHRASE / 0.30
  others) and the record-scaled sentence allowances are tuned heuristics: they
  decide "answers" vs "refuses", so any change must be re-run through the eval
  harness and the four-mode batch.
- Downloading and then hashing 986 MB is slow on weak hardware: ~4 minutes to
  download and ~14 minutes to verify on the x86_64 emulator. The UI stays
  responsive and says what it is doing, but it is not instant.
- The 0.5B Qwen2.5 Instruct variant is the documented low-RAM alternative for
  future work; there is no multi-model picker yet.
- Two-phone BLE mesh testing is still required on physical hardware each time
  the transport changes; the emulator verifies advertising and that the GATT
  server compiles and starts.
- BLE only runs while the app is in the foreground. There is no foreground
  service, so a locked or backgrounded phone stops relaying.
- iOS has not been built in this workspace.
- Cactus (Shruti/Mirage) is arm64-only; the full AI APK is arm64.
- The default Esri World Street Map endpoint is for setup; use an authorised or
  self-hosted tile source for production. Esri serves "map data not yet
  available" placeholders above z15 in some areas, so the default pack stops at
  z15 and overzooms from there.
- Auto-expansion needs both a fresh fix and reachability to the tile server. If
  either is missing, the existing pack stays usable and the app retries later.
- Online place search and road routing need a connection. Without one, search
  still covers on-device places and directions fall back to a direct line.
- Direct text DMs are sealed, but a first-contact DM cannot be sent (no keys in
  announcements, `trustPeerKey` not wired). Location pings are addressed to a
  peer but not encrypted; files and map packs are shared in `#maps`, not sealed
  DMs.
