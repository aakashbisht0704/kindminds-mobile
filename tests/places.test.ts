import { describe, expect, test } from 'bun:test';

import {
  directRoute,
  fitRouteZoom,
  offlinePlaces,
  parseCoordinateQuery,
  routeCenter,
  routeHeadline,
} from '../src/services/places';

const input = {
  self: { lat: 37.422, lon: -122.084 },
  peers: [
    {
      peerId: 'p1',
      callsign: 'Ana',
      lastKnown: { lat: 37.423, lon: -122.083 },
      status: 'ok' as const,
    },
  ],
  alerts: [
    {
      messageId: 'a1',
      senderCallsign: 'Blue tent',
      payload: { lat: 37.424, lon: -122.082 },
    },
  ],
  packCenter: { lat: 37.42, lon: -122.08 },
  packName: 'Local area map',
};

describe('coordinate search', () => {
  test('parses comma and space separated coordinates', () => {
    expect(parseCoordinateQuery('37.422, -122.084')).toEqual({ lat: 37.422, lon: -122.084 });
    expect(parseCoordinateQuery('37.422 -122.084')).toEqual({ lat: 37.422, lon: -122.084 });
  });

  test('rejects out-of-range and prose queries', () => {
    expect(parseCoordinateQuery('137.4, -122')).toBeNull();
    expect(parseCoordinateQuery('Mountain View')).toBeNull();
  });
});

describe('offline place search', () => {
  test('returns nearby phone data when the query is empty', () => {
    const places = offlinePlaces('', input);
    expect(places.map((place) => place.source)).toEqual(['self', 'peer', 'sos', 'map']);
  });

  test('filters peers and SOS by name', () => {
    expect(offlinePlaces('ana', input)[0]?.source).toBe('peer');
    expect(offlinePlaces('blue', input)[0]?.source).toBe('sos');
  });

  test('puts a typed coordinate first', () => {
    const places = offlinePlaces('37.5, -122.1', input);
    expect(places[0]?.source).toBe('coordinate');
    expect(places[0]?.point).toEqual({ lat: 37.5, lon: -122.1 });
  });
});

describe('directions fallback', () => {
  test('direct route works without a network', () => {
    const route = directRoute({ lat: 37.422, lon: -122.084 }, { lat: 37.43, lon: -122.08 });
    expect(route.mode).toBe('direct');
    expect(route.points).toHaveLength(2);
    expect(route.distanceM).toBeGreaterThan(0);
    expect(routeHeadline(route)).toContain('direct line');
  });

  test('frames both ends of a route', () => {
    const points = [
      { lat: 37.42, lon: -122.09 },
      { lat: 37.45, lon: -122.05 },
    ];
    expect(routeCenter(points)).toEqual({ lat: 37.435, lon: -122.07 });
    const zoom = fitRouteZoom(points, 1080, 2200);
    expect(zoom).toBeGreaterThanOrEqual(10);
    expect(zoom).toBeLessThanOrEqual(16);
  });
});
