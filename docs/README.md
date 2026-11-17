# KindMinds Kit documentation

KindMinds Kit is an Android, offline-first disaster survival companion. After
first-run setup it needs no network, SIM, account, or server: the map is a local
MBTiles pack, messaging is a Bluetooth LE mesh, and the assistant runs on-device
models over an approved offline knowledge base.

This directory documents how the system is built and how to work on it. The
[root README](../README.md) is the product overview and the source of truth for
model choices, AI safety behaviour, and release notes.

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the code layout and boot flow | [architecture.md](architecture.md) |
| Work on Bluetooth messaging or the wire protocol | [mesh.md](mesh.md) |
| Work on the offline map, tiles, or search | [offline-map.md](offline-map.md) |
| Understand what is stored and what touches the network | [data-and-privacy.md](data-and-privacy.md) |
| Build a debug or release APK | [build-and-release.md](build-and-release.md) |
| Run tests and manual device checks | [testing.md](testing.md) |
| Diagnose a build, radio, map, or model failure | [troubleshooting.md](troubleshooting.md) |

## Quick start

Requirements: Node 20+, Bun, JDK 21, Android SDK 36, NDK 27.x, CMake 3.22, and
an Android device or emulator.

```sh
bun install
bun run setup:native     # only if llama.rn's postinstall failed on Windows
bun run verify           # tsc --noEmit + unit tests
npx expo start           # Metro
npx expo run:android     # debug native build on a device/emulator
```

The first launch installs the local map and, in the full build, copies the
bundled Shruti and Mirage models out of the APK. The larger text model is an
optional download from **Prepare → On-device models**.

## Documentation conventions

- File paths are relative to the repository root.
- "Must" describes a safety or correctness invariant; do not relax it without a
  test.
- The pure TypeScript modules under `src/core/` are the specification for the
  mesh, geodesy, tiles, retrieval, and validation. When a document and the code
  disagree, the code and its tests win; fix the document in the same change.
- Do not commit model weights (`.gguf`, `.cact`, `.bin`), APKs, or screenshots.
  See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Repository map

```text
App.tsx                     app shell, tabs, SOS action, onboarding gate
src/screens/                Assist, Map, Chat, Kit, Onboarding
src/components/             map canvas, SOS sheet, model manager, UI primitives
src/state/                  app-level mesh, location, and model state
src/core/                   pure TypeScript: mesh, geo, tiles, chat, AI pipeline
src/core/ai/                retrieval, prompts, validation, model adapters
src/services/               device I/O: BLE, SQLite, files, downloads, location
android/                    Expo/React Native Android project + native bridges
tests/                      Bun unit and in-process integration tests
assets/models/              bundled .cact models (ignored by git)
scripts/setup-native.mjs    Windows native setup helper
```

## Related documents

- [CONTRIBUTING.md](../CONTRIBUTING.md) — workflow, code rules, review checklist.
- [SECURITY.md](../SECURITY.md) — reporting vulnerabilities and threat model.
- [CHANGELOG.md](../CHANGELOG.md) — notable changes.
