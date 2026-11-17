# Data, privacy, and permissions

KindMinds is designed to work without an account, a server, or telemetry. This
document lists exactly what is stored, where it goes, and what is not protected.

## Stored on the device

All app data lives in the app's private Android storage. The only database is
`kindminds.db` (SQLite, WAL mode), created by `src/services/storage.ts`.

| Table | Contents | Retention |
| --- | --- | --- |
| `settings` | onboarding flag, callsign, mesh identity secret, bundled-model marker | until erased |
| `peers` | peer ID, callsign, status, last-known position, accuracy, hops, last seen (public keys are **not** persisted) | latest row per peer, capped at 64 loaded |
| `messages` | room, DM, location, and file messages; sender, timestamps, hops, text | last 500 in memory; last 200 loaded at boot |
| `alerts` | SOS alerts and acknowledgements | last 50 loaded |
| `checklist` | 72-hour kit item IDs and packed state | until erased |

Files:

| Path | Contents |
| --- | --- |
| `files/models/` | installed model weights (`.gguf`, `.cact`) plus `manifest.json` |
| `files/map-packs/` | `.mbtiles` packs (downloaded, imported, or received) |
| `files/received-files/` | files received over the mesh |

The Ed25519 and X25519 secret keys are stored as hex in the `settings` table.
They are **not** encrypted at rest and are protected only by Android app
sandboxing and device lock. There is no keystore-backed wrapping yet.

## Erasing data

**Kit → Device and data → Erase everything** calls `eraseAllData`, which deletes
all rows from every table. It does not delete downloaded models, map packs, or
received files; those are managed separately in **Prepare → On-device models**
and **Layers**.

Uninstalling the app removes the private directory, including the mesh identity.
Reinstalling creates a new peer ID, so previous contacts will see a new node.

Android backup: the manifest sets `android:allowBackup="true"`. On devices with
Google backup enabled, app-private data may be included in the user's cloud
backup. For a stricter deployment, set `allowBackup=false` and provide an
explicit export path.

## Network activity

Nothing is sent automatically except the requests needed to install optional
content. There is no analytics, crash reporting, advertising SDK, or remote
config.

| Trigger | Destination | Data sent | Required |
| --- | --- | --- | --- |
| Onboarding map download | configured tile server (Esri by default) | z/x/y tile requests and a User-Agent | only if the user keeps "Download map" on |
| Map auto-expansion | same tile server | tile requests around the new fix | optional, silent on failure |
| Address search | `nominatim.openstreetmap.org` | search text and User-Agent | only on submit |
| Directions | `router.project-osrm.org` | start/end coordinates | only on Directions |
| Text model download | Hugging Face model URL | file request and User-Agent | only when the user taps Download |
| Voice/vision model download | Hugging Face model URLs | file request and User-Agent | only if missing and the user downloads |

Not sent anywhere: chat messages, SOS alerts, peer list, location history,
checklist, assistant questions, voice recordings, photos, or model prompts.
Those stay in the process or on disk.

The map and model servers necessarily learn the device's IP address and the
requested resource. Tile requests reveal the approximate area being downloaded.
Self-host the tile server and mirror the models if that matters for your
deployment.

## Permissions

Declared in `app.json` / `AndroidManifest.xml`:

| Permission | Why | If denied |
| --- | --- | --- |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | place the user on the offline map, stamp SOS coordinates, build the first pack | no blue dot, no position in SOS, onboarding cannot build a local map |
| `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE` (Android 12+) | discover peers, connect, run the GATT server | radio reports `unauthorized`; Chat cannot find peers |
| `ACCESS_FINE_LOCATION` on Android 11 and older | required by the BLE stack | same as above |
| `RECORD_AUDIO` | voice input only while the mic button is held/active | voice input disabled; text still works |
| `FOREGROUND_SERVICE` | declared for future/background work | no effect today; BLE stops when backgrounded |
| `INTERNET` | optional map/model downloads and online search | app remains fully usable offline |
| `VIBRATE` | haptic feedback | no effect |
| `READ/WRITE_EXTERNAL_STORAGE` | declared by the Expo template for legacy pickers | modern builds use the system file picker and do not need broad storage access |

`BLUETOOTH_SCAN` is declared with `neverForLocation`: peer positions come from
GPS, never from BLE scan results. Without that flag, Android 12+ filters scan
results unless fine location was granted, which looks exactly like "no peers".

## Voice and photos

- Voice input captures a 16 kHz mono PCM stream, wraps it in a temporary WAV,
  converts it to text through the on-device Shruti model, then deletes the file.
  Audio never leaves the device.
- Photos are chosen through the system file picker, copied to the app cache,
  described by the on-device Mirage model, then deleted. The image is not
  uploaded and is not added to the chat unless the user explicitly attaches
  something.
- The assistant's prompt and answer stay in memory. The answer is not written to
  SQLite.

## Mesh exposure

The mesh is not a private network. Assume anyone in radio range can observe:

- your callsign, status, and announced position,
- every room message, SOS, location ping, and file transfer,
- the fact that a sealed DM was sent, its size, timing, sender, and recipient,
- your peer ID, which is stable for the installation.

Direct text is sealed with XChaCha20-Poly1305, but there is no forward secrecy,
no automatic key exchange yet, and no signature on announcements. A relay can
claim a callsign. Read [mesh.md](mesh.md#identity-and-cryptography) for the full
model before treating DMs as confidential.

## Threat model summary

| Protected | Not protected |
| --- | --- |
| Direct message contents in transit (once keys are trusted) | Metadata: who talked to whom, when, and from where |
| Files against accidental corruption (SHA-256) | File contents in transit (broadcast, unsealed) |
| Chat history from other apps (Android sandbox) | Data at rest against a rooted/compromised device |
| App function without network or account | Availability against radio jamming or battery loss |

This is a disaster-response tool, not a replacement for a hardened messenger.
See [SECURITY.md](../SECURITY.md) for reporting vulnerabilities.
