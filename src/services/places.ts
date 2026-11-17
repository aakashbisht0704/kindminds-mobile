/**
 * Search and directions with an offline-first split.
 *
 * Offline results come from this phone: the current fix, Bluetooth peers, SOS
 * alerts, the installed map centre, and typed coordinates. Address search and
 * road routing use OpenStreetMap services only when the user starts a network
 * request; both fall back cleanly without one.
 */

import { distanceMeters, formatCoordinate, formatDistance, initialBearingDeg, type LatLon } from '../core/geo';
import { clampZoom, TILE_SIZE } from '../core/tiles';
import type { Peer } from '../core/mesh/engine';

export type PlaceSource = 'self' | 'peer' | 'sos' | 'map' | 'coordinate' | 'online';

export type PlaceResult = {
  id: string;
  name: string;
  subtitle: string;
  point: LatLon;
  source: PlaceSource;
};

export type OfflinePlaceInput = {
  self: LatLon | null;
  peers: readonly Pick<Peer, 'peerId' | 'callsign' | 'lastKnown' | 'status'>[];
  alerts: readonly {
    messageId: string;
    senderCallsign: string;
    payload: { lat: number; lon: number };
  }[];
  packCenter: LatLon | null;
  packName?: string | null;
};

const COORDINATE_RE =
  /^\s*(-?\d{1,2}(?:\.\d+)?)\s*(?:,|\s)\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Parse "37.422, -122.084" or "37.422 -122.084". */
export function parseCoordinateQuery(query: string): LatLon | null {
  const match = COORDINATE_RE.exec(query);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function nearbySubtitle(self: LatLon | null, point: LatLon): string {
  return self ? `${formatDistance(distanceMeters(self, point))} away` : formatCoordinate(point);
}

/** Everything searchable without a network. */
export function offlinePlaces(query: string, input: OfflinePlaceInput): PlaceResult[] {
  const self = input.self;
  const places: PlaceResult[] = [];

  if (self) {
    places.push({
      id: 'self',
      name: 'My location',
      subtitle: formatCoordinate(self),
      point: self,
      source: 'self',
    });
  }

  for (const peer of input.peers) {
    if (!peer.lastKnown) continue;
    places.push({
      id: `peer:${peer.peerId}`,
      name: peer.callsign,
      subtitle: `Bluetooth peer · ${peer.status} · ${nearbySubtitle(self, peer.lastKnown)}`,
      point: peer.lastKnown,
      source: 'peer',
    });
  }

  for (const alert of input.alerts) {
    if (alert.payload.lat === 0 && alert.payload.lon === 0) continue;
    const point = { lat: alert.payload.lat, lon: alert.payload.lon };
    places.push({
      id: `sos:${alert.messageId}`,
      name: `SOS · ${alert.senderCallsign}`,
      subtitle: `Open alert · ${nearbySubtitle(self, point)}`,
      point,
      source: 'sos',
    });
  }

  if (input.packCenter) {
    places.push({
      id: 'map-center',
      name: input.packName ?? 'Offline map centre',
      subtitle: 'Centre of the installed map',
      point: input.packCenter,
      source: 'map',
    });
  }

  const coordinate = parseCoordinateQuery(query);
  if (coordinate) {
    places.unshift({
      id: 'coordinate',
      name: 'Dropped pin',
      subtitle: `${formatCoordinate(coordinate)} · ${nearbySubtitle(self, coordinate)}`,
      point: coordinate,
      source: 'coordinate',
    });
  }

  const needle = query.trim().toLowerCase();
  if (!needle) return places.slice(0, 10);
  const coordinatePlaces = places.filter((place) => place.source === 'coordinate');
  const named = places.filter(
    (place) => place.source !== 'coordinate' && place.name.toLowerCase().includes(needle),
  );
  return [...coordinatePlaces, ...named].slice(0, 10);
}

const USER_AGENT = 'KindMinds/0.1 (offline disaster kit; user-initiated place search)';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Address/place search when online. Failures are deliberately silent. */
export async function searchOnlinePlaces(query: string): Promise<PlaceResult[]> {
  const text = query.trim();
  if (text.length < 2 || parseCoordinateQuery(text)) return [];
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(text)}`;
  try {
    const response = await fetchWithTimeout(url, 6_000);
    if (!response.ok) return [];
    const rows = (await response.json()) as Array<{
      place_id?: number;
      lat?: string;
      lon?: string;
      name?: string;
      display_name?: string;
    }>;
    return rows.flatMap((row, index): PlaceResult[] => {
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
      const name = row.name?.trim() || row.display_name?.split(',')[0]?.trim() || 'Place';
      return [
        {
          id: `osm:${row.place_id ?? `${lat},${lon},${index}`}`,
          name,
          subtitle: row.display_name ?? formatCoordinate({ lat, lon }),
          point: { lat, lon },
          source: 'online',
        },
      ];
    });
  } catch {
    return [];
  }
}

export type RouteMode = 'road' | 'direct';

export type RouteResult = {
  points: LatLon[];
  distanceM: number;
  durationS: number | null;
  mode: RouteMode;
};

/** Straight-line fallback that always works offline. */
export function directRoute(from: LatLon, to: LatLon): RouteResult {
  return {
    points: [from, to],
    distanceM: distanceMeters(from, to),
    durationS: null,
    mode: 'direct',
  };
}

/** Road route when online, direct line otherwise. */
export async function fetchRoute(from: LatLon, to: LatLon): Promise<RouteResult> {
  const url = `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  try {
    const response = await fetchWithTimeout(url, 7_000);
    if (!response.ok) return directRoute(from, to);
    const data = (await response.json()) as {
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    };
    const best = data.routes?.[0];
    const coordinates = best?.geometry?.coordinates;
    if (
      !best ||
      !Number.isFinite(best.distance) ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2
    ) {
      return directRoute(from, to);
    }
    return {
      points: coordinates.map(([lon, lat]) => ({ lat, lon })),
      distanceM: best.distance ?? distanceMeters(from, to),
      durationS: Number.isFinite(best.duration) ? (best.duration ?? null) : null,
      mode: 'road',
    };
  } catch {
    return directRoute(from, to);
  }
}

export function routeHeadline(route: RouteResult): string {
  const duration =
    route.durationS === null
      ? null
      : route.durationS < 3600
        ? `${Math.max(1, Math.round(route.durationS / 60))} min`
        : `${Math.floor(route.durationS / 3600)} h ${Math.round((route.durationS % 3600) / 60)} min`;
  return `${duration ? `${duration} · ` : ''}${formatDistance(route.distanceM)} · ${
    route.mode === 'road' ? 'road route' : 'direct line'
  }`;
}

export function routeBearing(from: LatLon, to: LatLon): number {
  return initialBearingDeg(from, to);
}

/** Centre of a route, used to frame both ends after directions load. */
export function routeCenter(points: LatLon[]): LatLon | null {
  if (points.length === 0) return null;
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  for (const point of points) {
    north = Math.max(north, point.lat);
    south = Math.min(south, point.lat);
    east = Math.max(east, point.lon);
    west = Math.min(west, point.lon);
  }
  return { lat: (north + south) / 2, lon: (east + west) / 2 };
}

/** Zoom that keeps the full route above the floating card. */
export function fitRouteZoom(points: LatLon[], width: number, height: number, padding = 48): number {
  if (points.length < 2 || width <= 0 || height <= 0) return 15;
  let north = -Infinity;
  let south = Infinity;
  let east = -Infinity;
  let west = Infinity;
  for (const point of points) {
    north = Math.max(north, point.lat);
    south = Math.min(south, point.lat);
    east = Math.max(east, point.lon);
    west = Math.min(west, point.lon);
  }
  const latSpan = Math.max(0.0005, north - south);
  const lonSpan = Math.max(0.0005, east - west);
  const centerLat = (north + south) / 2;
  const usableWidth = Math.max(160, width - padding * 2);
  const usableHeight = Math.max(160, height * 0.55 - padding * 2);
  // Pixels per degree at z0, including Mercator's vertical stretch.
  const lonPerZoom = (lonSpan / 360) * TILE_SIZE;
  const latPerZoom = ((latSpan / 360) * TILE_SIZE) / Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  const fit = Math.min(usableWidth / lonPerZoom, usableHeight / latPerZoom);
  return clampZoom(Math.floor(Math.log2(Math.max(1, fit))));
}
