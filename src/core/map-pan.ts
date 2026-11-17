/** Screen-space drag → new map centre, in Web Mercator. */
import type { LatLon } from './geo';

export function shiftCenter(center: LatLon, zoom: number, dx: number, dy: number): LatLon {
  const world = 256 * 2 ** zoom;
  const lon = center.lon - (dx / world) * 360;
  const latRad = (center.lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  // Drag down (positive dy) moves the view north/up, so the content follows
  // the finger downwards. The inverse for an upward drag.
  const nextY = y - dy / world;
  const lat =
    (2 * Math.atan(Math.exp((1 - 2 * nextY) * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return {
    lat: Math.max(-85, Math.min(85, lat)),
    lon: ((lon + 540) % 360) - 180,
  };
}
