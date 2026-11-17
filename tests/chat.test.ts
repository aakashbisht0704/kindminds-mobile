import { describe, expect, test } from 'bun:test';

import {
  buildDmSummaries,
  dayLabel,
  dmTimeline,
  lastForDm,
  lastForRoom,
  previewText,
  roomTimeline,
  sortPeersByProximity,
} from '../src/core/chat';
import type { InboxMessage, Peer } from '../src/core/mesh/engine';

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: `m-${Math.random()}`,
    senderId: 'peer-a',
    senderCallsign: 'Alex',
    text: 'hello',
    receivedAt: 1_000,
    createdAt: 1_000,
    hops: 1,
    encrypted: false,
    direct: false,
    room: 'general',
    recipientId: null,
    kind: 'text',
    ...overrides,
  };
}

const peer: Peer = {
  peerId: 'peer-a',
  callsign: 'Alex',
  skills: [],
  status: 'ok',
  lastSeen: 1_000,
  lastKnown: null,
  accuracyM: null,
  hops: 1,
  verified: false,
  signingPublicKey: null,
  boxPublicKey: null,
};

describe('chat derivations', () => {
  test('rooms ignore direct messages', () => {
    const messages = [
      message({ text: 'room hello', receivedAt: 1 }),
      message({ text: 'dm hello', direct: true, room: 'direct', recipientId: 'me', receivedAt: 2 }),
    ];
    expect(lastForRoom(messages, 'general')?.text).toBe('room hello');
    expect(roomTimeline(messages, 'general').map((item) => item.text)).toEqual(['room hello']);
  });

  test('direct timelines include both directions and sort by time', () => {
    const messages = [
      message({ text: 'later', direct: true, room: 'direct', senderId: 'peer-a', receivedAt: 20 }),
      message({
        text: 'earlier',
        direct: true,
        room: 'direct',
        senderId: 'me',
        recipientId: 'peer-a',
        receivedAt: 10,
      }),
    ];
    expect(dmTimeline(messages, 'peer-a').map((item) => item.text)).toEqual(['earlier', 'later']);
    expect(lastForDm(messages, 'peer-a')?.text).toBe('later');
  });

  test('summaries include peers who are no longer in range', () => {
    const messages = [message({ direct: true, room: 'direct', recipientId: 'peer-a', senderId: 'me', receivedAt: 5 })];
    const summaries = buildDmSummaries(messages, [], 'me');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.peerId).toBe('peer-a');
    expect(summaries[0]?.last.text).toBe('hello');
  });

  test('preview text names files and locations', () => {
    expect(
      previewText(
        message({
          kind: 'file',
          file: { name: 'map.mbtiles', size: 10, mime: 'x', sha256: 'x', kind: 'map' },
        }),
      ),
    ).toBe('File · map.mbtiles');
    expect(previewText(message({ kind: 'location', text: 'Shared a location: 1, 2' }))).toBe(
      'Location shared',
    );
  });

  test('day labels are stable around today and yesterday', () => {
    const now = new Date(2026, 4, 20, 12).getTime();
    expect(dayLabel(now - 1_000, now)).toBe('Today');
    expect(dayLabel(now - 86_400_000, now)).toBe('Yesterday');
    expect(dayLabel(now - 3 * 86_400_000, now)).not.toBe('Today');
  });

  test('summaries prefer the active peer callsign', () => {
    const messages = [message({ direct: true, room: 'direct', recipientId: 'peer-a', senderId: 'me' })];
    expect(buildDmSummaries(messages, [peer], 'me')[0]?.callsign).toBe('Alex');
  });
});


describe('chat proximity ordering', () => {
  test('nearest known peer sorts first, unknown peers last by hops', () => {
    const self = { lat: 37.7749, lon: -122.4194 };
    const peers = [
      { peerId: 'far', callsign: 'Far', status: 'ok', hops: 1, lastSeen: 1, lastKnown: { lat: 37.8044, lon: -122.2712 } },
      { peerId: 'no-fix', callsign: 'No fix', status: 'ok', hops: 1, lastSeen: 1, lastKnown: null },
      { peerId: 'near', callsign: 'Near', status: 'ok', hops: 2, lastSeen: 1, lastKnown: { lat: 37.776, lon: -122.419 } },
    ] as any;
    expect(sortPeersByProximity(peers, self).map((peer) => peer.peerId)).toEqual(['near', 'far', 'no-fix']);
  });
});
