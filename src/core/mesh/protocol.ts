/**
 * KindMinds mesh wire format (KMP/1).
 *
 * Design constraints that shaped this:
 *  - A BLE write is small and unreliable, so packets must be independently
 *    decodable and cheap to deduplicate.
 *  - A mesh of panicking people is a broadcast storm, so every packet carries a
 *    hop budget (TTL) and a random message id relays can suppress duplicates by.
 *  - Handsets lose links mid-write, so payloads larger than one frame are
 *    fragmented with an explicit index/count and a hard reassembly ceiling.
 *
 * Header is fixed-width binary; payloads are UTF-8/JSON blobs whose shape is
 * defined per packet type below. Header bytes are the associated data for
 * sealed direct packets, so a relay cannot rewrite routing fields unnoticed.
 */

import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  type RandomSource,
  systemRandom,
  utf8,
} from './bytes';

export const MAGIC = [0x4b, 0x4d] as const; // "KM"
export const PROTOCOL_VERSION = 1;

export const MAX_PAYLOAD_BYTES = 8 * 1024;
export const FRAME_DATA_BYTES = 360;
/** Relay ceiling: beyond this a packet is local-only noise. */
export const MAX_TTL = 8;

export const PACKET_TYPES = {
  announce: 1,
  message: 2,
  sos: 3,
  ack: 4,
  direct: 5,
  room: 6,
  fileMeta: 7,
  fileChunk: 8,
  location: 9,
} as const;

export type PacketTypeName = keyof typeof PACKET_TYPES;
export type PacketTypeCode = (typeof PACKET_TYPES)[PacketTypeName];

const CODE_TO_TYPE = new Map<number, PacketTypeName>(
  (Object.entries(PACKET_TYPES) as [PacketTypeName, PacketTypeCode][]).map(([name, code]) => [code, name]),
);

const HEADER_BYTES = 2 + 1 + 1 + 1 + 4 + 8 + 8 + 8 + 2;

export type MeshPacket = {
  type: PacketTypeName;
  ttl: number;
  createdAt: number;
  messageId: string;
  senderId: string;
  /** null means broadcast to every peer in range. */
  recipientId: string | null;
  payload: Uint8Array;
};

export type AnnouncementPayload = {
  callsign: string;
  skills: string[];
  status: 'ok' | 'injured' | 'trapped' | 'assisting';
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
};

export const SOS_NEEDS = ['medical', 'water', 'food', 'shelter', 'rescue', 'power'] as const;
export type SosNeed = (typeof SOS_NEEDS)[number];

export type SosPayload = {
  lat: number;
  lon: number;
  accuracyM: number | null;
  people: number;
  needs: SosNeed[];
  note: string;
};

export const SOS_PRIORITY: Record<SosNeed, number> = {
  medical: 0,
  rescue: 1,
  water: 2,
  shelter: 3,
  food: 4,
  power: 5,
};

export type AckPayload = { ackMessageId: string; by: string };

export type DirectPayload = {
  nonce: string;
  ciphertext: string;
  /** Sender's X25519 public key, so the recipient can derive the shared key. */
  boxPublicKey: string;
};

/** A room is a local broadcast tag, not a server-side channel. */
export type RoomPayload = { room: string; text: string };

export type FileKind = 'map' | 'file';

export type FileMetaPayload = {
  transferId: string;
  name: string;
  size: number;
  mime: string;
  chunks: number;
  room: string;
  kind: FileKind;
  /** SHA-256 of the complete file, hex encoded. */
  sha256: string;
};

export type FileChunkPayload = {
  transferId: string;
  index: number;
  /** Base64 of a chunk; chunks stay far below MAX_PAYLOAD_BYTES. */
  data: string;
};

export type LocationPayload = {
  lat: number;
  lon: number;
  accuracyM: number | null;
  room: string;
};

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 3000;
export const MAX_FILE_CHUNKS = Math.ceil(MAX_FILE_BYTES / FILE_CHUNK_BYTES);

function jsonPayload(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value));
}

export function encodeRoom(payload: RoomPayload): Uint8Array {
  return jsonPayload({ room: payload.room.slice(0, 32), text: payload.text.slice(0, 800) });
}

export function encodeFileMeta(payload: FileMetaPayload): Uint8Array {
  return jsonPayload(payload);
}

export function encodeFileChunk(payload: FileChunkPayload): Uint8Array {
  return jsonPayload(payload);
}

export function encodeLocation(payload: LocationPayload): Uint8Array {
  return jsonPayload(payload);
}

function decodeJson(packet: MeshPacket): unknown {
  try {
    return JSON.parse(utf8.decode(packet.payload));
  } catch {
    return null;
  }
}

export function decodeRoom(packet: MeshPacket): RoomPayload | null {
  const raw = decodeJson(packet) as Partial<RoomPayload> | null;
  if (!raw || typeof raw.text !== 'string' || typeof raw.room !== 'string') return null;
  return { room: raw.room.slice(0, 32), text: raw.text.slice(0, 800) };
}

export function decodeFileMeta(packet: MeshPacket): FileMetaPayload | null {
  const raw = decodeJson(packet) as Partial<FileMetaPayload> | null;
  if (!raw || typeof raw.transferId !== 'string' || typeof raw.name !== 'string') return null;
  if (typeof raw.size !== 'number' || !Number.isFinite(raw.size)) return null;
  if (raw.size < 0 || raw.size > MAX_FILE_BYTES) return null;
  if (typeof raw.chunks !== 'number' || !Number.isFinite(raw.chunks)) return null;
  if (raw.chunks < 1 || raw.chunks > MAX_FILE_CHUNKS) return null;
  if (typeof raw.mime !== 'string' || typeof raw.sha256 !== 'string') return null;
  return {
    transferId: raw.transferId.slice(0, 32),
    name: raw.name.slice(0, 120),
    size: raw.size,
    mime: raw.mime.slice(0, 100),
    chunks: raw.chunks,
    room: (raw.room ?? 'general').slice(0, 32),
    kind: raw.kind === 'map' ? 'map' : 'file',
    sha256: raw.sha256.slice(0, 64),
  };
}

export function decodeFileChunk(packet: MeshPacket): FileChunkPayload | null {
  const raw = decodeJson(packet) as Partial<FileChunkPayload> | null;
  if (!raw || typeof raw.transferId !== 'string' || typeof raw.data !== 'string') return null;
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) return null;
  if (raw.data.length > 5000) return null;
  return { transferId: raw.transferId.slice(0, 32), index: raw.index, data: raw.data };
}

export function decodeLocation(packet: MeshPacket): LocationPayload | null {
  const raw = decodeJson(packet) as Partial<LocationPayload> | null;
  if (!raw || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null;
  if (!Number.isFinite(raw.lat) || !Number.isFinite(raw.lon)) return null;
  return {
    lat: Math.max(-90, Math.min(90, raw.lat)),
    lon: Math.max(-180, Math.min(180, raw.lon)),
    accuracyM: typeof raw.accuracyM === 'number' ? raw.accuracyM : null,
    room: (raw.room ?? 'general').slice(0, 32),
  };
}

export function randomMessageId(random: RandomSource = systemRandom): string {
  return bytesToHex(random(8));
}

export function createPacket(
  input: Omit<MeshPacket, 'messageId' | 'createdAt' | 'ttl'> & {
    messageId?: string;
    createdAt?: number;
    ttl?: number;
  },
  random: RandomSource = systemRandom,
): MeshPacket {
  return {
    type: input.type,
    ttl: Math.min(MAX_TTL, Math.max(1, input.ttl ?? MAX_TTL)),
    createdAt: input.createdAt ?? Date.now(),
    messageId: input.messageId ?? randomMessageId(random),
    senderId: input.senderId,
    recipientId: input.recipientId,
    payload: input.payload,
  };
}

export function encodeAnnouncement(payload: AnnouncementPayload): Uint8Array {
  return utf8.encode(JSON.stringify(payload));
}

export function encodeSos(payload: SosPayload): Uint8Array {
  return utf8.encode(JSON.stringify(payload));
}

export function encodeText(text: string): Uint8Array {
  return utf8.encode(text);
}

export type DecodeResult = { ok: true; packet: MeshPacket } | { ok: false; error: string };

export function encodePacket(packet: MeshPacket): Uint8Array {
  if (packet.payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const sender = hexToBytes(packet.senderId);
  const recipient = packet.recipientId ? hexToBytes(packet.recipientId) : new Uint8Array(8);
  if (sender.length !== 8 || recipient.length !== 8) throw new Error('peer ids must be 8 bytes');
  const messageId = hexToBytes(packet.messageId);
  if (messageId.length !== 8) throw new Error('message id must be 8 bytes');

  const header = new Uint8Array(HEADER_BYTES);
  let offset = 0;
  header[offset++] = MAGIC[0];
  header[offset++] = MAGIC[1];
  header[offset++] = PROTOCOL_VERSION;
  header[offset++] = PACKET_TYPES[packet.type];
  header[offset++] = Math.min(MAX_TTL, Math.max(0, packet.ttl));

  // 4-byte seconds epoch: compact, and valid until 2106.
  const seconds = Math.floor(packet.createdAt / 1000);
  header[offset++] = (seconds >>> 24) & 0xff;
  header[offset++] = (seconds >>> 16) & 0xff;
  header[offset++] = (seconds >>> 8) & 0xff;
  header[offset++] = seconds & 0xff;

  header.set(messageId, offset);
  offset += 8;
  header.set(sender, offset);
  offset += 8;
  header.set(recipient, offset);
  offset += 8;

  header[offset++] = (packet.payload.length >>> 8) & 0xff;
  header[offset++] = packet.payload.length & 0xff;

  return concatBytes(header, packet.payload);
}

export function decodePacket(bytes: Uint8Array): DecodeResult {
  if (bytes.length < HEADER_BYTES) return { ok: false, error: 'truncated header' };
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return { ok: false, error: 'bad magic' };
  if (bytes[2] !== PROTOCOL_VERSION) return { ok: false, error: `unsupported version ${bytes[2] ?? 0}` };

  const type = CODE_TO_TYPE.get(bytes[3] ?? 0);
  if (!type) return { ok: false, error: `unknown packet type ${bytes[3] ?? 0}` };

  const ttl = bytes[4] ?? 0;
  const seconds =
    ((bytes[5] ?? 0) << 24) | ((bytes[6] ?? 0) << 16) | ((bytes[7] ?? 0) << 8) | (bytes[8] ?? 0);
  const messageId = bytesToHex(bytes.subarray(9, 17));
  const senderId = bytesToHex(bytes.subarray(17, 25));
  const recipientRaw = bytes.subarray(25, 33);
  const recipientId = recipientRaw.some((b) => b !== 0) ? bytesToHex(recipientRaw) : null;
  const payloadLength = ((bytes[33] ?? 0) << 8) | (bytes[34] ?? 0);

  if (payloadLength > MAX_PAYLOAD_BYTES) return { ok: false, error: 'payload too large' };
  if (bytes.length !== HEADER_BYTES + payloadLength) {
    return { ok: false, error: 'length mismatch' };
  }

  return {
    ok: true,
    packet: {
      type,
      ttl,
      createdAt: (seconds >>> 0) * 1000,
      messageId,
      senderId,
      recipientId,
      payload: bytes.subarray(HEADER_BYTES),
    },
  };
}

/** Header minus payload: the associated data a sealed direct packet binds to. */
export function headerBytes(packet: MeshPacket): Uint8Array {
  return encodePacket({ ...packet, payload: new Uint8Array(0) });
}

export function decodeAnnouncement(packet: MeshPacket): AnnouncementPayload | null {
  try {
    const raw = JSON.parse(utf8.decode(packet.payload)) as Partial<AnnouncementPayload>;
    if (typeof raw.callsign !== 'string') return null;
    return {
      callsign: raw.callsign.slice(0, 24),
      skills: Array.isArray(raw.skills) ? raw.skills.filter((s): s is string => typeof s === 'string').slice(0, 8) : [],
      status: raw.status ?? 'ok',
      lat: typeof raw.lat === 'number' ? raw.lat : null,
      lon: typeof raw.lon === 'number' ? raw.lon : null,
      accuracyM: typeof raw.accuracyM === 'number' ? raw.accuracyM : null,
    };
  } catch {
    return null;
  }
}

export function decodeSos(packet: MeshPacket): SosPayload | null {
  try {
    const raw = JSON.parse(utf8.decode(packet.payload)) as Partial<SosPayload>;
    if (typeof raw.lat !== 'number' || typeof raw.lon !== 'number') return null;
    const needs = Array.isArray(raw.needs)
      ? raw.needs.filter((need): need is SosNeed => SOS_NEEDS.includes(need as SosNeed))
      : [];
    return {
      lat: raw.lat,
      lon: raw.lon,
      accuracyM: typeof raw.accuracyM === 'number' ? raw.accuracyM : null,
      people: typeof raw.people === 'number' ? Math.max(1, Math.round(raw.people)) : 1,
      needs,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 180) : '',
    };
  } catch {
    return null;
  }
}

export function decodeAck(packet: MeshPacket): AckPayload | null {
  try {
    const raw = JSON.parse(utf8.decode(packet.payload)) as Partial<AckPayload>;
    if (typeof raw.ackMessageId !== 'string') return null;
    return { ackMessageId: raw.ackMessageId, by: typeof raw.by === 'string' ? raw.by : packet.senderId };
  } catch {
    return null;
  }
}

export function decodeText(packet: MeshPacket): string {
  return utf8.decode(packet.payload);
}

/**
 * Relay policy. Returns the packet to forward (TTL decremented) or null when
 * this device is the last hop. Broadcasts and SOS relay; direct traffic does
 * not, because a sealed packet addressed to someone else is not ours to carry
 * beyond the neighbours it already reached.
 */
export function prepareRelay(packet: MeshPacket): MeshPacket | null {
  if (packet.ttl <= 1) return null;
  if (packet.type === 'direct') return null;
  return { ...packet, ttl: packet.ttl - 1 };
}

export function sosRank(packet: MeshPacket): number {
  if (packet.type !== 'sos') return 99;
  const sos = decodeSos(packet);
  if (!sos) return 99;
  if (sos.needs.length === 0) return 50;
  return Math.min(...sos.needs.map((need) => SOS_PRIORITY[need] ?? 50));
}

// ---------------------------------------------------------------------------
// Fragmentation
// ---------------------------------------------------------------------------

const FRAG_MAGIC = [0x4b, 0x46] as const; // "KF"
const FRAG_HEADER_BYTES = 2 + 1 + 8 + 1 + 1;

export type FragmentFrame = { fragId: string; index: number; total: number; data: Uint8Array };

export function fragmentPacket(packetBytes: Uint8Array, frameDataBytes = FRAME_DATA_BYTES): Uint8Array[] {
  const total = Math.max(1, Math.ceil(packetBytes.length / frameDataBytes));
  if (total > 255) throw new Error('packet needs more than 255 frames');
  if (packetBytes.length < HEADER_BYTES) throw new Error('packet too short to fragment');
  // The frag id must identify the *packet*, not its header prefix: bytes 0-8 are
  // magic, version, type, ttl and a seconds clock, so two packets of the same
  // type sent in the same second would share a reassembly buffer and corrupt
  // each other. The message id (offset 9) is exactly the unique part.
  const fragId = packetBytes.subarray(9, 17);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = packetBytes.subarray(index * frameDataBytes, (index + 1) * frameDataBytes);
    const frame = new Uint8Array(FRAG_HEADER_BYTES + chunk.length);
    frame[0] = FRAG_MAGIC[0];
    frame[1] = FRAG_MAGIC[1];
    frame[2] = PROTOCOL_VERSION;
    frame.set(fragId, 3);
    frame[11] = index;
    frame[12] = total;
    frame.set(chunk, FRAG_HEADER_BYTES);
    frames.push(frame);
  }
  return frames;
}

export function decodeFrame(frame: Uint8Array): FragmentFrame | null {
  if (frame.length <= FRAG_HEADER_BYTES) return null;
  if (frame[0] !== FRAG_MAGIC[0] || frame[1] !== FRAG_MAGIC[1]) return null;
  if (frame[2] !== PROTOCOL_VERSION) return null;
  const index = frame[11] ?? 0;
  const total = frame[12] ?? 0;
  if (total === 0 || index >= total) return null;
  return {
    fragId: bytesToHex(frame.subarray(3, 11)),
    index,
    total,
    data: frame.subarray(FRAG_HEADER_BYTES),
  };
}

type PendingAssembly = {
  total: number;
  parts: (Uint8Array | null)[];
  createdAt: number;
  received: number;
};

/**
 * Reassembles packets from out-of-order BLE frames. Bounded on purpose: a
 * hostile or broken peer cannot make the app allocate without limit.
 */
export class FragmentAssembler {
  private readonly pending = new Map<string, PendingAssembly>();

  constructor(
    private readonly maxBuffers = 16,
    private readonly ttlMs = 45_000,
    private readonly now: () => number = Date.now,
  ) {}

  add(frame: Uint8Array): Uint8Array | null {
    const decoded = decodeFrame(frame);
    if (!decoded) return null;
    this.evictExpired();

    let entry = this.pending.get(decoded.fragId);
    if (!entry) {
      if (this.pending.size >= this.maxBuffers) {
        // Drop the oldest partial rather than refusing the new one.
        const oldest = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
        if (oldest) this.pending.delete(oldest[0]);
      }
      entry = {
        total: decoded.total,
        parts: new Array<Uint8Array | null>(decoded.total).fill(null),
        createdAt: this.now(),
        received: 0,
      };
      this.pending.set(decoded.fragId, entry);
    }

    if (entry.total !== decoded.total) {
      this.pending.delete(decoded.fragId);
      return null;
    }
    if (entry.parts[decoded.index]) return null; // duplicate frame
    entry.parts[decoded.index] = decoded.data;
    entry.received += 1;

    if (entry.received !== entry.total) return null;

    this.pending.delete(decoded.fragId);
    const size = entry.parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const part of entry.parts) {
      if (!part) return null;
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(id);
    }
  }
}

/**
 * Duplicate suppression for relayed traffic. Insertion-ordered Map doubles as an
 * LRU, so the memory ceiling is fixed regardless of how loud the neighbourhood
 * gets.
 */
export class SeenCache {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly capacity = 512,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when this is the first time the id has been observed. */
  check(messageId: string): boolean {
    const timestamp = this.now();
    const previous = this.seen.get(messageId);
    if (previous !== undefined && timestamp - previous < this.ttlMs) return false;
    this.seen.delete(messageId);
    this.seen.set(messageId, timestamp);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
