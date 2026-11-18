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
- on-device question answering with **PrismML Ternary Bonsai 2 2B** (Q2_0 GGUF)
  through `llama.rn`
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
| Bonsai 2 text | later | 521 MB | `prism-ml/Ternary-Bonsai-2-2B-gguf` (`Q2_0`) |

Shruti and Mirage are packaged inside the full APK; onboarding copies them into
app storage, so they do not need a connection. Bonsai is deliberately absent
from the APK: it is an optional download from **Prepare → On-device models**.
Shruti and Mirage run through the official **Cactus 4.1** engine, linked into
the app's native library (`android/app/src/main/cpp/cactus_bridge.cpp`), because
the `cactus-react-native` wrapper does not implement the Whistle (Shruti) or
Mirage architectures. Bonsai runs through `llama.rn` with the checkpoint's own
chat template. Downloads are atomic: an interrupted install never destroys a
working model or map.

## The text model: PrismML Ternary Bonsai 2 2B

| Fact | Value |
| --- | --- |
| Repository | `prism-ml/Ternary-Bonsai-2-2B-gguf` |
| File | `Ternary-Bonsai-2-2B-Q2_0.gguf` |
| Bytes | 546,689,504 (~521 MB) |
| SHA-256 | `c2893fa6f951daee8b7263d5f49b455e57989ef56417a22125b03566dc560650` |
| Licence | Apache-2.0 (commercial use permitted) |
| Base model | `Qwen/Qwen3.5-2B` |
| GGUF architecture | `qwen35`, 1,881,825,088 parameters, context 262,144 |
| Quantisation | 151 tensors of custom type 42 (`Q2_0`), ternary weights |

The digest above is the publisher's, from the `SHA256SUMS` file in the same
repository, and it matches a file downloaded and hashed independently on the
host. The downloader verifies both size and digest, and deletes a mismatched
file instead of loading it.

Bonsai is a *vision-language* checkpoint. Only its text path is wired: the
`mmproj` projector is deliberately **not** downloaded, and nothing in the app
asks it to look at an image. Mirage owns vision.

A 521 MB download does not always survive a mobile connection in one piece, so
Bonsai is fetched in a way that can be resumed. The bytes land in `…gguf.part`, a
dropped socket is retried three times from the bytes already on disk, and a tap
on **Download Bonsai 2 2B** after a failure asks the server for the rest with an
HTTP `Range` request instead of starting over. Free space is checked before the
transfer starts, the `.part` file is kept after a failure so the next tap
continues from it, and the in-place rename only happens when the file matches
the expected size. The digest is then checked with an async chunked SHA-256 that
keeps the UI responsive: a synchronous 521 MB hash froze Hermes for minutes.
The same path is used for the map pack.

## Why `llama.rn` 0.13.0-rc.12 (llama.cpp b12445) is required

This is the single most expensive fact in the repository: it cost a week to
find, and reinstalling the dependency the obvious way reproduces it.

Bonsai's ternary weights are stored in a **Hadamard-rotated basis**. The GGUF
says so itself, in `prism.hadamard.*` metadata (block 512, normalised
Sylvester-Walsh-Hadamard transform, explicit ±1 signs, 150 rotated tensors, and
an inverse transform for `token_embd` with a tied output tensor).

| llama.rn | Bundled llama.cpp | `PRISM`/`prism.hadamard` support | Behaviour |
| --- | --- | --- | --- |
| 0.12.9 | b10256 (commit `6c8dcaa`) | none | Model loads and generates **mixed-script gibberish** (`"formerlyamiconique…"`, stray Chinese tokens) |
| 0.13.0-rc.12 | b12445 (commit `ef3848f`) | `LLM_KV_PRISM_HADAMARD_*` in `llama-arch.cpp` / `llama-model.cpp` | Answers **"4"** to "What is 2+2?" and answers the first-aid records coherently |

Build 10256 does know the `qwen35` architecture and the type-42 `Q2_0` tensor
type, which is exactly why the failure is confusing: the model *loads* and the
sampler *runs*. It simply reads rotated weights as if they were plain Q2_0.
There is no runtime error to search for.

The file itself is sound: official `ggml-org/llama.cpp` build b11556
(win-cpu-x64) answers coherently from the identical 546,689,504 bytes. No
native fork or patch exists in this repository, and none is needed once the
dependency is current.

### Upgrade procedure, exactly

Everything below was learned the hard way. Run it in this order.

1. **Remove the old package before installing.** `bun add llama.rn@0.13.0-rc.12`
   on top of 0.12.9 leaves a merged tree with ~95 stale files from 0.12.9's
   patched `cpp/` directory. Those shadow the vendored headers and every native
   build then dies with `unknown type name ggml_tensor`.

   ```sh
   rm -rf node_modules/llama.rn && bun install
   ```

2. **Use the publisher's prebuilt libraries.** The package's postinstall shells
   out to `tar` with a `C:` path on Windows and fails with
   `Cannot connect to C:`. Extract the release archive by hand and check it:

   ```sh
   curl -L https://github.com/mybigday/llama.rn/releases/download/v0.13.0-rc.12/llama-rn-android-jni-libs.tar.gz -o rnlibs.tgz
   # sha256 e6ebcc6c2627a6bf67be39e149260d8063d5b3672a5d56333ee6ec8294fffa61
   tar --force-local -xzf rnlibs.tgz -C node_modules/llama.rn
   ```

3. **Do not build llama.cpp from source.** rc.12 ships
   `rnllamaBuildFromSource=true` in `node_modules/llama.rn/android/gradle.properties`.
   Left alone, Gradle compiles the entire vendored tree and then dies on Windows
   with a `MAX_PATH` error (`mkdir(...ggml-cpu/tiled)`). `android/gradle.properties`
   in this repo sets `rnllamaBuildFromSource=false`, and every documented build
   command also passes `-PrnllamaBuildFromSource=false`.

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
| Text | PrismML **Ternary Bonsai 2 2B** | GGUF Q2_0, 521 MB, downloaded | Apache-2.0 |
| Voice | Udgam **Shruti** | 16 kHz WAV → text, `.cact`, 28 MB | Apache-2.0 |
| Vision | Cactus **Mirage** | image → text/scene, `.cact`, 21 MB | Apache-2.0 |
| Runtime | **llama.cpp** b12445 via `llama.rn` 0.13.0-rc.12 | native lib | MIT |

Apache-2.0 permits commercial use, which is a deliberate change from the
previous text model (Woof 2B, CC BY-NC 4.0). Prism ML's requested attribution
sentence — *"Created using Bonsai by Prism ML."* — and the copyright lines of
all five components are shown in the app under **Prepare → Licences and
attribution**, and the verbatim licence texts ship inside the binary so they are
readable with no network. The same originals live in
[`notices/`](notices/README.md) in the repository; the in-app strings are
generated from them by `bun scripts/build-notices.ts`, and a test fails if the
two ever disagree.

The Cactus runtime only ships **arm64-v8a** Android libraries, so the **shipped**
full AI build is arm64-only. An x86_64 debug build still exercises Bonsai
(`llama.rn` has x86_64 libraries); Shruti and Mirage stay unavailable there.

## Benchmarks

Everything in this section was measured, not estimated, and the hardware is
named because these numbers do not transfer between machines.

- **Host A** — Intel Core i5-13450HX (10 cores / 16 threads), 16 GB RAM,
  Windows, `llama.cpp` **b11556** `win-cpu-x64` (CPU only, `-t 4`),
  `llama-server -c 2048`, prompt cache **disabled** so every prompt is processed
  end to end, exactly as the app pays for it. Model: the 546,689,504-byte
  `Q2_0` file whose digest is quoted above.
- **Emulator B** — Android emulator **x86_64**, AVD `Medium_Phone_API_36.1`
  (4 GB, `-gpu swiftshader_indirect`), release APK, same model file.
- **Phone C** — **no arm64 phone was available**. There are no phone numbers in
  this repository.

### Routed batch: what the app does with ordinary questions

Ten queries through `planAssistantRequest()` → the model → `validateAnswer()`,
all on Host A. Mode is what the router chose, language is what was detected.

| Query | Mode | Sources | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| heavy bleeding | QUESTION | `bleeding` | 11.5 | 7.3 | 59 | accepted |
| someone is not breathing | SITUATION | `cpr`, `breathing` | 11.0 | 7.1 | 74 | accepted |
| how do I treat a burn | QUESTION | `burns` | 10.9 | 7.2 | 74 | accepted |
| how to treat heat stroke | QUESTION | `heat` | 11.0 | 7.2 | 60 | accepted |
| earthquake what to do | QUESTION | `earthquake` | 11.4 | 7.3 | 58 | accepted |
| no clean water to drink | QUESTION | `water`, `sanitation` | 11.6 | 8.0 | 18 | **rejected** `missing_step` (1/3) |
| panic attack | QUESTION | `panic`, `grounding` | 12.1 | 7.9 | 62 | accepted |
| child is very scared | QUESTION | `children`, `panic` | 12.3 | 8.2 | 30 | accepted |
| खून बहुत बह रहा है | QUESTION (hi) | `bleeding` | 12.2 | 8.2 | 56 | **rejected** `ungrounded` |
| khoon band nahi ho raha | QUESTION (hinglish) | `bleeding`, `sleep` | 12.2 | 7.7 | 40 | **rejected** `missing_step` (2/3) |

**7 of 10 accepted.** The three rejections are the safety net working, and the
interesting part is *why*:

- `no clean water to drink`: the model answered in 18 tokens ("Boil for 1 minute
  or let it settle and filter before disinfecting") and covered one third of the
  approved steps. The record is shown instead, which says more.
- The Devanagari query produced 64 tokens of **mangled Hindi** — understandable
  to a human maybe, but `फिंग से अर्थी` is not the approved instruction — and the
  vocabulary gate refused it. Hindi is the weakest of the three languages for
  this checkpoint.
- The Hinglish query produced a correct English answer that dropped two of the
  three required steps.

### The four prompt modes, one query each

| Mode | Query | Sources | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `REPHRASE` | heavy bleeding (record tapped) | `bleeding` | 12.4 | 8.2 | 56 | **rejected** `missing_step` (3/6) |
| `QUESTION` | how do I treat a burn | `burns` | 12.8 | 8.2 | 73 | accepted |
| `CLARIFY` | what does step 3 mean (step 3) | `bleeding` | 12.6 | 8.2 | 20 | accepted |
| `SITUATION` | someone is not breathing | `cpr`, `breathing` | 12.7 | 8.2 | 74 | accepted |

`REPHRASE` has the strictest gate by design: it must keep **every** step, and a
2B model asked for "plainer words" summarises. That rejection is correct — the
record is already plain — but it means the rephrase button frequently ends up
showing the record, which is honest and cheap and the UI says which happened.

### Language variants

| Language | Query | Prefill tok/s | Decode tok/s | Tokens | Verdict |
| --- | --- | ---: | ---: | ---: | --- |
| Hindi (Devanagari) | खून बहुत बह रहा है | 12.8 | 8.3 | 64 | **rejected** `ungrounded` |
| Hinglish | khoon band nahi ho raha | 12.7 | 8.3 | 33 | accepted |

### What the validator fixes were worth

The first batch of this change (same code, same model, same machine) accepted
**4 of 10**. Two validator defects were found by reading the rejected answers
rather than trusting the failure codes:

| Defect | Symptom | Fix | Effect |
| --- | --- | --- | --- |
| Sentence counting treated list markers as sentence ends, and numbered steps as invented numbers | heat stroke and panic attack rejected `too_many_sentences` although the text was correct | strip leading `1.` / `-` markers before counting sentences and numbers | 2 answers recovered |
| Step-order check scanned the whole answer for each step, so a later step matched an earlier step's word ("rescue **breaths**" matched "**breathing**") | CPR rejected `step_order` | each step is searched for *after* the previous step's match | 1 answer recovered |

Neither fix relaxes the safety contract: a scrambled CPR answer is still
rejected, a numbered list still cannot introduce a number the record does not
contain, and the vocabulary, step-survival, language and unsafe-advice gates are
untouched. Both have tests.

### What the two outcomes look like on screen

**Accepted.** Tapping **Heavy bleeding** on a device that answers in time shows a
card with the record title, the model's answer, and the approved sources that
produced it. From the measured host run above, the card reads:

> **Severe bleeding** — sources: `bleeding` — QUESTION
>
> Put a cloth or clean pad directly on the wound and press down hard with both
> hands. If blood soaks through, add another pad on top. Keep pressing for at
> least 10 minutes before looking. If bleeding will not stop, press the artery
> above the wound with a finger.
>
> *In plain words · from the approved record*

**Timed out.** Captured on the x86_64 emulator (release APK, 119 MB, 4 GB AVD):
the record card renders with its six numbered steps and its two red `Do not`
warnings, and beneath them the card says, in the product's own words:

> *The local model took too long on this phone, so only the approved record is
> shown.*

The **Say it in plain words** action stays available for a retry. The logcat
trace for that capture is unambiguous about what happened: `RNLlama` loaded the
546 MB file, initialised the context in ~12 s (file already in page cache),
started `loadPrompt`, and then `nextToken: Decoding Interrupted` when the derived
deadline expired after ~48 s, followed by
`[KindMinds] answer not shown { mode: 'QUESTION', reason: 'timeout', failure: null }`.
Nothing partial was shown, and the record was never replaced.

That is the designed behaviour on hardware that is too slow, and it is also the
honest warning about the 120 s cap: an x86_64 emulator is ~10× slower than a
phone here, but a low-end phone with a cold model may still hit the cap. The
screenshot is not committed, because this repository does not commit screenshots
(see `docs/README.md`).

### Emulator caveat

On Emulator B, the 546 MB Q2_0 file runs at roughly **1–2.5 tok/s prefill and
2–7 tok/s decode**. x86_64 has no NEON and the Q2_0 matmul is pathological
there, so a ~500-token prompt does not finish inside the app's 120 s cap: in the
capture above the derived deadline (48 s for that prompt on unknown hardware)
expired first. The emulator is a correctness harness — it proves the model
loads, the prompt tokenises, decoding starts, and the safety/fallback path
behaves on a real Android runtime — and it is **not** a performance proxy for a
phone. It also cannot run Shruti or Mirage, because Cactus publishes no x86_64
library.

### Not measured

- arm64 phone prefill/decode, first-token latency, RAM ceiling on 2–3 GB
  devices, thermal throttling, battery cost.
- **An accepted (non-fallback) answer in the app on any Android device.** On the
  x86_64 emulator the deadline expires first, which is the correct outcome but
  means the on-device accepted path is only proven by the host harness, which
  uses the app's exact prompts and validator.
- Download behaviour on a flaky mobile connection at 521 MB (the resume logic is
  covered by unit tests and by the map pack, not by a real 4G transfer).
- Whether the derived deadline (20 s – 120 s) is generous enough on a slow
  phone. The honest fallback there is the approved record.

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
./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a -PrnllamaBuildFromSource=false
```

### Lite and full variants

| Variant | Size | Contents |
| --- | ---: | --- |
| Full arm64 | 115 MB | map, Chat, SOS, records, bundled Shruti + Mirage, optional Bonsai |
| Lite arm64 | 29 MB | map, Chat, SOS, records, wellbeing; no model weights |
| Lite x86_64 | 82 MB | emulator/UI build; no model weights or AI native libs |

A **full** (non-lite) `x86_64` build is the way to exercise Bonsai in the
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
env -u EXPO_PUBLIC_KINDMINDS_LITE -u KINDMINDS_LITE ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a -PrnllamaBuildFromSource=false

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
pan direction, SOS payloads, crisis routing, the model-answer pipeline
(prompts, retrieval, validation, fallback reasons), the attribution and licence
claim, and Devanagari tokenisation.

The prompt and validator can be evaluated against the real model without the
emulator:

```sh
# terminal 1: a local build of llama.cpp new enough for Bonsai
cd Temp/llama-b11556 && ./llama-server.exe -m ../bonsai.gguf -c 2048 -t 4 --port 8099 --no-webui

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

### Bonsai download and answer flow (emulator)

Run this against a full `x86_64` **release** build on a 4 GB AVD, because loading
the 2B model next to the running app needs the headroom:

```sh
cd android
./gradlew app:assembleRelease -PreactNativeArchitectures=x86_64 -PrnllamaBuildFromSource=false
adb install -r app/build/outputs/apk/release/app-release.apk
```

1. **Prepare → On-device models → Download Bonsai 2 2B.** The progress bar
   should start at the percentage already on disk, not at zero.
2. Put the emulator in airplane mode mid-download. After three quick retries the
   card says the connection dropped and how many MB are saved; the `.part` file
   stays in `files/models`.
3. Leave airplane mode on, close the app, reopen it and tap **Download
   Bonsai 2 2B**. The transfer continues from those MB and finishes at
   546,689,504 bytes, then the integrity row runs before the card says installed.
4. **Assist → Heavy bleeding.** The card title, the retrieved source
   (`bleeding`) and the mode that was routed are visible immediately; the answer
   appears when generation finishes. On the emulator, generation does not finish
   inside the deadline, so what you will actually see here is step 5 — that is
   the honest result, not a bug in the install.
5. The timeout path, which is what the emulator exercises: the card keeps the
   approved record verbatim, adds *"The local model took too long on this phone,
   so only the approved record is shown."*, and leaves the action available for
   a retry. `logcat -s RNLlama:* ReactNativeJS:*` shows the context init, the
   prompt being tokenised, and `Decoding Interrupted` when the deadline fires.

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
  ceiling on 2–3 GB phones, thermal throttling, and flaky-4G download behaviour
  are unmeasured. Every phone number in this repository is a target, not a
  measurement.
- The emulator is a correctness harness, not a performance proxy: x86_64 has no
  NEON, and Q2_0 prefill there is 1–2.5 tok/s.
- The 20 s minimum deadline is a product target. On a slow phone the honest
  outcome is the verbatim record, and the UI says so.
- `UNSUPPORTED_SCORE = 2.6` and the vocabulary-overlap floors (0.45 REPHRASE /
  0.30 others) are tuned heuristics: they decide "answers" vs "refuses", so any
  change must be re-run through the eval harness.
- Bonsai is a vision-language checkpoint; only its text path is wired, and the
  `mmproj` is deliberately not downloaded.
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
