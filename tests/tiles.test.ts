import { describe, expect, test } from 'bun:test';

import { ancestorTile, isRasterTile } from '../src/core/tiles';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array([...values, ...Array(32).fill(0)]);
}

describe('tile validation', () => {
  test('accepts PNG magic', () => {
    expect(isRasterTile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(true);
  });

  test('accepts JPEG magic', () => {
    expect(isRasterTile(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(true);
  });

  test('accepts WebP magic', () => {
    expect(isRasterTile(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
      true,
    );
  });

  test('rejects the HTML body a blocked tile server returns', () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><title>Access blocked</title>');
    expect(isRasterTile(html)).toBe(false);
  });

  test('rejects a short/empty response', () => {
    expect(isRasterTile(new Uint8Array(0))).toBe(false);
    expect(isRasterTile(new Uint8Array(4))).toBe(false);
  });
});


describe('ancestor tiles', () => {
  test('finds the parent covering a child tile', () => {
    expect(ancestorTile({ z: 16, x: 10, y: 20 }, 15)).toEqual({ z: 15, x: 5, y: 10 });
    expect(ancestorTile({ z: 18, x: 42, y: 99 }, 12)).toEqual({ z: 12, x: 0, y: 1 });
  });

  test('keeps the tile when the requested zoom is not coarser', () => {
    expect(ancestorTile({ z: 14, x: 3, y: 4 }, 14)).toEqual({ z: 14, x: 3, y: 4 });
  });
});
