# Mesh: Bluetooth transport and KMP/1 protocol

The mesh is the app's only communication path. There is no server, no account,
and no internet requirement: phones in Bluetooth range exchange frames directly,
and any phone can relay broadcast traffic further.

Two modules own the work:

- `src/core/mesh/engine.ts` — routing, dedupe, relaying, rooms, DMs, SOS, files.
  It has no Bluetooth or React Native imports and is exercised by the test suite
  in-process.
- `src/services/ble-mesh.ts` — the radio. It moves opaque frames and makes no
  routing decisions.

Keeping the protocol out of the transport is what makes a two-phone system
testable without two phones.

## Transport

| Property | Value |
| --- | --- |
| Service UUID | `7f3a6b10-9c4d-4e21-8f77-2a5b9e0c1d34` |
| Frame characteristic | `7f3a6b11-9c4d-4e21-8f77-2a5b9e0c1d34` |
| Announce characteristic | `7f3a6b12-9c4d-4e21-8f77-2a5b9e0c1d34` |
| Requested ATT MTU | 512 bytes |
| Protocol floor | 23-byte MTU |
| Max simultaneous links | 7 (Android's practical GATT ceiling) |
| Reconnect cooldown | 8 seconds |
| Link stale timeout | 120 seconds |

- **Central role** uses `react-native-ble-plx`: scan, connect, request MTU,
  subscribe to the frame characteristic, write frames.
- **Peripheral role** uses the native Android `BluetoothGattServer` in
  `MeshPeripheralModule.kt`, exposed through `src/services/ble-peripheral.ts`.
  It advertises the service and receives writes without first connecting to
  another phone.
- **Frame budget.** A single write must fit the negotiated MTU:
  `budget = mtu - 3 (ATT overhead) - 13 (mesh frame header)`, clamped between 7
  and 360 bytes. The engine fragments to this budget. A frame larger than the
  MTU is rejected by the stack, which is indistinguishable from a silent send.
- **Links** are counted only after a write is accepted by that peer. A phone
  reachable over both roles is counted once. A failed write drops the link
  instead of leaving a dead entry that keeps swallowing frames.
- **Permissions.** Android 12+ requests `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`,
  and `BLUETOOTH_ADVERTISE`; older versions use fine location.

The radio state is one of `off`, `unauthorized`, `unsupported`, `scanning`,
`ready`, or `error`. `scanning` means the central path works but the peripheral
path did not start; the UI surfaces this as "scanning only".

## Wire format (KMP/1)

All integers are big-endian. The header is fixed-width; the payload is a UTF-8
or JSON blob whose shape depends on the packet type.

### Packet header (35 bytes)

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 2 | magic `0x4b 0x4d` ("KM") |
| 2 | 1 | protocol version (`1`) |
| 3 | 1 | packet type code |
| 4 | 1 | TTL / hop budget |
| 5 | 4 | creation time, seconds since epoch |
| 9 | 8 | message ID (random) |
| 17 | 8 | sender peer ID |
| 25 | 8 | recipient peer ID, or zeroes for broadcast |
| 33 | 2 | payload length |

Limits: `MAX_PAYLOAD_BYTES = 8192`, `MAX_TTL = 8`. A packet with bad magic, an
unknown version, an unknown type, a payload over the limit, or a length mismatch
is rejected without throwing.

### Packet types

| Code | Name | Purpose | Relayed |
| ---: | --- | --- | --- |
| 1 | `announce` | callsign, skills, status, position | yes |
| 2 | `message` | legacy untagged broadcast text | yes |
| 3 | `sos` | location, people, needs, note | yes |
| 4 | `ack` | acknowledge an SOS | yes |
| 5 | `direct` | sealed one-to-one text | **never** |
| 6 | `room` | tagged broadcast text | yes |
| 7 | `fileMeta` | name, size, chunk count, SHA-256 | yes |
| 8 | `fileChunk` | base64 chunk | yes |
| 9 | `location` | explicit position ping | yes |

`message` exists for older clients; current builds send `room`.

### Fragmentation

BLE writes are small, so a packet is split into frames:

```text
frame = "KF" | version(1) | fragmentId(8) | index(1) | total(1) | data(n)
```

- The frame header is 13 bytes; `data` defaults to 360 bytes and shrinks to the
  radio's negotiated budget.
- `fragmentId` is the packet's message ID (bytes 9–16), not the header prefix.
  Two packets of the same type sent in the same second therefore get separate
  reassembly buffers.
- A packet may use at most 255 frames.
- `FragmentAssembler` tolerates out-of-order and duplicate frames, keeps at most
  16 partial buffers, and evicts them after 45 seconds.
- Malformed frames are ignored; they never throw or create a message.

### Dedupe and relay

- `SeenCache` is keyed by `senderId:messageId`, holds 512 entries, and expires
  after 10 minutes. Insertion order doubles as an LRU, so memory is bounded no
  matter how loud the neighbourhood gets.
- Broadcast, SOS, room, file, and location traffic is relayed with TTL − 1 until
  TTL reaches 1.
- Sealed `direct` packets are **not** relayed: a packet addressed to someone
  else is not ours to carry beyond the neighbours it already reached.
- A node ignores its own traffic if it loops back through a relay.

## Identity and cryptography

Each installation has two keypairs, generated once and stored in SQLite:

- **Ed25519** for signing (`signSecretKey`, `signPublicKey`).
- **X25519** for key agreement (`boxSecretKey`, `boxPublicKey`).

The peer ID is the first 8 bytes of SHA-256 of the Ed25519 public key, rendered
as 16 hex characters. Restoring the stored secret reproduces the same peer ID.

- **Rooms, SOS, announcements, file metadata, and location pings are plaintext.**
  This is intentional: an SOS that a stranger's phone cannot read is an SOS that
  does not work. Anyone in range can see them.
- **Direct text is sealed** with XChaCha20-Poly1305. The shared key is X25519 +
  HKDF-SHA256 with a salt derived from the two peer IDs; the packet header with
  an empty payload is the associated data, so a relay cannot rewrite routing
  fields unnoticed. A random 24-byte nonce is used per message.
- **No forward secrecy.** The same static X25519 keys are used for every DM.
  Compromising a device's stored secret decrypts past sealed DMs that were
  captured on the air.
- **Sender authenticity is not yet verified on the wire.** Announcements do not
  carry public keys, so a relay can claim any callsign. The engine exposes
  `trustPeerKey` and `peerSafetyNumber` for out-of-band verification, but the UI
  does not yet wire a verification flow.
- **First-contact DMs need a key.** `sendDirect` requires the recipient's X25519
  public key. The app learns that key only from a received direct packet or a
  manual trust call; there is no automatic key exchange yet. Until that is
  wired, the practical path is public rooms. The Chat UI shows
  "waiting for key" rather than pretending a DM can be sent.

Treat the mesh as a **trust-on-first-use, plaintext-broadcast** network with a
sealed side channel, not as Signal. See [SECURITY.md](../SECURITY.md).

## Presence

A node announces:

- on boot,
- on every new link,
- every 15 seconds while running.

The UI also has an **Announce** nudge, but it is not required. Peers expire from
the active list after `peerTtlMs` (3 minutes by default). An announcement sets
the peer's callsign, status, last-known position, accuracy, and hop count.

Presence is deliberately not tied to a button: a peer list that only fills when
someone taps "Announce" looks identical to a broken radio.

## Chat semantics

| Surface | Wire path | Sealed | Notes |
| --- | --- | --- | --- |
| Rooms `#general`, `#local`, `#maps`, `#wellness` | `room` broadcast | no | everyone in range; relayed |
| SOS | `sos` broadcast | no | ranked medical → rescue → water → shelter → food → power |
| SOS acknowledgement | `ack` addressed packet | no | tells the sender a human saw it |
| Location ping | `location` | no | updates the peer marker and posts a pin message |
| Direct text | `direct` | yes | not relayed; requires the peer's box key |
| File / map pack | `fileMeta` + `fileChunk` in `#maps` | no | SHA-256 verified; DMs do not carry files yet |

Files are capped at 4 MB and split into 3000-byte chunks. A transfer is accepted
only when every chunk arrived, the total length matches the metadata, and the
SHA-256 matches. At most three incoming transfers are tracked at once.

History is capped at 500 messages in memory. SQLite keeps the persisted subset
loaded at boot (200 messages by default). A message composed with no link open
is held for up to three minutes and sent when a link appears; after that it stays
in history as unsent.

## Failure modes and diagnosis

| Symptom | Likely meaning |
| --- | --- |
| `0 links` | The two radios never connected. Check permissions, Bluetooth state, and range. |
| `1 link`, `0 peers` | The link is up but no announcement arrived. This is frame delivery, not discovery. |
| Peer appears then disappears | No announcement within the 3-minute TTL, or the app was backgrounded. |
| DM composer says "waiting for key" | The peer's X25519 key has not been trusted yet. Use a room. |
| File never completes | Chunks lost, hash mismatch, or a transfer over 4 MB. Retry in `#maps`. |

**Kit → Device and data** shows the numbers to report:

| Row | Meaning |
| --- | --- |
| `Radio` | `ready`, `scanning only`, `off`, `unauthorized`, `unsupported` |
| `Links` | open BLE links vs. phones that announced themselves |
| `Frames out / in` | raw fragments written and received since launch |
| `Last radio note` | the last transport error, verbatim |

## Testing the mesh

The engine is tested without a radio: tests feed frames into
`MeshEngine.ingestFrame` and assert on emitted events, history, and relay frames.
Coverage includes packet round-trips, fragmentation and out-of-order assembly,
TTL relaying, duplicate suppression, rooms, SOS ranking and acknowledgements,
sealed DMs, location pings, file reassembly plus SHA-256 rejection, identity
restore, and MTU-sized frames.

Physical two-phone testing is still required whenever the transport changes. See
[testing.md](testing.md#two-phone-mesh-test).
