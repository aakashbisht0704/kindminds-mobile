# Testing

KindMinds has three layers of verification: static typing, in-process unit and
integration tests, and manual device checks for anything that touches a radio,
GPS, camera, microphone, or the file system.

## Commands

```sh
bun run typecheck     # tsc --noEmit
bun test tests        # Bun test runner
bun run verify        # both, in that order
```

Run `bun run verify` before every commit. A release candidate also needs the
manual checklist below; unit tests cannot prove that two phones find each other.

## What the test suite covers

| File | Focus |
| --- | --- |
| `tests/protocol.test.ts` | header round-trips, rejection of malformed packets, fragmentation, duplicate suppression, relay policy, payload decoding, SOS ranking |
| `tests/mesh.test.ts` | announcements, rooms, relaying, SOS, sealed DMs, identity restore, canonical wire behaviour |
| `tests/mesh-extended.test.ts` | rooms, DMs, location pings, file transfer and SHA-256 rejection, SOS ranking |
| `tests/mesh-presence.test.ts` | automatic presence, refresh without duplication, TTL expiry, same-second announce IDs |
| `tests/chat.test.ts` | room filtering, DM timelines, summaries for out-of-range peers, previews, day labels, proximity order |
| `tests/places.test.ts` | coordinate parsing, offline place filtering, online fallback, route framing |
| `tests/tiles.test.ts` | raster magic validation, ancestor tiles, MBTiles TMS conversion |
| `tests/map-pan.test.ts` | drag-to-pan direction and zoom anchoring |
| `tests/local-llm.test.ts` | prompt construction, grounded/rejected answers, fallback reasons, output tidying, timeouts |
| `tests/safety.test.ts` | crisis routing and dangerous medical advice rejection |
| `tests/cactus.test.ts` | Mirage output normalisation and Shruti text handling |

Core tests run without a device. The mesh tests feed frames into
`MeshEngine.ingestFrame` and assert on emitted events and relay output, so a
protocol change is caught before it reaches a phone. Randomness and time are
injected into the engine and crypto helpers, which keeps tests deterministic.

## Writing a test

- Prefer a core module test over a screen test. If logic is hard to test, move it
  into `src/core/` first.
- Inject `random` and `now` rather than mocking global `Math.random` or
  `Date.now`.
- For mesh tests, use two or three engines and deliver `framesFor(packet)` in
  both directions. Assert on `history()`, `activePeers()`, `sosAlerts()`, and
  returned relay frames.
- For safety tests, include the negative case: unsafe wording must be rejected
  even when it is topically grounded.
- Never require a network, a model file, or a real radio in a unit test.

## Manual checks

### First launch and onboarding

1. Clear app data or uninstall, then launch the full arm64 build.
2. Walk through all four slides. The map install uses a **fresh** fix; deny
   location and confirm it asks for a retry instead of building a default map.
3. With "Download map" on, confirm the pack reaches 100% and Map opens with
   local streets.
4. Confirm Shruti and Mirage are reported as included/ready in the full build.
5. Force-stop and relaunch: onboarding must not repeat.

### Offline map

1. Turn on airplane mode. Pan, pinch, and use +/−. Tiles already in the pack
   must still render; overzoom must scale rather than blank.
2. Search for a typed coordinate and a peer/SOS name. On-device results must
   appear without a network.
3. Press Directions with no network: a direct line and distance must be shown.
4. Move more than 750 m outside the detailed ring (or simulate a fix), then
   confirm the expansion notice and newly available tiles.
5. Import an `.mbtiles` file from storage and confirm it appears in Layers.

### Chat, SOS, and files

1. Grant Nearby devices. Open Chat and confirm a peer appears within ~15 s.
2. Send a room message, a location ping, and a small file in `#maps`; confirm
   delivery ticks and that the receiver saves the file.
3. Trigger an SOS with defaults. Confirm the receiver sees distance and needs,
   and that "I can help" returns an acknowledgement.
4. Force-stop both apps and reopen: room previews, DM timelines, and alerts must
   survive.
5. Compose a message with no peer in range. It should be held and sent when a
   link appears, or remain marked unsent after three minutes.

### Assistant and safety

1. Ask an ordinary first-aid question and confirm the answer follows the
   approved record.
2. Ask a question with no matching record and confirm the app says it does not
   have an approved answer rather than inventing one.
3. Use self-harm language and confirm the supportive card, grounding steps, and
   breathing reset appear before any model answer.
4. With the text model absent, confirm the record is shown with a clear reason
   and the action to download the model.
5. With the model present, confirm a slow or ungrounded generation falls back to
   the record instead of showing invented advice.

## Two-phone mesh test

The mesh has no servers: two phones must find each other over Bluetooth LE. Use
two physical Android phones, both unlocked, app open on Chat.

1. Install the same build on both phones.
2. Grant **Nearby devices** (Bluetooth). Bluetooth must be on and phones within a
   few metres.
3. Open **Chat**. Within ~15 seconds each phone should show a link, then a peer.
4. Interpret the counters:
   - `0 links` — the radios never connected.
   - `1 link`, `0 peers` — the link is up but no announcement arrived; this is a
     frame-delivery problem, not discovery.
5. Send a room message each way. Then background one phone and confirm its peer
   expires after the TTL.
6. Reopen and confirm presence returns without tapping Announce.

Report the **Kit → Device and data** rows with any bug: `Radio`, `Links`,
`Frames out / in`, and `Last radio note`.

## Variant smoke test

After switching between lite and full, verify the bundle actually changed:

```sh
unzip -l android/app/build/outputs/apk/release/app-release.apk | grep -E 'shruti|mirage|librnllama'
```

- Full arm64: `shruti.cact`, `mirage.cact`, and llama libraries present.
- Lite: none of them present, and AI actions hidden or disabled.

Also install over the previous build and confirm the app does not show a full-AI
screen backed by lite native code (the classic stale-bundle symptom).

## Device matrix

| Device | Why |
| --- | --- |
| Android 12+ phone, arm64 | primary target: split BLE permissions, Cactus AI, GATT server |
| Android 7–11 phone, arm64 | legacy location permission path for BLE |
| x86_64 emulator, 4 GB | UI, storage, map, and text-model flow; no Cactus voice/vision |
| Two physical phones | the only valid mesh verification |

## Release checklist

- [ ] `bun run verify` passes.
- [ ] Version bumped in `app.json`, `package.json`, and `build.gradle`.
- [ ] Variant (lite/full) and ABI are intentional; generated bundles cleared
      before the build.
- [ ] Full arm64 APK contains bundled models; lite APK does not.
- [ ] Fresh-install onboarding tested offline after download.
- [ ] Two-phone mesh test passed on the final build.
- [ ] SOS send and acknowledge tested on two phones.
- [ ] Airplane-mode assistant, map, chat history, and checklist tested.
- [ ] APK checksum recorded with the release notes.
