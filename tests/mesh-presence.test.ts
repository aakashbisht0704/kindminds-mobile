/**
 * Presence and MTU regression tests.
 *
 * Two bugs made a two-phone test impossible to read: nothing announced itself
 * unless the user tapped a button on both phones, and every frame was 372 bytes
 * while a default ATT link carries 20. These tests pin both behaviours.
 */

import { describe, expect, test } from 'bun:test';

import { MeshEngine } from '../src/core/mesh/engine';

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

function makeNode(seed: number, now: () => number = () => 1_700_000_000_000) {
  return new MeshEngine({
    random: seeded(seed),
    now,
    selfCallsign: `node-${seed}`,
  });
}

function deliver(from: MeshEngine, to: MeshEngine, frames: Uint8Array[]): void {
  for (const frame of frames) to.ingestFrame(frame);
}

describe('presence without a tap', () => {
  test('an announcement introduces a peer on its own', () => {
    const a = makeNode(200);
    const b = makeNode(201);
    deliver(a, b, a.framesFor(a.announce()));

    expect(b.activePeers()).toHaveLength(1);
    expect(b.activePeers()[0]?.peerId).toBe(a.peerId);
    expect(b.activePeers()[0]?.callsign).toBe('node-200');
  });

  test('re-announcing refreshes the peer instead of duplicating it', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const a = makeNode(202, now);
    const b = makeNode(203, now);

    deliver(a, b, a.framesFor(a.announce()));
    clock += 30_000;
    deliver(a, b, a.framesFor(a.announce()));

    expect(b.activePeers()).toHaveLength(1);
    expect(b.activePeers()[0]?.lastSeen).toBe(clock);
  });

  test('a silent peer leaves the list after its TTL', () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    const a = makeNode(204, now);
    const b = makeNode(205, now);

    deliver(a, b, a.framesFor(a.announce()));
    expect(b.activePeers()).toHaveLength(1);

    clock += 4 * 60_000;
    expect(b.activePeers()).toHaveLength(0);
  });

  test('announcing twice in the same second is not mistaken for one packet', () => {
    const a = makeNode(206);
    const b = makeNode(207);

    deliver(a, b, a.framesFor(a.announce()));
    deliver(a, b, a.framesFor(a.announce()));

    expect(b.activePeers()).toHaveLength(1);
  });
});

describe('frames fit the negotiated MTU', () => {
  test('a message sized for a 20-byte ATT payload still reassembles', () => {
    const a = makeNode(210);
    const b = makeNode(211);

    const frames = a.framesFor(a.sendBroadcast('water at the school'), 7);
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(20);
    deliver(a, b, frames);

    expect(b.history().at(-1)?.text).toBe('water at the school');
    expect(b.history().at(-1)?.room).toBe('general');
  });

  test('a full-size message stays inside the 255-frame ceiling', () => {
    const a = makeNode(212);
    const frames = a.framesFor(a.sendBroadcast('x'.repeat(800)), 7);
    expect(frames.length).toBeLessThanOrEqual(255);
  });

  test('the default budget keeps a short message in one frame', () => {
    const a = makeNode(213);
    expect(a.framesFor(a.sendBroadcast('hi')).length).toBe(1);
  });

  test('two messages in the same second keep separate reassembly buffers', () => {
    const a = makeNode(214);
    const b = makeNode(215);

    const first = a.framesFor(a.sendBroadcast('first message from a'), 7);
    const second = a.framesFor(a.sendBroadcast('second message from b'), 7);
    // Interleave the two packets, as two phones writing at once would.
    const longest = Math.max(first.length, second.length);
    for (let index = 0; index < longest; index += 1) {
      const one = first[index];
      const two = second[index];
      if (one) b.ingestFrame(one);
      if (two) b.ingestFrame(two);
    }

    const texts = b.history().map((message) => message.text);
    expect(texts).toContain('first message from a');
    expect(texts).toContain('second message from b');
  });
});
