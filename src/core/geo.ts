/**
 * Geodesy that works with zero network access.
 *
 * Everything here is pure spherical-Earth maths: no map SDK, no tile server, no
 * reverse geocoding. A device that has never seen a signal can still answer
 * "how far is that shelter", "which way do I walk", "is this beacon inside my
 * search box".
 */

export type LatLon = { lat: number; lon: number };

export type BoundingBox = {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
};

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function toRadians(deg: number): number {
  return deg * DEG;
}

export function toDegrees(rad: number): number {
  return rad / DEG;
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function wrapLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle distance in metres (haversine, stable for short hops). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from true north. */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeDeg(toDegrees(Math.atan2(y, x)));
}

/** Point `distance` metres from `origin` along `bearingDeg`. */
export function destinationPoint(origin: LatLon, bearingDeg: number, distance: number): LatLon {
  const angular = distance / EARTH_RADIUS_M;
  const bearing = toRadians(bearingDeg);
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);
  const sinLat2 = Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * sinLat2,
    );
  return { lat: toDegrees(lat2), lon: wrapLongitude(toDegrees(lon2)) };
}

const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

export function compassPoint(bearingDeg: number): string {
  return COMPASS_16[Math.round(normalizeDeg(bearingDeg) / 22.5) % 16] ?? 'N';
}

/** Square search box around a point, corrected for latitude compression. */
export function bboxAround(center: LatLon, radiusMeters: number): BoundingBox {
  const latDelta = toDegrees(radiusMeters / EARTH_RADIUS_M);
  const cosLat = Math.cos(toRadians(center.lat));
  const lonDelta = Math.abs(cosLat) < 1e-6 ? 180 : toDegrees(radiusMeters / (EARTH_RADIUS_M * cosLat));
  return {
    minLat: Math.max(-90, center.lat - latDelta),
    maxLat: Math.min(90, center.lat + latDelta),
    minLon: wrapLongitude(center.lon - lonDelta),
    maxLon: wrapLongitude(center.lon + lonDelta),
  };
}

export function isInsideBbox(point: LatLon, box: BoundingBox): boolean {
  if (point.lat < box.minLat || point.lat > box.maxLat) return false;
  // A box wrapping the antimeridian has minLon > maxLon.
  if (box.minLon > box.maxLon) return point.lon >= box.minLon || point.lon <= box.maxLon;
  return point.lon >= box.minLon && point.lon <= box.maxLon;
}

const wholeMetres = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Human turn-by-turn scale: metres under 1 km, kilometres above. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  if (meters < 1000) return `${wholeMetres.format(meters)} m`;
  if (meters < 10_000) return `${oneDecimal.format(meters / 1000)} km`;
  return `${wholeMetres.format(meters / 1000)} km`;
}

/** Walk time at a conservative disaster pace of 3 km/h over broken ground. */
export function estimateWalkMinutes(meters: number): number {
  if (!Number.isFinite(meters) || meters <= 0) return 1;
  return Math.max(1, Math.round((meters / 1000 / 3) * 60));
}

const coordFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 5,
  maximumFractionDigits: 5,
});

/** Coordinates a person can read aloud to a rescuer over a radio. */
export function formatCoordinate(point: LatLon): string {
  const lat = `${coordFormat.format(Math.abs(point.lat))}${point.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${coordFormat.format(Math.abs(point.lon))}${point.lon >= 0 ? 'E' : 'W'}`;
  return `${lat} ${lon}`;
}

export type Fix = {
  point: LatLon;
  accuracyM: number | null;
  timestamp: number;
};

/**
 * Blend a new GPS fix into a running estimate weighted by reported accuracy.
 * Handset GPS wanders by tens of metres in rubble and under tree cover, so the
 * raw fix is never shown as "your position" on its own.
 */
export function smoothFix(previous: LatLon | null, next: Fix): LatLon {
  if (!previous) return next.point;
  const accuracy = next.accuracyM ?? 50;
  // ponytail: single-pole alpha filter; swap for a Kalman filter only if field jitter proves it necessary.
  const weight = Math.min(0.9, Math.max(0.2, 30 / Math.max(accuracy, 1)));
  return {
    lat: previous.lat + (next.point.lat - previous.lat) * weight,
    lon: previous.lon + (next.point.lon - previous.lon) * weight,
  };
}
