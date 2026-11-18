/**
 * First-launch downloads.
 *
 * Models are large, so they are downloaded once during onboarding and kept in
 * the app's private storage. The text model is 986,048,768 bytes: a phone on a mobile connection
 * will lose the socket at least once on the way, so the downloader keeps the
 * partial file, asks the server for the rest with an HTTP Range request, and
 * only swaps the result into place when the file is complete. An interrupted
 * install therefore costs a few seconds, not the whole download, and never
 * destroys a model that was already working.
 */

import { File, Paths } from 'expo-file-system';
import { fetch as streamingFetch } from 'expo/fetch';
import { sha256 } from '@noble/hashes/sha256';

import { modelFile, registerModel, type ModelKind } from './model-pack';
import { TEXT_MODEL, VISION_MODEL, VOICE_MODEL } from '../core/ai/model-facts';

const USER_AGENT = 'KindMinds/0.1 (offline disaster kit; on-device models)';

/** Room for the manifest, the map pack, and ordinary app writes. */
const DISK_MARGIN_BYTES = 96 * 1024 * 1024;

/** A dropped connection is retried in place; the partial file is reused. */
const MAX_ATTEMPTS = 3;

const RETRY_DELAY_MS = 1_500;

export type Progress = (fraction: number) => void;

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Errors that no number of retries will fix. */
function isFatal(error: unknown): boolean {
  const message = rawMessage(error).toLowerCase();
  return (
    message.includes('no space left') ||
    message.includes('enospc') ||
    message.includes('out of space') ||
    message.includes('http 4') ||
    message.includes('permission denied')
  );
}

/**
 * One sentence a frightened person can act on. The native layer reports
 * `java.net.SocketException: Software caused connection abort`, which is not
 * something to show in the UI.
 */
export function describeDownloadError(error: unknown, savedBytes = 0, expectedBytes = 0): string {
  const message = rawMessage(error);
  const lower = message.toLowerCase();
  const saved = savedBytes > 0 ? megabytes(savedBytes) : 0;
  const keep =
    saved > 0 ? ` ${saved} MB are already saved; tap Download again to continue from there.` : '';
  const total = expectedBytes > 0 ? `${megabytes(expectedBytes)} MB` : 'the model';

  if (lower.includes('no space') || lower.includes('enospc') || lower.includes('out of space')) {
    return 'The phone ran out of free space. Free up about 1.7 GB and tap Download again.';
  }
  if (lower.includes('http 4') || lower.includes('http 5') || lower.includes('server returned')) {
    return `The model server could not send the file (${message}). Try again later.${keep}`;
  }
  if (
    lower.includes('unknownhost') ||
    lower.includes('unable to resolve') ||
    lower.includes('network') ||
    lower.includes('socket') ||
    lower.includes('timeout') ||
    lower.includes('connection') ||
    lower.includes('closed') ||
    lower.includes('fetch failed') ||
    lower.includes('stopped early') ||
    lower.includes('unexpected end')
  ) {
    return (
      `The connection dropped before the ${total} model finished downloading.` +
      (keep || ' Tap Download again to retry.')
    );
  }
  const detail = message.length > 0 ? `${message.replace(/\.$/, '')}.` : '';
  return `The download did not finish.${detail ? ` ${detail}` : ''}${keep || ' Tap Download again to retry.'}`;
}

function finish(partial: File, destination: File, onProgress?: Progress): File {
  if (destination.exists) destination.delete();
  partial.move(destination);
  onProgress?.(1);
  return destination;
}

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type VerifyProgress = (fraction: number) => void;

/**
 * SHA-256 of a downloaded file.
 *
 * Hash in 4 MB chunks so a 500 MB model never sits in memory at once, and yield
 * to the event loop between chunks: Hermes hashes slowly, and a synchronous
 * loop here froze the UI for minutes on the emulator. The expected digest comes
 * from the publisher's own `SHA256SUMS` file on Hugging Face; it is never
 * computed from the download it is supposed to vouch for.
 */
export async function fileSha256(file: File, onProgress?: VerifyProgress): Promise<string> {
  const total = file.size ?? 0;
  const handle = file.open();
  const hash = sha256.create();
  let read = 0;
  let ticks = 0;
  try {
    handle.offset = 0;
    for (;;) {
      const chunk = handle.readBytes(HASH_CHUNK_BYTES);
      if (chunk.length === 0) break;
      hash.update(chunk);
      read += chunk.length;
      if (total > 0) onProgress?.(Math.min(0.99, read / total));
      ticks += 1;
      if (ticks % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      if (chunk.length < HASH_CHUNK_BYTES) break;
    }
  } finally {
    handle.close();
  }
  onProgress?.(1);
  return Array.from(hash.digest())
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Throws unless the file matches; a corrupt download must never be used. */
export async function verifySha256(
  file: File,
  expected: string,
  onProgress?: VerifyProgress,
): Promise<void> {
  const actual = await fileSha256(file, onProgress);
  if (actual !== expected.toLowerCase()) {
    // A mismatched file is useless and costs 500 MB; delete it so the next tap
    // starts clean instead of resuming onto corruption.
    try {
      file.delete();
    } catch {
      // A locked file is replaced by the next download attempt anyway.
    }
    throw new Error('The downloaded model failed its integrity check. Tap Download again.');
  }
}

/**
 * Stream the body into the partial file, continuing an earlier attempt when
 * the server supports `Range`. Throws on a short or refused transfer so the
 * caller can retry from the bytes already on disk.
 */
async function streamOnce(
  url: string,
  partial: File,
  expectedBytes: number | undefined,
  onProgress?: Progress,
): Promise<void> {
  let offset = partial.exists ? (partial.size ?? 0) : 0;
  if (expectedBytes && offset > expectedBytes) {
    // Left over from a different file; a Range request would be nonsense.
    partial.delete();
    offset = 0;
  }

  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const response = await streamingFetch(url, { headers });

  // A server that ignores Range answers 200 with the whole file, so the partial
  // bytes have to go; anything else keeps them.
  if (offset > 0 && response.status !== 206) {
    if (partial.exists) partial.delete();
    offset = 0;
  }
  if (!response.ok) throw new Error(`The server returned HTTP ${response.status}.`);
  if (!response.body) throw new Error('The server returned an empty response.');

  const length = Number(response.headers.get('content-length') ?? 0);
  const total = expectedBytes ?? (offset + length > offset ? offset + length : 0);

  const handle = partial.open();
  const reader = response.body.getReader();
  let written = offset;
  try {
    handle.offset = offset;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      handle.writeBytes(value);
      written += value.byteLength;
      if (total > 0) onProgress?.(Math.min(0.99, written / total));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream is already finished or broken; closing the handle is enough.
    }
    handle.close();
  }

  if (expectedBytes && written < expectedBytes) {
    throw new Error(`Download stopped early at ${megabytes(written)} MB.`);
  }
}

export async function downloadToFile(
  url: string,
  destination: File,
  onProgress?: Progress,
  expectedBytes?: number,
): Promise<File> {
  const partial = new File(`${destination.uri}.part`);
  const saved = partial.exists ? (partial.size ?? 0) : 0;

  // A previous attempt finished the transfer but died before the rename.
  if (expectedBytes && saved >= expectedBytes) {
    return finish(partial, destination, onProgress);
  }

  if (expectedBytes) {
    const needed = expectedBytes - saved + DISK_MARGIN_BYTES;
    if (Paths.availableDiskSpace > 0 && Paths.availableDiskSpace < needed) {
      throw new Error(
        `The phone needs about ${megabytes(needed)} MB of free space for this model.`,
      );
    }
    if (saved > 0) onProgress?.(Math.min(0.99, saved / expectedBytes));
  }

  let lastError: unknown = new Error('The download did not start.');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await streamOnce(url, partial, expectedBytes, onProgress);
      return finish(partial, destination, onProgress);
    } catch (error) {
      lastError = error;
      if (isFatal(error)) break;
      const held = partial.exists ? (partial.size ?? 0) : 0;
      if (expectedBytes && held >= expectedBytes) return finish(partial, destination, onProgress);
      if (attempt < MAX_ATTEMPTS) {
        if (expectedBytes && held > 0) onProgress?.(Math.min(0.99, held / expectedBytes));
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  // The partial file stays on disk on purpose: the next tap resumes from it.
  const kept = partial.exists ? (partial.size ?? 0) : 0;
  throw new Error(describeDownloadError(lastError, kept, expectedBytes ?? 0));
}

export async function downloadModel(
  kind: ModelKind,
  url: string,
  name: string,
  onProgress?: Progress,
  expectedBytes?: number,
  expectedSha256?: string,
  onVerify?: VerifyProgress,
): Promise<File> {
  const target = modelFile(name);
  const complete = target.exists && (!expectedBytes || (target.size ?? 0) >= expectedBytes * 0.9);
  const file = complete ? target : await downloadToFile(url, target, onProgress, expectedBytes);
  // The model is usable as soon as the byte count matches; the digest check runs
  // after registration so a slow phone is not stuck behind a 500 MB hash.
  registerModel(name, kind);
  if (expectedSha256) await verifySha256(file, expectedSha256, onVerify);
  return file;
}

/**
 * The download list, derived from the audited model facts so the size and
 * digest the downloader enforces are the same numbers the licence screen
 * quotes. Nothing here is a second copy.
 */
export const MODEL_URLS = {
  text: TEXT_MODEL,
  voice: VOICE_MODEL,
  vision: VISION_MODEL,
} as const;
