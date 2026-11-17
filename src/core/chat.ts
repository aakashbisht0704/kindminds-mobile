/**
 * Chat-specific derivations over the mesh history.
 *
 * The radio engine already owns delivery, relays, and sealed packets; this file
 * only turns the flat message log into WhatsApp-style rooms and conversations.
 */

import type { InboxMessage, Peer } from './mesh/engine';

export const CHAT_ROOMS = [
  {
    id: 'general',
    label: 'General',
    description: 'Everyone in range. Water, routes, and immediate needs.',
  },
  {
    id: 'local',
    label: 'Local',
    description: 'Your street, shelter, or building. Keep it specific.',
  },
  {
    id: 'maps',
    label: 'Maps',
    description: 'Map packs, route notes, and safe places.',
  },
  {
    id: 'wellness',
    label: 'Wellness',
    description: 'Calm check-ins and support. No medical advice.',
  },
] as const;

export type ChatRoom = (typeof CHAT_ROOMS)[number];
export type ChatRoomId = ChatRoom['id'];

export type DmSummary = {
  peerId: string;
  callsign: string;
  last: InboxMessage;
  lastAt: number;
};

export function previewText(message: InboxMessage): string {
  if (message.kind === 'file' && message.file) return `File · ${message.file.name}`;
  if (message.kind === 'location') return 'Location shared';
  return message.text;
}

/** Latest message in a room, or null when the room is empty. */
export function lastForRoom(messages: InboxMessage[], room: string): InboxMessage | null {
  let last: InboxMessage | null = null;
  for (const message of messages) {
    if (message.direct) continue;
    if ((message.room ?? 'general') !== room) continue;
    if (!last || message.receivedAt >= last.receivedAt) last = message;
  }
  return last;
}

/** Latest direct message with a peer, in either direction. */
export function lastForDm(messages: InboxMessage[], peerId: string): InboxMessage | null {
  let last: InboxMessage | null = null;
  for (const message of messages) {
    if (!message.direct) continue;
    if (message.senderId !== peerId && message.recipientId !== peerId) continue;
    if (!last || message.receivedAt >= last.receivedAt) last = message;
  }
  return last;
}

export function roomTimeline(messages: InboxMessage[], room: string): InboxMessage[] {
  return messages
    .filter((message) => !message.direct && (message.room ?? 'general') === room)
    .slice()
    .sort((left, right) => left.receivedAt - right.receivedAt);
}

export function dmTimeline(messages: InboxMessage[], peerId: string): InboxMessage[] {
  return messages
    .filter(
      (message) =>
        message.direct &&
        (message.senderId === peerId || message.recipientId === peerId),
    )
    .slice()
    .sort((left, right) => left.receivedAt - right.receivedAt);
}

/**
 * One row per person the app has a direct-message history with, including
 * people who are no longer in radio range. Newest conversation first.
 */
export function buildDmSummaries(
  messages: InboxMessage[],
  peers: Peer[],
  selfId: string | null,
): DmSummary[] {
  const names = new Map<string, string>();
  for (const peer of peers) names.set(peer.peerId, peer.callsign);
  for (const message of messages) {
    if (message.senderId !== selfId) names.set(message.senderId, message.senderCallsign);
  }

  const summaries = new Map<string, DmSummary>();
  for (const message of messages) {
    if (!message.direct) continue;
    const other = message.senderId === selfId ? message.recipientId : message.senderId;
    if (!other || other === selfId) continue;
    const current = summaries.get(other);
    if (!current || message.receivedAt >= current.lastAt) {
      summaries.set(other, {
        peerId: other,
        callsign: names.get(other) ?? `Node ${other.slice(0, 4)}`,
        last: message,
        lastAt: message.receivedAt,
      });
    }
  }
  return [...summaries.values()].sort((left, right) => right.lastAt - left.lastAt);
}

const dateFormat = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });

/** Today / Yesterday / Sep 14, local time. */
export function dayLabel(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const messageStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start - messageStart) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dateFormat.format(date);
}

/**
 * People in radio range, closest first.
 *
 * Chat prioritises the person physically nearest: in a disaster, someone 20 m
 * away can hand you water now, while a node four hops away cannot. Peers with
 * no position fall back to hop count, then callsign.
 */
export function sortPeersByProximity(peers: Peer[], self: { lat: number; lon: number } | null): Peer[] {
  function distanceTo(peer: Peer): number | null {
    if (!self || !peer.lastKnown) return null;
    const lat = ((peer.lastKnown.lat - self.lat) * Math.PI) / 180;
    const lon = ((peer.lastKnown.lon - self.lon) * Math.PI) / 180;
    const a =
      Math.sin(lat / 2) ** 2 +
      Math.cos((self.lat * Math.PI) / 180) *
        Math.cos((peer.lastKnown.lat * Math.PI) / 180) *
        Math.sin(lon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  return peers.slice().sort((left, right) => {
    const leftDistance = distanceTo(left);
    const rightDistance = distanceTo(right);
    if (leftDistance !== null && rightDistance !== null && leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    if (leftDistance !== null && rightDistance === null) return -1;
    if (leftDistance === null && rightDistance !== null) return 1;
    if (left.hops !== right.hops) return left.hops - right.hops;
    return left.callsign.localeCompare(right.callsign);
  });
}
