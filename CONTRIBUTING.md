# Contributing

KindMinds Kit is a safety tool. Changes to first-aid content, crisis routing, AI
validation, or the mesh protocol need more care than a typical UI change.

## Before you start

- Read [docs/architecture.md](docs/architecture.md) and the document for the area
  you are changing.
- For a non-trivial change, open an issue first so the approach can be agreed.
- Never commit model weights (`.gguf`, `.cact`, `.bin`), APKs, `dist/`, build
  directories, or device screenshots. They are ignored; keep them that way.
- Do not weaken a safety check, encryption, or a degraded-mode warning without a
  test and a written rationale.

## Setup

```sh
bun install
bun run setup:native     # Windows only, if llama.rn's postinstall failed
bun run verify
npx expo start
```

See [docs/build-and-release.md](docs/build-and-release.md) for device builds and
variant switching.

## Where code goes

| Change | Location |
| --- | --- |
| Protocol, crypto, geodesy, tiles, retrieval, validation | `src/core/` (pure TypeScript, no RN imports) |
| Device APIs (BLE, SQLite, files, GPS, downloads) | `src/services/` |
| Shared lifetime state | `src/state/` |
| Screens and visual components | `src/screens/`, `src/components/` |
| Approved first-aid / wellbeing content | `src/core/knowledge.ts` |
| Wire format or packet behaviour | `src/core/mesh/protocol.ts` + tests |
| Android native module or Cactus bridge | `android/app/src/main/` |

Rules:

- Core modules must not import React Native, Expo, or services.
- Services expose small typed interfaces; screens derive state during render
  instead of duplicating peers, alerts, or messages.
- A second `MeshEngine` or location watcher is a bug: both are process-wide.
- New user-visible capabilities need a degraded path for no fix, no pack, no
  radio, no model, and no network.

## Tests

```sh
bun run verify        # tsc --noEmit + bun test tests
```

- Add a test for every behaviour change in `src/core/`.
- Use injected `random` and `now`; do not mock globals.
- Mesh tests should use two or three engines and real frames.
- Safety tests must include the unsafe negative case.
- Manual device checks are required for radio, GPS, camera, microphone, or file
  system changes. See [docs/testing.md](docs/testing.md).

## Medical and wellbeing content

- Base content on IFRC, WHO, or Sphere guidance.
- Write short imperative steps for a non-medic under stress.
- Include an explicit "stop and get help" line where a procedure can go wrong.
- Never add doses, diagnoses, new medicines, or injection instructions.
- The model may rephrase a record; it may not add facts.
- Cite the source in the entry and add a retrieval/safety test.

## Style

- TypeScript strict mode; no `any` unless a platform boundary forces it.
- Prefer small pure functions and explicit return types at module boundaries.
- Comments explain *why*, especially for safety and radio behaviour. Do not
  narrate the code.
- Follow the existing formatting (2 spaces, single quotes, trailing commas).
- Keep UI copy calm and literal. No decorative jargon in an emergency.
- Accessibility: every control needs a role/label, and touch targets should meet
  the existing `hitSlop` and size conventions.

## Commits

Use an imperative subject line, optionally scoped:

```text
mesh: relay direct packets never
map: reject HTML tile responses
assistant: fall back when the model is ungrounded
docs: document the lite/full build switch
```

Keep commits focused. Do not mix a refactor with a safety change. Reference an
issue when one exists.

## Pull requests

Before opening:

- [ ] `bun run verify` passes.
- [ ] New behaviour has a test.
- [ ] Safety, crypto, or protocol changes explain the invariant being preserved.
- [ ] Docs updated (`docs/` and root `README.md` for user-visible changes).
- [ ] No secrets, model weights, APKs, `dist/`, or generated build output.
- [ ] Manual device checks noted (device, Android version, variant, result).
- [ ] Screenshots or a short recording for UI changes.

The PR template repeats this checklist. Reviewers should reject a change that
makes a failure mode quieter without making it safer.

## Licence

The repository does not currently declare a code licence. By contributing you
agree that your contribution can be distributed under the licence the project
adopts. Third-party model weights and tiles keep their own licences; see the
root README and [docs/data-and-privacy.md](docs/data-and-privacy.md).
