# Troubleshooting

Start with the built-in diagnostics: **Kit → Device and data** shows radio state,
links, peers, frame counters, location status, battery, storage, and the last
transport error. Most field reports need those rows.

## Build and tooling

| Symptom | Cause | Fix |
| --- | --- | --- |
| `llama.rn` postinstall fails on Windows (`tar` tries to reach host `C`) | GNU tar reads a Windows drive path as a remote host | `bun run setup:native` |
| Gradle cannot find NDK/CMake | SDK components missing or wrong versions | Install NDK `27.1.12297006`, CMake 3.22+, SDK 36; reopen the project |
| `CactusEngine` missing or voice/vision disabled on x86_64 | Cactus 4.1 ships arm64 only; the bridge compiles to a stub | Use an arm64 device for voice/vision; x86_64 only supports the text model |
| Release APK has no `shruti.cact`/`mirage.cact` | Built with lite flags or a cached lite bundle | Clear generated JS bundle + autolinking, unset lite flags, rebuild (see below) |
| Lite APK still shows AI actions | Stale full JS bundle | Delete `app/build/generated/assets/...` and `index.android.bundle`, rebuild |
| `duplicate class` or native package mismatch after switching variants | Stale autolinking output | `rm -rf app/build/generated/autolinking ../build/generated/autolinking` |
| Metro cannot resolve `.cact` | Asset extension not registered | `metro.config.js` must add `cact` to `assetExts` |
| App opens to a blank screen in a debug build | Metro not reachable from the device | Same Wi-Fi, correct `adb reverse`, or build a release APK |
| Release build signed with debug key | Template default | Create a private keystore and a `release` signing config before distributing |

Clean variant build:

```sh
cd android
rm -rf app/build/generated/assets/createBundleReleaseJsAndAssets \
       app/build/intermediates/assets/release/mergeReleaseAssets \
       app/build/generated/autolinking ../build/generated/autolinking
find app/build -name index.android.bundle -delete
```

## Bluetooth / mesh

| Symptom | Meaning | What to check |
| --- | --- | --- |
| Radio `unauthorized` | Permission denied | Grant Nearby devices; Android 12+ needs Scan, Connect, Advertise; older Android needs fine location |
| Radio `unsupported` | No BLE hardware or adapter off | Physical device required; enable Bluetooth |
| Radio `scanning only` | Central works, native GATT server did not start | Rebuild so `MeshPeripheralModule` is registered; check logcat for the module |
| `0 links` | No connection was ever established | Range, permissions, Bluetooth on, both apps foreground |
| `1 link`, `0 peers` | Link is up, no announcement arrived | Frame delivery or MTU problem; report frame counters and last radio note |
| Peer appears briefly then vanishes | No announcement within 3 min TTL, or app backgrounded | Keep both apps open; presence stops when backgrounded |
| DM composer says "waiting for key" | No trusted X25519 key for that peer | Use a room; automatic DM key exchange is not implemented yet |
| File transfer never completes | Lost chunks, hash mismatch, or >4 MB | Retry in `#maps`; check both devices stayed in range |
| Messages send but nothing arrives after a relay | TTL exhausted or duplicate suppressed | Relay TTL is 8; direct packets are never relayed |

There is no foreground service. A locked or backgrounded phone stops scanning,
advertising, and relaying. This is expected, not a bug to work around silently.

Useful log filters:

```sh
adb logcat | grep -iE 'kindminds|MeshPeripheral|BluetoothGatt|ble'
```

## Map

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank map with a grid | No pack installed, or no tile at this zoom | Import/download a pack; zoom in/out; check Layers |
| "No tiles at this zoom" | Pack coverage ends here | Zoom out, or let auto-expansion run with a network |
| Map built around the wrong place | A stale or default fix was used | Onboarding requires a fresh fix; clear data and retry with location on |
| Tiles are "map data not yet available" placeholders | Tile provider has no imagery above z15 there | Expected with the default Esri source; use an authorised/self-hosted server |
| Pack never expands | Offline, no fix, moved <750 m, attempted <2 min ago, or 6,000-tile cap | Check connection and fix; enlarge/replace the pack manually |
| Imported pack not listed | File is not a valid MBTiles database | Verify with `sqlite3 file.mbtiles '.tables'`; `tiles` and `metadata` must exist |
| Tiles look blurry when zoomed | Overzoom beyond the pack | Expected; download a pack with deeper zoom |

The tile URL is in `src/services/region-pack.ts`. A self-hosted server must
return an `image/*` content type and real raster bytes; HTML error pages are
rejected by design.

## On-device models

| Symptom | Cause | Fix |
| --- | --- | --- |
| Voice/vision unavailable | x86_64 build, lite build, or bundled model missing | Use full arm64; run **Prepare → On-device models** to repair |
| Text answer falls back to the record | Model not downloaded, not loaded, timed out, or answer failed validation | Check the reason shown under the answer; download/load the model; retry |
| Download stops with MB saved | Socket dropped | Tap Download again; it resumes with an HTTP Range request from the `.part` file |
| "Ran out of free space" | Less than model size + ~96 MB margin | Free space and retry; the partial file is kept |
| Download says server error (4xx/5xx) | Model URL changed or is unavailable | Check the pinned URL; do not retry in a loop |
| Model loaded but output is gibberish | Runtime/format mismatch (e.g. a new GGUF architecture on an older llama.cpp) | Use the runtime version pinned in `package.json`; see the root README for model/runtime pairing |
| Emulator generation takes minutes | x86_64 emulation of a quantised 2B model | Expected; never use emulator timings as phone performance |

Model files live in the app's private `files/models/`. Removing a model in the
UI deletes the file and its manifest entry; the bundled voice/vision models are
copied back from the APK on the next launch unless the user removed them through
the app.

## Assistant behaviour

| Symptom | Meaning |
| --- | --- |
| "No approved answer" | Retrieval found no sufficiently close record. This is a safe refusal, not a failure. |
| Answer repeats the record verbatim | The model is absent, slow, or ungrounded; the fallback is intentional. |
| Self-harm message shows a support card | Crisis routing runs before generation. Follow the card, not a model answer. |
| Medical question routes to SOS | Emergency language intentionally prioritises the SOS action and approved record. |

Do not "fix" a safe refusal by loosening validation. If a legitimate record is
missing, add it to `src/core/knowledge.ts` with a test.

## Tests

| Symptom | Cause | Fix |
| --- | --- | --- |
| `bun test` cannot resolve `@/...` | Runner invoked outside the project or without the TS config | Run from the repo root: `bun test tests` |
| Type errors only in editor | Stale TS server | Restart the TS server / editor |
| Mesh test flakes on time | A test used real `Date.now` | Inject `now` into the engine or helper |
| Native module test fails in Node | Test imported a service instead of a core module | Move the logic under test into `src/core/` |

## Reporting a bug

Include:

- build variant and ABI, Android version, device model,
- exact steps, expected vs. actual,
- the **Kit → Device and data** values,
- `adb logcat` lines around the failure,
- whether it reproduces offline and after a fresh install.

Do not attach real location traces, personal messages, or model files. See
[SECURITY.md](../SECURITY.md) for vulnerabilities.
