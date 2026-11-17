/**
 * Mesh identity and end-to-end sealing.
 *
 * Two keypairs per device: X25519 for key agreement (private messages) and
 * Ed25519 for signing (authenticity of announcements, so a relay cannot forge
 * "I am a rescue team"). Broadcast traffic stays in the clear on purpose: an
 * SOS that a stranger's phone cannot read is an SOS that does not work.
 *
 * Everything is pure JS over @noble, so the same code path that runs on device
 * is exercised by the test suite in this repo.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import {
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  hexToBytes,
  utf8,
  type RandomSource,
} from './bytes';

export const NONCE_BYTES = 24;
export const KEY_BYTES = 32;
const HKDF_INFO = utf8.encode('kindminds-mesh-v1');

export type Identity = {
  /** 8-byte public identifier: the first 8 bytes of SHA-256 of the signing key. */
  peerId: string;
  signSecretKey: Uint8Array;
  signPublicKey: Uint8Array;
  boxSecretKey: Uint8Array;
  boxPublicKey: Uint8Array;
  createdAt: number;
};

/** The only material that ever touches disk. */
export type IdentitySecret = {
  signSecretKey: string;
  boxSecretKey: string;
  createdAt: number;
};

const ED_SEED_BYTES = 32;

function requireLength(value: Uint8Array, length: number, label: string): Uint8Array {
  if (value.length !== length) throw new Error(`${label} must be ${length} bytes`);
  return value;
}

/** Stable, collision-resistant short id derived from a signing public key. */
export function peerIdFromPublicKey(signPublicKey: Uint8Array): string {
  return bytesToHex(sha256(signPublicKey).subarray(0, 8));
}

export function generateIdentity(random: RandomSource, now = Date.now()): Identity {
  const signSeed = requireLength(random(ED_SEED_BYTES), ED_SEED_BYTES, 'seed');
  const boxSeed = requireLength(random(ED_SEED_BYTES), ED_SEED_BYTES, 'seed');
  const signPublicKey = ed25519.getPublicKey(signSeed);
  const boxPublicKey = x25519.getPublicKey(boxSeed);
  return {
    peerId: peerIdFromPublicKey(signPublicKey),
    signSecretKey: signSeed,
    signPublicKey,
    boxSecretKey: boxSeed,
    boxPublicKey,
    createdAt: now,
  };
}

/** Rebuild an identity from stored secrets; used on every cold start. */
export function restoreIdentity(secret: IdentitySecret): Identity {
  const signSecretKey = requireLength(hexToBytes(secret.signSecretKey), ED_SEED_BYTES, 'signing key');
  const boxSecretKey = requireLength(hexToBytes(secret.boxSecretKey), ED_SEED_BYTES, 'box key');
  const signPublicKey = ed25519.getPublicKey(signSecretKey);
  return {
    peerId: peerIdFromPublicKey(signPublicKey),
    signSecretKey,
    signPublicKey,
    boxSecretKey,
    boxPublicKey: x25519.getPublicKey(boxSecretKey),
    createdAt: secret.createdAt,
  };
}

export function revealSecret(identity: Identity): IdentitySecret {
  return {
    signSecretKey: bytesToHex(identity.signSecretKey),
    boxSecretKey: bytesToHex(identity.boxSecretKey),
    createdAt: identity.createdAt,
  };
}

/**
 * X25519 agreement salted with both peer ids, so a pair of devices derives the
 * same key in both directions and two different pairs never collide.
 */
export function deriveSharedKey(
  self: { boxSecretKey: Uint8Array; peerId: string },
  peer: { boxPublicKey: Uint8Array; peerId: string },
): Uint8Array {
  const raw = x25519.getSharedSecret(self.boxSecretKey, peer.boxPublicKey);
  const salt = utf8.encode([self.peerId, peer.peerId].sort().join(':'));
  return hkdf(sha256, raw, salt, HKDF_INFO, KEY_BYTES);
}

export type SealedPayload = { nonce: Uint8Array; ciphertext: Uint8Array };

/** XChaCha20-Poly1305 with the packet header bound as associated data. */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
  random: RandomSource,
): SealedPayload {
  requireLength(key, KEY_BYTES, 'mesh key');
  const nonce = requireLength(random(NONCE_BYTES), NONCE_BYTES, 'nonce');
  return { nonce, ciphertext: xchacha20poly1305(key, nonce, associatedData).encrypt(plaintext) };
}

/** Returns null on tampering or a wrong key rather than throwing mid-routing. */
export function open(
  key: Uint8Array,
  sealed: SealedPayload,
  associatedData: Uint8Array,
): Uint8Array | null {
  if (key.length !== KEY_BYTES || sealed.nonce.length !== NONCE_BYTES) return null;
  try {
    return xchacha20poly1305(key, sealed.nonce, associatedData).decrypt(sealed.ciphertext);
  } catch {
    return null;
  }
}

export function sign(identity: Identity, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, identity.signSecretKey);
}

export function verify(
  signPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return ed25519.verify(signature, message, signPublicKey);
  } catch {
    return false;
  }
}

/** The exact bytes a sender signs: their id length-prefixed ahead of the payload. */
export function signedMessage(senderId: string, payload: Uint8Array): Uint8Array {
  return concatBytes(utf8.encode(senderId), payload);
}

/**
 * Human-readable safety number for out-of-band verification. Two users read it
 * aloud once; a machine in the middle would produce different digits.
 */
export function safetyNumber(a: Uint8Array, b: Uint8Array): string {
  const digest = sha256(concatBytes(a, b));
  const groups: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const value = ((digest[i * 4] ?? 0) << 24) | ((digest[i * 4 + 1] ?? 0) << 16) |
      ((digest[i * 4 + 2] ?? 0) << 8) | (digest[i * 4 + 3] ?? 0);
    groups.push((value % 100_000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

export function keysMatch(a: Uint8Array, b: Uint8Array): boolean {
  return constantTimeEqual(a, b);
}
