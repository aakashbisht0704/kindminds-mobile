/**
 * Extended mesh tests: rooms, direct messages, location pings, and file sharing.
 *
 * These run entirely in-process: one engine's frames are handed to another
 * engine's `ingestFrame`, which is exactly what the BLE transport does on a
 * phone.
 */

import { describe, expect, test } from 'bun:test';

import { MeshEngine, type ReceivedFile } from '../src/core/mesh/engine';
import { bytesToHex } from '../src/core/mesh/bytes';
import { sha256 } from '@noble/hashes/sha256';

function seeded(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

function makeNode(seed: number) {
  return new MeshEngine({
    random: seeded(seed),
    now: () => 1_700_000_000_000,
    selfCallsign: `node-${seed}`,
  });
}

function sendAll(from: MeshEngine, to: MeshEngine, frames: Uint8Array[]): void {
  for (const frame of frames) to.ingestFrame(frame);
}

describe('mesh rooms', () => {
  test('a room tag survives the wire and filters the feed', () => {
    const a = makeNode(100);
    const b = makeNode(101);
    const received: string[] = [];
    b.subscribe((event) => {
      if (event.type === 'message') received.push(`${event.message.room}:${event.message.text}`);
    });

    sendAll(a, b, a.framesFor(a.sendBroadcast('water at the school', 'local')));

    expect(received).toEqual(['local:water at the school']);
    expect(b.history()[0]?.room).toBe('local');
  });

  test('the default room is general', () => {
    const a = makeNode(102);
    const b = makeNode(103);
    sendAll(a, b, a.framesFor(a.sendBroadcast('hello')));
    expect(b.history()[0]?.room).toBe('general');
  });
});

describe('mesh direct messages', () => {
  test('a sealed DM is readable only by the addressed peer', () => {
    const a = makeNode(110);
    const b = makeNode(111);
    const c = makeNode(112);

    a.trustPeerKey(b.peerId, b.identity.signPublicKey, b.identity.boxPublicKey);
    b.trustPeerKey(a.peerId, a.identity.signPublicKey, a.identity.boxPublicKey);
    c.trustPeerKey(a.peerId, a.identity.signPublicKey, a.identity.boxPublicKey);

    const packet = a.sendDirect('meet at the north gate', b.peerId);
    expect(packet).not.toBeNull();
    if (!packet) return;

    const frames = a.framesFor(packet);
    sendAll(a, b, frames);
    sendAll(a, c, frames);

    const bMessage = b.history().find((message) => message.direct);
    expect(bMessage?.text).toBe('meet at the north gate');
    expect(bMessage?.encrypted).toBe(true);
    expect(c.history().find((message) => message.direct)).toBeUndefined();
  });
});

describe('mesh location pings', () => {
  test('a location packet updates a peer position without a new announcement', () => {
    const a = makeNode(120);
    const b = makeNode(121);
    a.setPosition({ lat: 12.9716, lon: 77.5946 }, 6);

    sendAll(a, b, a.framesFor(a.announce()));
    const packet = a.sendLocation('local');
    expect(packet).not.toBeNull();
    if (!packet) return;
    sendAll(a, b, a.framesFor(packet));

    expect(b.activePeers()[0]?.lastKnown?.lat).toBeCloseTo(12.9716, 3);
    expect(b.activePeers()[0]?.accuracyM).toBe(6);
  });

  test('a direct location lands in the DM timeline and updates the peer', () => {
    const a = makeNode(122);
    const b = makeNode(123);
    a.setPosition({ lat: 12.9716, lon: 77.5946 }, 6);
    sendAll(a, b, a.framesFor(a.announce()));

    const packet = a.sendLocation('general', b.peerId);
    expect(packet).not.toBeNull();
    if (!packet) return;
    sendAll(a, b, a.framesFor(packet));

    const received = b.history().find((message) => message.kind === 'location');
    expect(received?.direct).toBe(true);
    expect(received?.recipientId).toBe(b.peerId);
    expect(received?.text).toContain('12.9716');
    expect(b.activePeers()[0]?.lastKnown?.lat).toBeCloseTo(12.9716, 3);
    expect(a.history().find((message) => message.kind === 'location')?.recipientId).toBe(
      b.peerId,
    );
  });
});

describe('mesh file sharing', () => {
  test('a map pack is reassembled and verified', () => {
    const a = makeNode(130);
    const b = makeNode(131);
    const bytes = seeded(132)(5000);
    const contentHex = bytesToHex(bytes);
    const expected = bytesToHex(sha256(bytes));

    const files: ReceivedFile[] = [];
    b.subscribe((event) => {
      if (event.type === 'file') files.push(event.file);
    });

    const packets = a.shareFile('test-map.mbtiles', bytes, 'application/vnd.mapbox-vector-tile', 'maps');
    expect(packets.length).toBeGreaterThan(1);
    for (const packet of packets) {
      sendAll(a, b, a.framesFor(packet));
    }

    expect(files.length).toBe(1);
    const file = files[0];
    expect(file?.name).toBe('test-map.mbtiles');
    expect(file?.kind).toBe('map');
    expect(file?.sha256).toBe(expected);
    expect(file?.bytes.length).toBe(bytes.length);
    expect(bytesToHex(file!.bytes)).toBe(contentHex);
  });

  test('a corrupted chunk is rejected by the hash check', () => {
    const a = makeNode(133);
    const b = makeNode(134);
    const bytes = seeded(135)(4000);
    const files: ReceivedFile[] = [];
    b.subscribe((event) => {
      if (event.type === 'file') files.push(event.file);
    });

    const packets = a.shareFile('broken.bin', bytes, 'application/octet-stream');
    for (let index = 0; index < packets.length; index += 1) {
      const packet = packets[index];
      if (!packet) continue;
      if (index === packets.length - 1) {
        // Corrupt the last chunk before it reaches the receiver.
        const i = packet.payload.length - 2;
        packet.payload[i] = (packet.payload[i] ?? 0) ^ 0xff;
      }
      sendAll(a, b, a.framesFor(packet));
    }

    expect(files.length).toBe(0);
  });

  test('oversized files are refused before any packets are created', () => {
    const a = makeNode(136);
    const packets = a.shareFile('too-big.bin', new Uint8Array(4 * 1024 * 1024 + 1), 'application/octet-stream');
    expect(packets).toEqual([]);
  });
});
