# Changelog

All notable changes to KindMinds Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning once it reaches a stable release.

## [Unreleased]

### Changed

- On-device text model is now **Qwen2.5-1.5B-Instruct Q4_K_M** (Bartowski GGUF,
  986,048,768 bytes, Apache-2.0), running on the stable `llama.rn` 0.12.9 and
  stock upstream llama.cpp. No fork, no patches, no custom kernels.
- The previous text model (PrismML Ternary Bonsai 2 2B) and the runtime pin it
  needed are removed. Its Q2_0 weights are Hadamard-rotated, which made it both
  slow (~10x slower than the current model at the same prompt size) and a
  runtime dependency to maintain. A leftover Bonsai GGUF is no longer selected
  as the text model.
- Assistant prompts use the checkpoint's embedded ChatML template, stop at
  `<|im_end|>`, and no longer carry thinking-mode flags.
- The REPHRASE prompt asks for a numbered list, which is what makes a 1.5B model
  keep every approved step (three runs, three complete answers).
- The deadline policy gives the first answer on an unmeasured device the full
  120 s cap instead of a conservative estimate, so slow hardware can still
  answer and can then measure itself.
- Bundled voice (Shruti) and vision (Mirage) models are unchanged.

### Fixed

- Validator false rejections found by reading refused-but-correct answers:
  numbered answers counted as too many sentences and their markers as invented
  numbers; the sentence allowance did not scale with the record; step order
  matched a later step to an earlier step's word; and CLARIFY answers that name
  the step they explain were rejected as invented numbers. All four have tests.
- Emulator text generation is stable; see the root README for the emulator
  timing caveat.

## [0.1.0] — 2025-11

Initial public snapshot.

### Added

- Offline-first Android app with Assist, Map, and Chat tabs plus a permanent SOS
  action.
- First-launch onboarding that installs a local MBTiles map around a fresh GPS
  fix and copies bundled voice/vision models out of the APK.
- Bluetooth LE mesh with a native Android GATT server, fragmentation, TTL
  relaying, duplicate suppression, rooms, SOS alerts, acknowledgements, location
  pings, and SHA-256-verified file sharing.
- Sealed direct messages with X25519 + XChaCha20-Poly1305 and a safety-number
  helper.
- Offline knowledge base covering first aid, water, food, shelter, hazards, and
  wellbeing, with 72-hour preparedness checklist.
- On-device assistant: BM25 retrieval over approved records, one bounded model
  completion, grounding and unsafe-advice validation, and a verbatim-record
  fallback.
- Crisis-language routing for self-harm, immediate medical emergencies, and
  wellness topics.
- Resumable model and map downloads with disk-space checks, atomic installs, and
  clear failure messages.
- Incremental offline map expansion around a new fix, MBTiles import, offline
  place search, and online address/routing fallbacks.
- SQLite persistence for identity, peers, messages, alerts, and checklist.
- Lite (arm64/x86_64) and full (arm64) build variants.
- Unit and in-process integration tests for protocol, mesh, chat, map maths,
  retrieval, and safety.

### Known limitations

- BLE runs only while the app is in the foreground.
- The mesh has no automatic DM key exchange; rooms are the reliable path.
- iOS has not been built.
- Voice and vision models are arm64-only.
- Release builds use the debug keystore until a production key is configured.
