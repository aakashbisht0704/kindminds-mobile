# Changelog

All notable changes to KindMinds Kit are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning once it reaches a stable release.

## [Unreleased]

### Changed

- On-device text model replaced with PrismML **Ternary Bonsai 2 2B**
  (`Ternary-Bonsai-2-2B-Q2_0.gguf`, Apache-2.0), running on `llama.rn`
  0.13.0-rc.12. The previous runtime could not execute the model's
  Hadamard-rotated ternary weights.
- Assistant prompts and validation updated for the text model's chat template.
- Bundled voice (Shruti) and vision (Mirage) models are unchanged.

### Fixed

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
