# Build and release

## Requirements

| Tool | Version |
| --- | --- |
| Node | 20+ |
| Bun | current (lockfile is `bun.lock`) |
| JDK | 21 |
| Android SDK | 36 |
| Android NDK | 27.1.12297006 |
| CMake | 3.22+ |
| Device/emulator | Android 7.0 (API 24) or newer |

The generated Android project sets `minSdk 24`, `targetSdk 36`, `compileSdk 36`,
Hermes, and the React Native New Architecture.

## Install and run

```sh
bun install
bun run setup:native     # Windows only, and only if llama.rn's postinstall failed
bun run verify           # tsc --noEmit + unit tests
npx expo start           # Metro dev server
npx expo run:android     # debug build + install
```

`setup:native` repairs llama.rn's postinstall on Windows/Git Bash, where GNU tar
misreads `C:\...` as a remote host. It is safe to run repeatedly.

## Build variants

| Variant | Abi | Contents | Approx. size |
| --- | --- | --- | --- |
| Full | arm64-v8a | map, mesh, SOS, records, bundled voice + vision models, optional text model download | ~103 MB |
| Lite | arm64-v8a | map, mesh, SOS, records, wellbeing; no model weights or AI native libs | ~29 MB |
| Lite | x86_64 | emulator/UI build; no model weights or AI native libs | ~29 MB |

The lite flag is applied in two places and both matter:

- `EXPO_PUBLIC_KINDMINDS_LITE=1` makes Metro resolve `./model-assets` to
  `model-assets.lite.ts`, so no `.cact` files are packaged.
- `-PkindmindsLite=true` makes Gradle exclude `librnllama*.so` and
  `librnwhisper*.so`.

The full AI build is **arm64-only** because the Cactus 4.1 static archive ships
only arm64 Android libraries. On x86_64 the Cactus bridge compiles to an empty
stub: Shruti and Mirage are unavailable, while the text model can still run.

### Bundled model files

`assets/models/` is ignored by git, so a fresh clone cannot build the full
variant until the two bundled `.cact` files are present:

```text
assets/models/shruti.cact    # voice
assets/models/mirage.cact    # vision
```

Download them from the URLs pinned in `MODEL_URLS` in
`src/services/downloads.ts` (or copy them from a release artifact) before
running the full build. Metro packages them into the APK; onboarding copies them
into app storage on first run. Do not commit them.

## Release build

```sh
cd android
./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

> **Signing:** the repository's `release` build type is currently signed with the
> debug keystore. That is fine for internal test builds and not acceptable for
> distribution. Before publishing, create a private keystore, add a
> `signingConfigs.release` block, and keep the keystore and passwords out of git.

### Switching between lite and full

Expo inlines `EXPO_PUBLIC_*` values into the JS bundle, but Gradle does not treat
that environment value as a task input. A stale bundle from the previous variant
will otherwise ship inside the new APK. Delete generated assets before switching:

```sh
cd android

# Always: drop the previous JS bundle.
rm -rf app/build/generated/assets/createBundleReleaseJsAndAssets \
       app/build/intermediates/assets/release/mergeReleaseAssets
find app/build -name index.android.bundle -delete

# Always: drop generated autolinking so a stale PackageList.java cannot leak
# one variant's native packages into the other.
rm -rf app/build/generated/autolinking ../build/generated/autolinking

# Full AI build (arm64): force the full bundle and unset lite flags.
env -u EXPO_PUBLIC_KINDMINDS_LITE -u KINDMINDS_LITE \
  ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a

# Lite arm64.
EXPO_PUBLIC_KINDMINDS_LITE=1 ./gradlew app:assembleRelease \
  -PkindmindsLite=true -PreactNativeArchitectures=arm64-v8a

# Lite x86_64 (emulator).
EXPO_PUBLIC_KINDMINDS_LITE=1 ./gradlew app:assembleRelease \
  -PkindmindsLite=true -PreactNativeArchitectures=x86_64
```

A quick sanity check on the APK:

```sh
unzip -l app/build/outputs/apk/release/app-release.apk | grep -E 'shruti|mirage|librnllama'
```

The full arm64 APK contains `shruti.cact` and `mirage.cact`; the lite APK does
not.

## Debug build

```sh
cd android
./gradlew app:assembleDebug -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

For the text model on an emulator, use a 4 GB AVD: loading a 2B model alongside
the running app needs headroom. Without the Cactus arm64 archive, voice and
vision stay disabled on x86_64.

For a debug build on a phone, use the device's ABI (`arm64-v8a`) and install the
resulting APK. Metro must be reachable for a debug JS bundle unless you build a
release APK.

## Native pieces

### Cactus 4.1 bridge

`react-native.config.js` excludes `cactus-react-native` on Android. Its bundled
engine does not implement the Whistle (Shruti) or Mirage architectures and only
reads the older unpacked weight-directory format. Voice and vision instead use
`android/app/src/main/cpp/cactus_bridge.cpp`, which links the arm64
`libcactus.a` and exposes `loadModel`, `transcribe`, and `describe` to JS as the
`CactusEngine` native module.

`CMakeLists.txt` builds the bridge only for `arm64-v8a`; every other ABI gets
`cactus/dummy.cpp`. The engine is deliberately outside `appmodules`, so a fault
in the third-party engine cannot take the app down at React startup.

The vendored `android/app/src/main/cpp/libcactus.a` is required to build the full
arm64 variant and is committed to the repository. Model weights are not.

### Mesh peripheral

`android/app/src/main/java/org/kindminds/kit/MeshPeripheralModule.kt` advertises
the mesh service and runs a `BluetoothGattServer`. `MeshPeripheralPackage.kt`
registers it. `react-native-ble-plx` remains the central role.

## Distribution artifacts

Build outputs are not committed. The local `dist/` folder is ignored and is only
a convenience copy of built APKs. Publish releases through GitHub Releases or an
internal distribution channel, with checksums and the matching source commit.

## CI outline

A minimal pipeline:

1. `bun install --frozen-lockfile`
2. `bun run verify`
3. `./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a`
4. Upload the APK as an artifact (never commit it).

A release job additionally needs the Android SDK/NDK, a private keystore from
CI secrets, and a tagged version. Do not put model weights in CI cache; download
them from the pinned model URLs when building the full variant.

## Versioning

`app.json`, `android/app/build.gradle` (`versionName`, `versionCode`), and
`package.json` all carry `0.1.0`. Bump them together. `versionCode` must increase
for every distributed Android build.
