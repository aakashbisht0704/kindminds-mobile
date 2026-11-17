/**
 * Mesh routing engine, transport-agnostic.
 *
 * `MeshEngine` owns the protocol decisions (dedupe, TTL, relay, priority
 * ordering) and knows nothing about Bluetooth. The BLE layer feeds it bytes and
 * subscribes to what it wants sent. That split means the whole mesh is testable
 * in-process, which is the only way to trust it in an actual disaster.
 */

import { bytesToBase64, bytesToHex, base64ToBytes, type RandomSource, systemRandom, utf8 } from './bytes';
import {
  deriveSharedKey,
  generateIdentity,
  open,
  peerIdFromPublicKey,
  restoreIdentity,
  revealSecret,
  safetyNumber,
  seal,
  verify,
  type Identity,
} from './crypto';
import {
  createPacket,
  decodeAck,
  decodeAnnouncement,
  decodePacket,
  decodeFileChunk,
  decodeFileMeta,
  decodeLocation,
  decodeRoom,
  decodeSos,
  decodeText,
  encodeAnnouncement,
  encodeFileChunk,
  encodeFileMeta,
  encodeLocation,
  encodePacket,
  encodeRoom,
  encodeSos,
  encodeText,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  FragmentAssembler,
  fragmentPacket,
  headerBytes,
  prepareRelay,
  SeenCache,
  sosRank,
  type AnnouncementPayload,
  type FileKind,
  type FileMetaPayload,
  type MeshPacket,
  type SosPayload,
} from './protocol';
import { sha256 } from '@noble/hashes/sha256';

import type { LatLon } from '../geo';

export type Peer = {
  peerId: string;
  callsign: string;
  skills: string[];
  status: AnnouncementPayload['status'];
  lastSeen: number;
  lastKnown: LatLon | null;
  accuracyM: number | null;
  hops: number;
  verified: boolean;
  signingPublicKey: Uint8Array | null;
  boxPublicKey: Uint8Array | null;
};

export type MessageKind = 'text' | 'file' | 'location';

export type FileAttachment = {
  name: string;
  size: number;
  mime: string;
  sha256: string;
  kind: FileKind;
};

export type InboxMessage = {
  messageId: string;
  senderId: string;
  senderCallsign: string;
  text: string;
  receivedAt: number;
  createdAt: number;
  hops: number;
  /** True when the payload arrived sealed and was successfully decrypted. */
  encrypted: boolean;
  direct: boolean;
  /** Broadcast room tag, or 'direct' for a DM. */
  room: string;
  recipientId: string | null;
  kind: MessageKind;
  file?: FileAttachment;
};

export type ReceivedFile = FileAttachment & {
  transferId: string;
  senderId: string;
  senderCallsign: string;
  room: string;
  receivedAt: number;
  bytes: Uint8Array;
};

type PendingFile = {
  meta: FileMetaPayload;
  senderId: string;
  chunks: Map<number, Uint8Array>;
  received: number;
};

export type SosAlert = {
  messageId: string;
  senderId: string;
  senderCallsign: string;
  payload: SosPayload;
  receivedAt: number;
  createdAt: number;
  hops: number;
  /** True when this device itself sent the alert. */
  mine: boolean;
  acknowledgedBy: string[];
};

export type MeshEvent =
  | { type: 'peers'; peers: Peer[] }
  | { type: 'message'; message: InboxMessage }
  | { type: 'sos'; alert: SosAlert }
  | { type: 'sos-ack'; messageId: string; by: string }
  | { type: 'file-progress'; transferId: string; name: string; received: number; total: number }
  | { type: 'file'; file: ReceivedFile }
  | { type: 'outbound'; frames: Uint8Array[] };

export type MeshEngineOptions = {
  identity?: Identity;
  random?: RandomSource;
  now?: () => number;
  /** Peers expire from the list after this long without an announcement. */
  peerTtlMs?: number;
  selfCallsign?: string;
};

export class MeshEngine {
  readonly identity: Identity;
  private readonly random: RandomSource;
  private readonly now: () => number;
  private readonly peerTtlMs: number;
  private readonly seen = new SeenCache();
  private readonly assembler = new FragmentAssembler();
  private readonly peers = new Map<string, Peer>();
  private readonly messages: InboxMessage[] = [];
  private readonly alerts = new Map<string, SosAlert>();
  private readonly incomingFiles = new Map<string, PendingFile>();
  private readonly listeners = new Set<(event: MeshEvent) => void>();
  private selfCallsign: string;
  private selfPosition: { point: LatLon; accuracyM: number | null } | null = null;
  private selfStatus: AnnouncementPayload['status'] = 'ok';

  constructor(options: MeshEngineOptions = {}) {
    this.random = options.random ?? systemRandom;
    this.now = options.now ?? Date.now;
    this.peerTtlMs = options.peerTtlMs ?? 3 * 60_000;
    this.selfCallsign = options.selfCallsign ?? 'Unnamed';
    this.identity = options.identity ?? generateIdentity(this.random, this.now());
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  get secret() {
    return revealSecret(this.identity);
  }

  subscribe(listener: (event: MeshEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MeshEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  setCallsign(callsign: string): void {
    this.selfCallsign = callsign.trim().slice(0, 24) || 'Unnamed';
  }

  setPosition(point: LatLon, accuracyM: number | null): void {
    this.selfPosition = { point, accuracyM };
  }

  setStatus(status: AnnouncementPayload['status']): void {
    this.selfStatus = status;
  }

  /** Peers seen within the TTL, nearest-known first. */
  activePeers(): Peer[] {
    const cutoff = this.now() - this.peerTtlMs;
    return [...this.peers.values()]
      .filter((peer) => peer.lastSeen >= cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  history(): InboxMessage[] {
    return [...this.messages];
  }

  sosAlerts(): SosAlert[] {
    return [...this.alerts.values()].sort((a, b) => sosRankOf(a) - sosRankOf(b) || b.receivedAt - a.receivedAt);
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  private packet(
    type: MeshPacket['type'],
    payload: Uint8Array,
    recipientId: string | null = null,
    ttl?: number,
  ): MeshPacket {
    return createPacket(
      {
        type,
        senderId: this.identity.peerId,
        recipientId,
        payload,
        ttl: ttl ?? (recipientId ? 3 : 8),
        createdAt: this.now(),
      },
      this.random,
    );
  }

  /** Queue an announcement so neighbours learn callsign, skills and position. */
  announce(): MeshPacket {
    const payload = encodeAnnouncement({
      callsign: this.selfCallsign,
      skills: [],
      status: this.selfStatus,
      lat: this.selfPosition?.point.lat ?? null,
      lon: this.selfPosition?.point.lon ?? null,
      accuracyM: this.selfPosition?.accuracyM ?? null,
    });
    return this.packet('announce', payload);
  }

  sendBroadcast(text: string, room = 'general'): MeshPacket {
    const clean = text.slice(0, 800);
    const tag = room.trim().slice(0, 32) || 'general';
    const packet = this.packet('room', encodeRoom({ room: tag, text: clean }));
    this.recordOwnMessage(packet, clean, false, packet.ttl, { room: tag, kind: 'text' });
    return packet;
  }

  /** Share the current position as an explicit location ping. */
  sendLocation(room = 'general', toPeerId?: string): MeshPacket | null {
    if (!this.selfPosition) return null;
    const tag = room.trim().slice(0, 32) || 'general';
    const packet = this.packet(
      'location',
      encodeLocation({
        lat: this.selfPosition.point.lat,
        lon: this.selfPosition.point.lon,
        accuracyM: this.selfPosition.accuracyM,
        room: tag,
      }),
      toPeerId ?? null,
    );
    this.recordOwnMessage(
      packet,
      `Shared a location: ${this.selfPosition.point.lat.toFixed(4)}, ${this.selfPosition.point.lon.toFixed(4)}`,
      false,
      packet.ttl,
      {
        room: toPeerId ? 'direct' : tag,
        recipientId: toPeerId ?? null,
        kind: 'location',
      },
    );
    return packet;
  }

  /**
   * Split a file into mesh packets. The caller sends the returned packets in
   * order; the receiving engine reassembles and verifies the SHA-256.
   */
  shareFile(name: string, bytes: Uint8Array, mime: string, room = 'maps'): MeshPacket[] {
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return [];
    const transferId = bytesToHex(this.random(8));
    const chunks = Math.ceil(bytes.length / FILE_CHUNK_BYTES);
    const digest = bytesToHex(sha256(bytes));
    const tag = room.trim().slice(0, 32) || 'maps';
    const meta: FileMetaPayload = {
      transferId,
      name: name.slice(0, 120),
      size: bytes.length,
      mime: mime.slice(0, 100),
      chunks,
      room: tag,
      kind: name.toLowerCase().endsWith('.mbtiles') ? 'map' : 'file',
      sha256: digest,
    };

    const packets: MeshPacket[] = [this.packet('fileMeta', encodeFileMeta(meta))];
    for (let index = 0; index < chunks; index += 1) {
      const start = index * FILE_CHUNK_BYTES;
      const slice = bytes.subarray(start, start + FILE_CHUNK_BYTES);
      packets.push(
        this.packet('fileChunk', encodeFileChunk({ transferId, index, data: bytesToBase64(slice) })),
      );
    }

    this.recordOwnMessage(packets[0]!, `Shared ${meta.name}`, false, 8, {
      room: tag,
      kind: 'file',
      file: {
        name: meta.name,
        size: meta.size,
        mime: meta.mime,
        sha256: meta.sha256,
        kind: meta.kind,
      },
    });
    return packets;
  }

  /** End-to-end sealed direct message. Requires a peer with a known box key. */
  sendDirect(text: string, toPeerId: string): MeshPacket | null {
    const peer = this.peers.get(toPeerId);
    const boxPublicKey = peer?.boxPublicKey;
    if (!peer || !boxPublicKey) return null;

    const key = deriveSharedKey(this.identity, { boxPublicKey, peerId: peer.peerId });
    const base = this.packet('direct', new Uint8Array(0), toPeerId);
    const sealed = seal(key, encodeText(text.slice(0, 800)), headerBytes(base), this.random);

    const payload = encodeText(
      JSON.stringify({
        nonce: bytesToBase64(sealed.nonce),
        ciphertext: bytesToBase64(sealed.ciphertext),
        boxPublicKey: bytesToBase64(this.identity.boxPublicKey),
      }),
    );
    const packet = { ...base, payload };
    this.recordOwnMessage(packet, text.slice(0, 800), true, packet.ttl, {
      room: 'direct',
      recipientId: toPeerId,
      kind: 'text',
    });
    return packet;
  }

  sendSos(payload: SosPayload): MeshPacket {
    const packet = this.packet('sos', encodeSos(payload), null, 8);
    const alert: SosAlert = {
      messageId: packet.messageId,
      senderId: this.identity.peerId,
      senderCallsign: this.selfCallsign,
      payload,
      receivedAt: this.now(),
      createdAt: packet.createdAt,
      hops: 0,
      mine: true,
      acknowledgedBy: [],
    };
    this.alerts.set(packet.messageId, alert);
    this.emit({ type: 'sos', alert });
    return packet;
  }

  /** Acknowledge someone else's SOS so they know a human saw it. */
  ackSos(messageId: string, toPeerId: string): MeshPacket {
    return this.packet(
      'ack',
      encodeText(JSON.stringify({ ackMessageId: messageId, by: this.selfCallsign })),
      toPeerId,
      3,
    );
  }

  /**
   * Fan a packet out into BLE-sized frames.
   *
   * `frameDataBytes` is the payload budget the live radio can carry in one
   * write. Passing it keeps a frame inside the negotiated ATT MTU; a frame
   * larger than the MTU is rejected by the stack, so the default is only safe
   * for a link that granted the full 360 bytes.
   */
  framesFor(packet: MeshPacket, frameDataBytes?: number): Uint8Array[] {
    return fragmentPacket(encodePacket(packet), frameDataBytes);
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Feed raw bytes from a BLE characteristic. Returns frames to relay, if any.
   * Never throws: a malformed packet from a stranger must not crash the app.
   */
  ingestFrame(frame: Uint8Array): Uint8Array[] {
    const complete = this.assembler.add(frame);
    if (!complete) return [];
    const decoded = decodePacket(complete);
    if (!decoded.ok) return [];
    return this.ingestPacket(decoded.packet);
  }

  ingestPacket(packet: MeshPacket): Uint8Array[] {
    if (packet.senderId === this.identity.peerId) return [];
    if (!this.seen.check(`${packet.senderId}:${packet.messageId}`)) return [];

    switch (packet.type) {
      case 'announce':
        this.handleAnnouncement(packet);
        break;
      case 'message':
        this.handleBroadcast(packet);
        break;
      case 'sos':
        this.handleSos(packet);
        break;
      case 'direct':
        this.handleDirect(packet);
        break;
      case 'ack':
        this.handleAck(packet);
        break;
      case 'room':
        this.handleRoom(packet);
        break;
      case 'fileMeta':
        this.handleFileMeta(packet);
        break;
      case 'fileChunk':
        this.handleFileChunk(packet);
        break;
      case 'location':
        this.handleLocation(packet);
        break;
    }

    const relay = prepareRelay(packet);
    return relay ? fragmentPacket(encodePacket(relay)) : [];
  }

  private upsertPeer(peerId: string, patch: Partial<Peer>): Peer {
    const existing = this.peers.get(peerId);
    const peer: Peer = {
      peerId,
      callsign: existing?.callsign ?? `Node ${peerId.slice(0, 4)}`,
      skills: existing?.skills ?? [],
      status: existing?.status ?? 'ok',
      lastSeen: this.now(),
      lastKnown: existing?.lastKnown ?? null,
      accuracyM: existing?.accuracyM ?? null,
      hops: existing?.hops ?? 0,
      verified: existing?.verified ?? false,
      signingPublicKey: existing?.signingPublicKey ?? null,
      boxPublicKey: existing?.boxPublicKey ?? null,
      ...patch,
    };
    this.peers.set(peerId, peer);
    return peer;
  }

  private handleAnnouncement(packet: MeshPacket): void {
    const payload = decodeAnnouncement(packet);
    if (!payload) return;
    const position =
      payload.lat !== null && payload.lon !== null ? { lat: payload.lat, lon: payload.lon } : null;
    this.upsertPeer(packet.senderId, {
      callsign: payload.callsign,
      skills: payload.skills,
      status: payload.status,
      lastSeen: this.now(),
      lastKnown: position,
      accuracyM: payload.accuracyM,
      hops: 8 - packet.ttl,
    });
    this.emit({ type: 'peers', peers: this.activePeers() });
  }

  private handleBroadcast(packet: MeshPacket): void {
    // Old clients sent `message`; new clients send `room` with a tag.
    const room = decodeRoom(packet);
    const text = room?.text ?? decodeText(packet);
    const message = this.recordOwnMessage(packet, text, false, packet.ttl, {
      room: room?.room ?? 'general',
      kind: 'text',
    });
    this.emit({ type: 'message', message });
  }

  private handleRoom(packet: MeshPacket): void {
    const room = decodeRoom(packet);
    if (!room) return;
    const message = this.recordOwnMessage(packet, room.text, false, packet.ttl, {
      room: room.room,
      kind: 'text',
    });
    this.emit({ type: 'message', message });
  }

  private handleLocation(packet: MeshPacket): void {
    const location = decodeLocation(packet);
    if (!location) return;
    this.upsertPeer(packet.senderId, {
      lastSeen: this.now(),
      lastKnown: { lat: location.lat, lon: location.lon },
      accuracyM: location.accuracyM,
      hops: 8 - packet.ttl,
    });
    const message = this.recordOwnMessage(
      packet,
      `Shared a location: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`,
      false,
      packet.ttl,
      {
        room: packet.recipientId ? 'direct' : (location.room ?? 'general'),
        recipientId: packet.recipientId,
        kind: 'location',
      },
    );
    this.emit({ type: 'message', message });
    this.emit({ type: 'peers', peers: this.activePeers() });
  }

  private handleFileMeta(packet: MeshPacket): void {
    const meta = decodeFileMeta(packet);
    if (!meta) return;
    if (this.incomingFiles.has(meta.transferId)) return;
    if (this.incomingFiles.size >= 3) {
      const oldest = this.incomingFiles.keys().next();
      if (!oldest.done) this.incomingFiles.delete(oldest.value);
    }
    this.incomingFiles.set(meta.transferId, {
      meta,
      senderId: packet.senderId,
      chunks: new Map(),
      received: 0,
    });
    this.emit({
      type: 'file-progress',
      transferId: meta.transferId,
      name: meta.name,
      received: 0,
      total: meta.size,
    });
  }

  private handleFileChunk(packet: MeshPacket): void {
    const chunk = decodeFileChunk(packet);
    if (!chunk) return;
    const pending = this.incomingFiles.get(chunk.transferId);
    if (!pending) return;
    if (pending.chunks.has(chunk.index) || chunk.index >= pending.meta.chunks) return;

    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(chunk.data);
    } catch {
      return;
    }
    pending.chunks.set(chunk.index, bytes);
    pending.received += bytes.length;

    this.emit({
      type: 'file-progress',
      transferId: pending.meta.transferId,
      name: pending.meta.name,
      received: pending.received,
      total: pending.meta.size,
    });

    if (pending.chunks.size < pending.meta.chunks) return;

    const ordered: Uint8Array[] = [];
    for (let index = 0; index < pending.meta.chunks; index += 1) {
      const part = pending.chunks.get(index);
      if (!part) return;
      ordered.push(part);
    }
    const total = ordered.reduce((sum, part) => sum + part.length, 0);
    const complete = new Uint8Array(total);
    let offset = 0;
    for (const part of ordered) {
      complete.set(part, offset);
      offset += part.length;
    }
    this.incomingFiles.delete(pending.meta.transferId);

    if (complete.length !== pending.meta.size) return;
    if (bytesToHex(sha256(complete)) !== pending.meta.sha256) return;

    this.emit({
      type: 'file',
      file: {
        transferId: pending.meta.transferId,
        senderId: pending.senderId,
        senderCallsign:
          this.peers.get(pending.senderId)?.callsign ?? `Node ${pending.senderId.slice(0, 4)}`,
        name: pending.meta.name,
        size: pending.meta.size,
        mime: pending.meta.mime,
        sha256: pending.meta.sha256,
        kind: pending.meta.kind,
        room: pending.meta.room,
        receivedAt: this.now(),
        bytes: complete,
      },
    });
  }

  private handleSos(packet: MeshPacket): void {
    const payload = decodeSos(packet);
    if (!payload) return;
    // Re-broadcasting the same alert must not duplicate it in the alert list.
    const existing = this.alerts.get(packet.messageId);
    if (existing) {
      existing.hops = Math.min(existing.hops, 8 - packet.ttl);
      return;
    }
    const alert: SosAlert = {
      messageId: packet.messageId,
      senderId: packet.senderId,
      senderCallsign: this.peers.get(packet.senderId)?.callsign ?? `Node ${packet.senderId.slice(0, 4)}`,
      payload,
      receivedAt: this.now(),
      createdAt: packet.createdAt,
      hops: 8 - packet.ttl,
      mine: false,
      acknowledgedBy: [],
    };
    this.alerts.set(packet.messageId, alert);
    this.emit({ type: 'sos', alert });
  }

  private handleDirect(packet: MeshPacket): void {
    if (packet.recipientId !== this.identity.peerId) return;
    const peer = this.peers.get(packet.senderId);
    if (!peer) return;

    let parsed: { nonce: string; ciphertext: string; boxPublicKey: string };
    try {
      parsed = JSON.parse(decodeText(packet) || '{}') as typeof parsed;
    } catch {
      return;
    }
    if (!parsed.ciphertext || !parsed.nonce || !parsed.boxPublicKey) return;

    const boxPublicKey = base64ToBytes(parsed.boxPublicKey);
    this.peers.set(packet.senderId, { ...peer, boxPublicKey });

    const key = deriveSharedKey(this.identity, { boxPublicKey, peerId: packet.senderId });
    const plaintext = open(
      key,
      { nonce: base64ToBytes(parsed.nonce), ciphertext: base64ToBytes(parsed.ciphertext) },
      headerBytes(packet),
    );
    if (!plaintext) return;

    const message = this.recordOwnMessage(packet, utf8.decode(plaintext), true, packet.ttl, {
      room: 'direct',
      recipientId: this.identity.peerId,
      kind: 'text',
    });
    this.emit({ type: 'message', message });
  }

  private handleAck(packet: MeshPacket): void {
    const ack = decodeAck(packet);
    if (!ack) return;
    const alert = this.alerts.get(ack.ackMessageId);
    if (!alert) return;
    if (!alert.acknowledgedBy.includes(ack.by)) alert.acknowledgedBy.push(ack.by);
    this.emit({ type: 'sos-ack', messageId: ack.ackMessageId, by: ack.by });
  }

  private recordOwnMessage(
    packet: MeshPacket,
    text: string,
    encrypted = false,
    ttl = 8,
    extra: {
      room?: string;
      recipientId?: string | null;
      kind?: MessageKind;
      file?: FileAttachment;
    } = {},
  ): InboxMessage {
    const direct = Boolean(extra.recipientId) || packet.type === 'direct';
    const message: InboxMessage = {
      messageId: packet.messageId,
      senderId: packet.senderId,
      senderCallsign: this.peers.get(packet.senderId)?.callsign ?? this.selfCallsign,
      text,
      receivedAt: this.now(),
      createdAt: packet.createdAt,
      hops: packet.senderId === this.identity.peerId ? 0 : 8 - ttl,
      encrypted,
      direct,
      room: extra.room ?? (direct ? 'direct' : 'general'),
      recipientId: extra.recipientId ?? packet.recipientId,
      kind: extra.kind ?? 'text',
      file: extra.file,
    };
    this.messages.push(message);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    return message;
  }

  /** Verify a peer's safety number out of band, e.g. read aloud on a radio. */
  peerSafetyNumber(peerId: string): string | null {
    const peer = this.peers.get(peerId);
    if (!peer?.signingPublicKey) return null;
    return safetyNumber(this.identity.signPublicKey, peer.signingPublicKey);
  }

  /** Accept an announcement's claimed key only after the user confirms digits. */
  trustPeerKey(peerId: string, signingPublicKey: Uint8Array, boxPublicKey?: Uint8Array): void {
    this.upsertPeer(peerId, {
      verified: peerIdFromPublicKey(signingPublicKey) === peerId,
      signingPublicKey,
      boxPublicKey: boxPublicKey ?? this.peers.get(peerId)?.boxPublicKey ?? null,
    });
    this.emit({ type: 'peers', peers: this.activePeers() });
  }

  static restore(secret: Parameters<typeof restoreIdentity>[0], options: Omit<MeshEngineOptions, 'identity'> = {}): MeshEngine {
    return new MeshEngine({ ...options, identity: restoreIdentity(secret) });
  }
}

function sosRankOf(alert: SosAlert): number {
  const needs = alert.payload.needs;
  if (needs.length === 0) return 50;
  const priorities: Record<string, number> = {
    medical: 0, rescue: 1, water: 2, shelter: 3, food: 4, power: 5,
  };
  return Math.min(...needs.map((need) => priorities[need] ?? 50));
}

export { verify };
