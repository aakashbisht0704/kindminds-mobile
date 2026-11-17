/**
 * Wire-format tests.
 *
 * These cover the failure modes that actually happen on a BLE link: frames
 * arriving out of order, duplicated frames, a stranger's malformed packet, and a
 * packet whose declared length disagrees with what was received.
 */

import { describe, expect, test } from 'bun:test';

import {
  FRAME_DATA_BYTES,
  FragmentAssembler,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  SeenCache,
  createPacket,
  decodeAnnouncement,
  decodeFrame,
  decodePacket,
  decodeSos,
  encodeAnnouncement,
  encodePacket,
  FragmentAssembler as Assembler,
  fragmentPacket,
  headerBytes,
  prepareRelay,
  sosRank,
  type MeshPacket,
} from '../src/core/mesh/protocol';

const SENDER = 'aabbccddeeff0011';
const RECIPIENT = '1122334455667788';

/** Deterministic byte source so ids are stable across runs. */
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

const DEFAULT_PAYLOAD = new TextEncoder().encode('water at the north gate');

function samplePacket(overrides: Partial<MeshPacket> = {}): MeshPacket {
  const base = createPacket(
    {
      type: 'message',
      senderId: SENDER,
      recipientId: null,
      payload: DEFAULT_PAYLOAD,
      ttl: 8,
      createdAt: 1_700_000_000_000,
    },
    seeded(7),
  );
  // Overrides must actually land on the packet, otherwise every test that sets
  // a payload, recipient or TTL silently exercises the default packet instead.
  return { ...base, ...overrides };
}

describe('packet encoding', () => {
  test('round-trips every header field', () => {
    const packet = samplePacket({ recipientId: RECIPIENT, ttl: 5 });
    const decoded = decodePacket(encodePacket(packet));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.packet.type).toBe('message');
    expect(decoded.packet.senderId).toBe(SENDER);
    expect(decoded.packet.recipientId).toBe(RECIPIENT);
    expect(decoded.packet.ttl).toBe(5);
    expect(decoded.packet.messageId).toBe(packet.messageId);
    // The wire stores whole seconds, so the comparison is second-precision.
    expect(decoded.packet.createdAt).toBe(Math.floor(packet.createdAt / 1000) * 1000);
    expect(new TextDecoder().decode(decoded.packet.payload)).toBe('water at the north gate');
  });

  test('a broadcast carries a null recipient', () => {
    const decoded = decodePacket(encodePacket(samplePacket()));
    expect(decoded.ok && decoded.packet.recipientId).toBeNull();
  });

  test('rejects bad magic, bad version and length mismatch instead of throwing', () => {
    const bytes = encodePacket(samplePacket());

    const badMagic = new Uint8Array(bytes);
    badMagic[0] = 0x00;
    expect(decodePacket(badMagic).ok).toBe(false);

    const badVersion = new Uint8Array(bytes);
    badVersion[2] = PROTOCOL_VERSION + 1;
    expect(decodePacket(badVersion).ok).toBe(false);

    expect(decodePacket(bytes.subarray(0, bytes.length - 1)).ok).toBe(false);
    expect(decodePacket(new Uint8Array(4)).ok).toBe(false);
  });

  test('refuses to encode an oversized payload', () => {
    const packet = samplePacket({ payload: new Uint8Array(MAX_PAYLOAD_BYTES + 1) });
    expect(() => encodePacket(packet)).toThrow();
  });

  test('headerBytes is the packet with an empty payload', () => {
    const packet = samplePacket();
    const header = headerBytes(packet);
    const decoded = decodePacket(header);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.packet.payload.length).toBe(0);
  });
});

describe('fragmentation', () => {
  test('reassembles out-of-order frames into the original packet', () => {
    const packet = samplePacket({ payload: new Uint8Array(900).fill(0x41) });
    const bytes = encodePacket(packet);
    const frames = fragmentPacket(bytes);
    expect(frames.length).toBeGreaterThan(1);

    const assembler = new Assembler();
    // Feed reversed: a BLE link delivers frames in whatever order it likes.
    const reversed = [...frames].reverse();
    let complete: Uint8Array | null = null;
    for (const frame of reversed) {
      const result = assembler.add(frame);
      if (result) complete = result;
    }
    expect(complete).not.toBeNull();
    expect(complete).toEqual(bytes);
    expect(assembler.pendingCount).toBe(0);
  });

  test('a duplicated frame does not corrupt the assembly', () => {
    const frames = fragmentPacket(encodePacket(samplePacket({ payload: new Uint8Array(700).fill(2) })));
    const assembler = new Assembler();
    expect(assembler.add(frames[0] as Uint8Array)).toBeNull();
    expect(assembler.add(frames[0] as Uint8Array)).toBeNull();
    let complete: Uint8Array | null = null;
    for (const frame of frames.slice(1)) {
      const result = assembler.add(frame);
      if (result) complete = result;
    }
    expect(complete).not.toBeNull();
  });

  test('frames for the same type in the same second are not confused', () => {
    // fragId must come from the message id, not the type+clock header prefix.
    const a = samplePacket({ createdAt: 1_700_000_000_000, payload: new Uint8Array(600).fill(1) });
    const b = {
      ...a,
      messageId: 'ffffffffffffffff',
      payload: new Uint8Array(600).fill(2),
    };
    const framesA = fragmentPacket(encodePacket(a));
    const framesB = fragmentPacket(encodePacket(b));
    expect(decodeFrame(framesA[0] as Uint8Array)?.fragId).not.toBe(
      decodeFrame(framesB[0] as Uint8Array)?.fragId,
    );
  });

  test('one frame suffices for a packet under the frame budget', () => {
    const frames = fragmentPacket(encodePacket(samplePacket()));
    expect(frames.length).toBe(1);
    expect((frames[0] as Uint8Array).length).toBeLessThanOrEqual(FRAME_DATA_BYTES + 13);
  });

  test('garbage frames are ignored', () => {
    const assembler = new Assembler();
    expect(assembler.add(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(assembler.add(new Uint8Array(0))).toBeNull();
    expect(assembler.pendingCount).toBe(0);
  });

  test('expired partial assemblies are evicted', () => {
    let clock = 1_000;
    const assembler = new FragmentAssembler(16, 5_000, () => clock);
    const frames = fragmentPacket(encodePacket(samplePacket({ payload: new Uint8Array(800).fill(3) })));
    assembler.add(frames[0] as Uint8Array);
    expect(assembler.pendingCount).toBe(1);

    clock += 10_000;
    // The next add runs the eviction pass before buffering.
    assembler.add(frames[1] as Uint8Array);
    expect(assembler.pendingCount).toBe(1);
  });
});

describe('duplicate suppression', () => {
  test('first sighting wins, later ones are suppressed', () => {
    const cache = new SeenCache(8, 60_000, () => 0);
    expect(cache.check('a:1')).toBe(true);
    expect(cache.check('a:1')).toBe(false);
    expect(cache.check('a:2')).toBe(true);
  });

  test('the same message id from different senders is distinct', () => {
    const cache = new SeenCache(8, 60_000, () => 0);
    expect(cache.check('a:1')).toBe(true);
    expect(cache.check('b:1')).toBe(true);
  });

  test('respects its capacity ceiling', () => {
    const cache = new SeenCache(4, 60_000, () => 0);
    for (let i = 0; i < 10; i += 1) cache.check(`x:${i}`);
    expect(cache.size).toBe(4);
  });

  test('an entry older than the TTL is accepted again', () => {
    let clock = 0;
    const cache = new SeenCache(8, 1_000, () => clock);
    expect(cache.check('a:1')).toBe(true);
    clock = 2_000;
    expect(cache.check('a:1')).toBe(true);
  });
});

describe('relay policy', () => {
  test('decrements TTL for broadcast traffic', () => {
    const relay = prepareRelay(samplePacket({ ttl: 4 }));
    expect(relay?.ttl).toBe(3);
  });

  test('stops at the last hop', () => {
    expect(prepareRelay(samplePacket({ ttl: 1 }))).toBeNull();
  });

  test('never relays sealed direct traffic', () => {
    const direct = createPacket(
      {
        type: 'direct',
        senderId: SENDER,
        recipientId: RECIPIENT,
        payload: new Uint8Array(4),
        ttl: 3,
      },
      seeded(1),
    );
    expect(prepareRelay(direct)).toBeNull();
  });
});

describe('payload decoding', () => {
  test('announcement survives a round trip and clamps the callsign', () => {
    const payload = encodeAnnouncement({
      callsign: 'x'.repeat(40),
      skills: ['medic', 'water'],
      status: 'assisting',
      lat: 19.07,
      lon: 72.87,
      accuracyM: 12,
    });
    const decoded = decodeAnnouncement(samplePacket({ payload }));
    expect(decoded?.callsign.length).toBe(24);
    expect(decoded?.skills).toEqual(['medic', 'water']);
    expect(decoded?.status).toBe('assisting');
    expect(decoded?.lat).toBeCloseTo(19.07, 5);
  });

  test('malformed announcement JSON returns null', () => {
    const decoded = decodeAnnouncement(samplePacket({ payload: new Uint8Array([0xff, 0xfe]) }));
    expect(decoded).toBeNull();
  });

  test('SOS drops unknown needs and clamps people to at least one', () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({ lat: 1, lon: 2, people: 0, needs: ['medical', 'teleport'], note: 'x' }),
    );
    const sos = decodeSos(samplePacket({ payload }));
    expect(sos?.people).toBe(1);
    expect(sos?.needs).toEqual(['medical']);
  });

  test('SOS without coordinates is rejected', () => {
    const payload = new TextEncoder().encode(JSON.stringify({ lon: 2 }));
    expect(decodeSos(samplePacket({ payload }))).toBeNull();
  });

  test('sosRank orders medical ahead of power and ignores non-SOS traffic', () => {
    const sosPacket = (needs: string[]) =>
      samplePacket({
        type: 'sos',
        payload: new TextEncoder().encode(JSON.stringify({ lat: 1, lon: 2, needs })),
      });

    const medical = sosRank(sosPacket(['medical']));
    const power = sosRank(sosPacket(['power']));
    const rescue = sosRank(sosPacket(['rescue']));

    expect(medical).toBeLessThan(rescue);
    expect(rescue).toBeLessThan(power);
    expect(sosRank(samplePacket())).toBe(99);
  });
});
