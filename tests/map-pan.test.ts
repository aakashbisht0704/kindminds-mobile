import { describe, expect, test } from 'bun:test';

import { shiftCenter } from '../src/core/map-pan';

const start = { lat: 37.422, lon: -122.084 };

describe('map pan direction', () => {
  test('dragging down moves the view north/up', () => {
    expect(shiftCenter(start, 12, 0, 120).lat).toBeGreaterThan(start.lat);
  });

  test('dragging up moves the view south/down', () => {
    expect(shiftCenter(start, 12, 0, -120).lat).toBeLessThan(start.lat);
  });

  test('dragging right moves the view west', () => {
    expect(shiftCenter(start, 12, 120, 0).lon).toBeLessThan(start.lon);
  });

  test('dragging left moves the view east', () => {
    expect(shiftCenter(start, 12, -120, 0).lon).toBeGreaterThan(start.lon);
  });
});
