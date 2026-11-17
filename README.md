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
- on-device text generation with **Woof 2B** via `llama.rn` (GGUF)
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
| Woof 2B text | later | 1.56 GB | `ConwayResearch/woof-2B-1.1-GGUF` |

Shruti and Mirage are packaged inside the full APK; onboarding copies them into
app storage, so they do not need a connection. Woof is deliberately absent from
the APK: it is an optional download from **Prepare → On-device models**. Shruti
and Mirage run through the official **Cactus 4.1** engine, linked into the app's
native library (`android/app/src/main/cpp/cactus_bridge.cpp`), because the
`cactus-react-native` wrapper does not implement the Whistle (Shruti) or Mirage
architectures. Woof runs through `llama.rn` with the GGUF chat template.
Downloads are atomic: an interrupted install never destroys a working model or
map.

A 1.56 GB download does not survive a mobile connection in one piece, so Woof is
fetched in a way that can be resumed. The bytes land in `…gguf.part`, a dropped
socket is retried three times from the bytes already on disk, and a tap on
**Download Woof 2B** after a failure asks the server for the rest with an HTTP
`Range` request instead of starting over. Free space is checked before the
transfer starts, the `.part` file is kept after a failure so the next tap
continues from it, and the in-place rename only happens when the file matches
the expected size. The same path is used for the map pack.

The local map is built from a two-tier raster pyramid around a **fresh location
fix**: a wide z8–12 context pyramid plus a close z13–15 street-level ring.
Onboarding waits for that fix and refuses to silently build a map around a
default or stale place; if no fix is available it asks the user to retry. The
pack is a standard MBTiles file, and tiles overzoom cleanly up to z18 when the
pack stops earlier. `TILE_URL` in `src/services/region-pack.ts` defaults to
Esri World Street Map for first-run setup; production deployments should point
it at an authorised or self-hosted tile server. The initial pack is written
with SQLite `VACUUM INTO`, so it is one self-contained file with no WAL sidecar;
later expansions commit in place.
Panning follows the finger: drag down to move the view north (revealing the
area above), and drag up to move south. Pinch or the +/− controls zoom; the
dock shows when the current zoom is overzoomed beyond the pack.

When a fix moves outside the detailed ring, the Map screen grows the pack
automatically if the tile server is reachable. It downloads only the missing
z13–15 tiles around the new position, or a new z8–12 context ring if the user
has left the old area entirely. Existing tiles are skipped, the pack metadata
bounds are extended, and the update is committed atomically. A 6,000-tile cap
keeps the pack from growing without bound. Offline attempts fail quietly and
retry when the connection returns.

The search sheet always lists on-device results first (your fix, nearby peers,
SOS pins, map centre, typed coordinates). Address lookup uses OpenStreetMap
Nominatim and road routing uses OSRM **only when the user submits a search or
presses Directions**; both fail silently to an offline direct line. Route views
frame both ends of the route, and navigation keeps you centred with distance,
bearing, and an End control.

## Chat

The tab is called **Chat**. The pinned room stays at the top, then the people
closest to you sorted by distance, then the remaining room chips. Tapping a room
or person opens a WhatsApp-style thread with bubbles, day dividers, delivery
ticks, sender names in rooms, and a composer with attachments. Past conversations
collapse into a section below instead of cluttering the first screen.

- **Rooms** broadcast to every node in range: `#general` (pinned), `#local`,
  `#maps`, `#wellness`.
- **People nearby** open an end-to-end sealed text DM. Past conversations stay
  readable when the peer is out of range; sending resumes when they return.
- **Location** is a pin message and updates the Map marker.
- **Files and map packs** are shared in `#maps`; direct file transfer is not
  sealed yet, so the UI does not pretend it is.
- Outgoing and incoming messages are persisted in SQLite, so room previews and
  threads survive a force-stop or restart.

## Assist and SOS

The Assist tab is the front door: a voice-first conversation over the on-device
models. It answers from the approved record set, routes to breathing, SOS, kit,
chat, and map, and never invents doses, diagnoses, or first-aid steps. The
preparedness checklist opens from Assist as a sheet, with the three highest-
priority missing items first and the full 18-item list behind a toggle.

SOS is always one tap away. The tab-bar button opens a sheet whose primary
action sends immediately with safe defaults (medical, one person, current fix)
without scrolling or filling fields. Details are optional and below the send
action; incoming alerts show distance and an “I can help” acknowledge action.

## Models and licences

| Role | Model | Format | Licence |
| --- | --- | --- | --- |
| Text | Underdog **Woof 2B 1.1** | GGUF Q4_K_M, 1.56 GB | CC BY-NC 4.0 (non-commercial) |
| Voice | Udgam **Shruti** | 16 kHz WAV → text, `.cact`, 28 MB | Apache-2.0 |
| Vision | Cactus **Mirage** | image → text/scene, `.cact`, 21 MB | Apache-2.0 |

Woof is the text model in Underdog’s Android app. It is **non-commercial**:
commercial use needs a separate licence from Conway/Underdog. Shruti is tuned
for Hindi, Hinglish and Indian English; Mirage is a 22 MB vision model for
labels, signs, objects and hazards.

The Cactus runtime only ships **arm64-v8a** Android libraries, so the **shipped**
full AI build is arm64-only. An x86_64 debug build still exercises Woof
(`llama.rn` has x86_64 libraries); Shruti and Mirage stay unavailable there.

## AI safety

The assistant never invents first-aid content. It retrieves an approved record
and Woof may only rephrase it. Shruti fills a text field, and Mirage only
describes visible content; neither is allowed to diagnose or prescribe. Two gates protect the output:

1. `isGrounded` rejects answers that do not share vocabulary with the record.
2. `containsUnsafeAdvice` rejects dosages, diagnoses, new medicines, injections,
   and similar advice even when the wording is otherwise grounded.

Crisis language is routed by `assessQuery`: self-harm gets a supportive card,
grounding steps, and a breathing reset; immediate medical language points to
SOS and the approved record. Wellness queries route to grounding, grief, sleep,
anger, or loneliness records.

## Build

Requirements: Node 20+, Bun, JDK 21, Android SDK 36, NDK 27.x, CMake 3.22.

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
| Full arm64 | 103 MB | map, Chat, SOS, records, bundled Shruti + Mirage, optional Woof |
| Lite arm64 | 29 MB | map, Chat, SOS, records, wellbeing; no model weights |
| Lite x86_64 | 29 MB | emulator/UI build; no model weights or AI native libs |

A **full** (non-lite) `x86_64` debug build is the way to exercise Woof in the
emulator: `llama.rn` ships x86_64 libraries, so the text model downloads, loads
and answers there, while the Cactus bridge compiles to an empty stub. That makes
Shruti and Mirage unavailable on the emulator, but the Assist rephrasing flow is
testable end to end. The emulator has no NEON and runs the 2B model at roughly
2 tokens/second, so expect 45–60 seconds for one four-sentence answer; a phone
is several times faster.

The lite build swaps in an empty model-asset manifest, so it carries no Shruti
or Mirage weights, and strips the llama/Cactus native libraries. The full APK
is the one to install on a phone.
libraries. It still installs the local map and keeps the approved records,
Chat, SOS, and wellbeing tools. The full build adds Woof rephrasing, Shruti
voice input, and Mirage vision.

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
npm run verify          # tsc --noEmit + 118 unit tests
```

Tests cover the mesh protocol, fragmentation, relay policy, rooms, DMs,
location messages, file transfer and SHA-256 rejection, chat derivations, tile
validation, coordinate/offline place search, route framing and fallback, map
pan direction, SOS payloads, local-LLM grounding/fallback, and crisis routing.

### Woof download and chat flow (emulator)

Run this against a full `x86_64` debug build on a 4 GB AVD, because loading the
2B model next to the running app needs the headroom:

```sh
cd android
./gradlew app:assembleDebug -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

1. **Prepare → On-device models → Download Woof 2B.** The progress bar should
   start at the percentage already on disk, not at zero.
2. Put the emulator in airplane mode mid-download. After three quick retries the
   card says the connection dropped and how many MB are saved; the `.part` file
   stays in `files/models`.
3. Leave airplane mode on, close the app, reopen it and tap **Download Woof 2B**.
   The transfer continues from those MB and finishes at 1.5 GB.
4. **Assist → Heavy bleeding → Say it in plain words.** The action appears as
   soon as the download finishes, without restarting the app; the answer card
   shows a four-sentence paragraph above "In plain words".
5. Repeat with a short deadline (a few seconds) to prove the fallback: the card
   shows *The local model could not phrase this in time* instead of repeating the
   record, and the next attempt still generates.

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


## Known limits

- Two-phone BLE mesh testing is still required on physical hardware each time
  the transport changes; the emulator verifies advertising and the GATT server
  compiles and starts.
- BLE only runs while the app is in the foreground. There is no foreground
  service, so a locked or backgrounded phone stops relaying.
- iOS has not been built in this workspace.
- Cactus (Shruti/Mirage) is arm64-only; the full AI APK is arm64.
- Woof 2B is CC BY-NC 4.0 (non-commercial).
- The default Esri World Street Map endpoint is for setup; use an authorised or
  self-hosted tile source for production. Esri serves “map data not yet
  available” placeholders above z15 in some areas, so the default pack stops at
  z15 and overzooms from there.
- Auto-expansion needs both a fresh fix and reachability to the tile server. If
  either is missing, the existing pack stays usable and the app retries later.
- Online place search and road routing need a connection. Without one, search
  still covers on-device places and directions fall back to a direct line.
- Direct text DMs are sealed. Location pings are addressed to a peer but not
  encrypted; files and map packs are shared in `#maps`, not sealed DMs.
