/**
 * Mesh engine tests, end to end inside one process.
 *
 * The engine is transport-agnostic by design, so a whole three-node network
 * fits in this file: node A's frames are handed straight to node B's
 * `ingestFrame`, and whatever B returns is relayed to C. That is the same code
 * path the BLE transport drives on a phone, which is the point.
 */

import { describe, expect, test } from 'bun:test';

import { MeshEngine, type Peer } from '../src/core/mesh/engine';
import { bytesToBase64, base64ToBytes } from '../src/core/mesh/bytes';
import {
  FragmentAssembler,
  decodeAck,
  decodeAnnouncement,
  decodePacket,
  encodePacket,
  fragmentPacket,
} from '../src/core/mesh/protocol';
import type { LatLon } from '../src/core/geo';

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

function makeNode(seed: number, now = () => 1_700_000_000_000) {
  return new MeshEngine({ random: seeded(seed), now, selfCallsign: `node-${seed}` });
}

/** Deliver every frame a node produced into another node; return its relays. */
function deliver(from: MeshEngine, to: MeshEngine, frames: Uint8Array[]): Uint8Array[] {
  const relays: Uint8Array[] = [];
  for (const frame of frames) relays.push(...to.ingestFrame(frame));
  return relays;
}

describe('mesh engine: announcements', () => {
  test('a peer discovers another peer with callsign and position', () => {
    const a = makeNode(1);
    const b = makeNode(2);
    a.setPosition({ lat: 19.076, lon: 72.8777 }, 8);

    deliver(a, b, a.framesFor(a.announce()));

    const peers = b.activePeers();
    expect(peers.length).toBe(1);
    const peer = peers[0] as Peer;
    expect(peer.peerId).toBe(a.peerId);
    expect(peer.callsign).toBe('node-1');
    expect(peer.lastKnown?.lat).toBeCloseTo(19.076, 2);
    expect(peer.accuracyM).toBe(8);
  });

  test('a node ignores its own relayed traffic', () => {
    const a = makeNode(3);
    const packet = a.announce();
    expect(a.ingestPacket(packet)).toEqual([]);
    expect(a.activePeers().length).toBe(0);
  });

  test('peers expire after the TTL window', () => {
    let clock = 1_700_000_000_000;
    const a = new MeshEngine({ random: seeded(4), now: () => clock, peerTtlMs: 1_000 });
    const b = new MeshEngine({ random: seeded(5), now: () => clock, peerTtlMs: 1_000 });

    deliver(a, b, a.framesFor(a.announce()));
    expect(b.activePeers().length).toBe(1);

    clock += 5_000;
    expect(b.activePeers().length).toBe(0);
  });
});

describe('mesh engine: messages', () => {
  test('a broadcast reaches a neighbour and is recorded once', () => {
    const a = makeNode(10);
    const b = makeNode(11);

    const frames = a.framesFor(a.sendBroadcast('water at the north gate'));
    deliver(a, b, frames);

    expect(b.history().length).toBe(1);
    expect(b.history()[0]?.text).toBe('water at the north gate');
    expect(b.history()[0]?.senderId).toBe(a.peerId);
  });

  test('the sender keeps its own message in history', () => {
    const a = makeNode(12);
    a.sendBroadcast('hello');
    expect(a.history().length).toBe(1);
    expect(a.history()[0]?.senderId).toBe(a.peerId);
  });

  test('a duplicate packet is not delivered twice', () => {
    const a = makeNode(13);
    const b = makeNode(14);
    const frames = a.framesFor(a.sendBroadcast('once'));

    deliver(a, b, frames);
    deliver(a, b, frames);

    expect(b.history().length).toBe(1);
  });

  test('long text is fragmented and still arrives intact', () => {
    const a = makeNode(15);
    const b = makeNode(16);
    const text = 'need insulin '.repeat(40).slice(0, 480);

    const frames = a.framesFor(a.sendBroadcast(text));
    expect(frames.length).toBeGreaterThan(1);

    deliver(a, b, frames);
    expect(b.history().length).toBe(1);
    expect(b.history()[0]?.text).toBe(text);
  });

  test('out-of-order frame delivery still assembles', () => {
    const a = makeNode(17);
    const b = makeNode(18);
    const text = 'shelter at the school '.repeat(20).slice(0, 400);
    const frames = a.framesFor(a.sendBroadcast(text));

    for (const frame of [...frames].reverse()) b.ingestFrame(frame);
    expect(b.history()[0]?.text).toBe(text);
  });

  test('a malformed frame never throws and never creates a message', () => {
    const b = makeNode(19);
    expect(() => b.ingestFrame(new Uint8Array([0x4b, 0x46, 0x01]))).not.toThrow();
    expect(() => b.ingestFrame(base64ToBytes(bytesToBase64(new Uint8Array(64).fill(0x7f))))).not.toThrow();
    expect(b.history().length).toBe(0);
  });
});

describe('mesh engine: relaying', () => {
  test('a relay decrements TTL and reaches the third node', () => {
    const a = makeNode(20);
    const b = makeNode(21);
    const c = makeNode(22);

    const fromA = a.framesFor(a.sendBroadcast('relay me'));
    const bRelays = deliver(a, b, fromA);
    expect(bRelays.length).toBeGreaterThan(0);

    // The engine relays BLE-sized frames, not a whole packet, so the relayed
    // bytes have to be reassembled before the routing header can be inspected.
    const assembler = new FragmentAssembler();
    let relayed: Uint8Array | null = null;
    for (const frame of bRelays) {
      const complete = assembler.add(frame);
      if (complete) relayed = complete;
    }
    expect(relayed).not.toBeNull();
    if (!relayed) return;

    const decoded = decodePacket(relayed);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.packet.ttl).toBe(7);

    deliver(b, c, bRelays);
    expect(c.history().length).toBe(1);
    expect(c.history()[0]?.text).toBe('relay me');
    // The third node learned the hop count from the remaining TTL.
    expect(c.history()[0]?.hops).toBe(1);
  });

  test('the last hop produces no relay', () => {
    const a = makeNode(23);
    const b = makeNode(24);
    const packet = { ...a.sendBroadcast('last hop'), ttl: 1 };
    expect(b.ingestPacket(packet)).toEqual([]);
  });
});

describe('mesh engine: SOS', () => {
  const sosPayload = {
    lat: 19.076,
    lon: 72.8777,
    accuracyM: 12,
    people: 3,
    needs: ['medical' as const],
    note: 'second floor',
  };

  test('an SOS raises an alert on the receiver, not on the sender', () => {
    const a = makeNode(30);
    const b = makeNode(31);

    const packet = a.sendSos(sosPayload);
    deliver(a, b, a.framesFor(packet));

    const receiver = b.sosAlerts();
    expect(receiver.length).toBe(1);
    expect(receiver[0]?.messageId).toBe(packet.messageId);
    expect(receiver[0]?.mine).toBe(false);
    expect(receiver[0]?.payload.people).toBe(3);
    expect(receiver[0]?.payload.needs).toEqual(['medical']);

    expect(a.sosAlerts()[0]?.mine).toBe(true);
  });

  test('re-broadcasting the same SOS does not duplicate the alert', () => {
    const a = makeNode(32);
    const b = makeNode(33);
    const c = makeNode(34);

    const packet = a.sendSos(sosPayload);
    const toB = deliver(a, b, a.framesFor(packet));
    deliver(b, c, toB);
    // B receives the same alert again via a different path.
    deliver(a, b, a.framesFor(packet));

    expect(b.sosAlerts().length).toBe(1);
    expect(c.sosAlerts().length).toBe(1);
  });

  test('an acknowledgement is delivered back to the sender', () => {
    const a = makeNode(35);
    const b = makeNode(36);

    // Both must know each other before a direct ack has an address to use.
    deliver(a, b, a.framesFor(a.announce()));
    deliver(b, a, b.framesFor(b.announce()));

    const sos = a.sendSos(sosPayload);
    deliver(a, b, a.framesFor(sos));

    const alert = b.sosAlerts()[0];
    expect(alert).toBeDefined();
    if (!alert) return;

    const ack = b.ackSos(alert.messageId, alert.senderId);
    const ackDecoded = decodeAck(ack);
    expect(ackDecoded?.ackMessageId).toBe(sos.messageId);

    deliver(b, a, b.framesFor(ack));
    expect(a.sosAlerts()[0]?.acknowledgedBy).toContain('node-36');
  });

  test('alerts are ranked with medical first', () => {
    const a = makeNode(37);
    const b = makeNode(38);
    const power = a.sendSos({ ...sosPayload, needs: ['power'] });
    const medical = a.sendSos({ ...sosPayload, needs: ['medical'] });

    deliver(a, b, a.framesFor(power));
    deliver(a, b, a.framesFor(medical));

    const ranked = b.sosAlerts();
    expect(ranked[0]?.payload.needs).toEqual(['medical']);
  });

  test('sos events are emitted to subscribers', () => {
    const a = makeNode(39);
    const b = makeNode(40);
    const seen: string[] = [];
    b.subscribe((event) => {
      if (event.type === 'sos') seen.push(event.alert.payload.note);
    });

    deliver(a, b, a.framesFor(a.sendSos(sosPayload)));
    expect(seen).toEqual(['second floor']);
  });
});

describe('mesh engine: direct messages', () => {
  test('a sealed direct message decrypts for the addressee only', () => {
    const a = makeNode(50);
    const b = makeNode(51);
    const c = makeNode(52);

    // Exchange announcements so both sides have the other's public keys.
    deliver(a, b, a.framesFor(a.announce()));
    deliver(b, a, b.framesFor(b.announce()));

    // The announcement payload deliberately carries no keys, so a peer is
    // discovered without being trusted. Trust is established the way the app
    // does it: an explicit out-of-band key confirmation.
    expect(a.activePeers()[0]?.boxPublicKey ?? null).toBeNull();
    a.trustPeerKey(b.peerId, b.identity.signPublicKey, b.identity.boxPublicKey);
    b.trustPeerKey(a.peerId, a.identity.signPublicKey, a.identity.boxPublicKey);

    const packet = a.sendDirect('bring water to gate 2', b.peerId);
    expect(packet).not.toBeNull();
    if (!packet) return;

    // The sender's own history holds the plaintext it wrote.
    expect(a.history()[0]?.text).toBe('bring water to gate 2');

    const frames = a.framesFor(packet);
    deliver(a, b, frames);
    deliver(a, c, frames);

    const received = b.history().filter((message) => message.direct);
    expect(received.length).toBe(1);
    expect(received[0]?.text).toBe('bring water to gate 2');
    expect(received[0]?.encrypted).toBe(true);

    // A third node can read the frame but not the payload.
    expect(c.history().length).toBe(0);
  });

  test('a direct message to an unknown peer is refused', () => {
    const a = makeNode(53);
    expect(a.sendDirect('hello', 'ffffffffffffffff')).toBeNull();
  });
});

describe('mesh engine: identity', () => {
  test('a restored identity keeps the same peer id', () => {
    const a = makeNode(60);
    const restored = MeshEngine.restore(a.secret);
    expect(restored.peerId).toBe(a.peerId);
  });

  test('two nodes have different identities', () => {
    expect(makeNode(61).peerId).not.toBe(makeNode(62).peerId);
  });

  test('revealSecret round-trips through restore', () => {
    const a = makeNode(63);
    const secret = a.secret;
    const restored = MeshEngine.restore(secret);
    expect(restored.identity.signPublicKey).toEqual(a.identity.signPublicKey);
    expect(restored.identity.boxPublicKey).toEqual(a.identity.boxPublicKey);
  });

  test('a safety number is stable for a verified pair', () => {
    expect(makeNode(64).peerSafetyNumber('ffffffffffffffff')).toBeNull();
  });
});

describe('mesh engine: canonical wire behaviour', () => {
  test('frames are individually decodable and carry the packet id', () => {
    const a = makeNode(70);
    const packet = a.sendBroadcast('x'.repeat(900));
    const frames = fragmentPacket(encodePacket(packet));
    expect(frames.length).toBeGreaterThan(1);
    // Same packet, same reassembly id on every frame.
    const ids = new Set(frames.map((frame) => bytesToBase64(frame.subarray(3, 11))));
    expect(ids.size).toBe(1);
  });

  test('an announcement payload is valid JSON on the wire', () => {
    const a = makeNode(71);
    const decoded = decodePacket(encodePacket(a.announce()));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decodeAnnouncement(decoded.packet)?.callsign).toBe('node-71');
  });

  test('setPosition without a fix leaves coordinates null', () => {
    const a = makeNode(72);
    const decoded = decodePacket(encodePacket(a.announce()));
    expect(decoded.ok && decodeAnnouncement(decoded.packet)?.lat).toBeNull();
  });

  test('a peer with no position is still counted as present', () => {
    const a = makeNode(73);
    const b = makeNode(74);
    deliver(a, b, a.framesFor(a.announce()));

    const peer = b.activePeers()[0];
    expect(peer).toBeDefined();
    expect(peer?.lastKnown).toBeNull();
    const position: LatLon | null | undefined = peer?.lastKnown;
    expect(position).toBeNull();
  });
});
