/**
 * Byte + base64 helpers.
 *
 * Hermes ships no `Buffer` and no dependable `atob`/`btoa`, and a BLE
 * characteristic write wants base64, so this stays a small explicit
 * implementation rather than a dependency.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP: ReadonlyMap<string, number> = (() => {
  const table = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i += 1) table.set(ALPHABET[i] as string, i);
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = LOOKUP.get(clean[i] ?? '') ?? 0;
    const c1 = LOOKUP.get(clean[i + 1] ?? '') ?? 0;
    const c2 = LOOKUP.get(clean[i + 2] ?? '') ?? 0;
    const c3 = LOOKUP.get(clean[i + 3] ?? '') ?? 0;
    out[outIndex++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < clean.length) out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 < clean.length) out[outIndex++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, outIndex);
}

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 0x0f);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export const utf8 = {
  encode(input: string): Uint8Array {
    const out: number[] = [];
    for (const char of input) {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        out.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f),
        );
      }
    }
    return new Uint8Array(out);
  },
  decode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; ) {
      const first = bytes[i] ?? 0;
      const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
      const slice = bytes.subarray(i, i + length);
      if (length === 1) out += String.fromCodePoint(slice[0] ?? 0);
      else if (length === 2) {
        out += String.fromCodePoint(((slice[0] ?? 0) & 0x1f) << 6 | ((slice[1] ?? 0) & 0x3f));
      } else if (length === 3) {
        out += String.fromCodePoint(
          ((slice[0] ?? 0) & 0x0f) << 12 | ((slice[1] ?? 0) & 0x3f) << 6 | ((slice[2] ?? 0) & 0x3f),
        );
      } else {
        out += String.fromCodePoint(
          ((slice[0] ?? 0) & 0x07) << 18 |
            ((slice[1] ?? 0) & 0x3f) << 12 |
            ((slice[2] ?? 0) & 0x3f) << 6 |
            ((slice[3] ?? 0) & 0x3f),
        );
      }
      i += length;
    }
    return out;
  },
};

export type RandomSource = (length: number) => Uint8Array;

/**
 * Crypto-strength bytes when the runtime exposes WebCrypto, with an explicit
 * fallback so SOS sending still functions if the polyfill is absent.
 * Install `react-native-get-random-values` in release builds to guarantee the
 * strong path on device.
 */
export function systemRandom(length: number): Uint8Array {
  const webCrypto = (globalThis as {
    crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
  }).crypto;
  const out = new Uint8Array(length);
  if (webCrypto?.getRandomValues) return webCrypto.getRandomValues(out);
  for (let i = 0; i < length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}
