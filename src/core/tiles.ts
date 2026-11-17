/**
 * Slippy-map tile maths for a map that never phones home.
 *
 * Tiles come from a region pack the user downloads *before* a disaster (an
 * MBTiles SQLite file) and live on the device. This module only decides which
 * z/x/y indices a viewport needs and how they map to MBTiles' TMS row order, so
 * the renderer stays dumb and testable off-device.
 */

import type { LatLon } from './geo';
import { toDegrees, toRadians, wrapLongitude } from './geo';

export const TILE_SIZE = 256;
export const MAX_ZOOM = 22;

export type TileRef = { z: number; x: number; y: number };

/** Reject an HTML/403 error page that a tile server returned as a "tile". */
export function isRasterTile(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const webp =
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return png || jpeg || webp;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(0, Math.round(z)));
}

export function tilesPerAxis(z: number): number {
  return 2 ** clampZoom(z);
}

export function lonToTileX(lon: number, z: number): number {
  const n = tilesPerAxis(z);
  return Math.min(n - 1, Math.floor(((wrapLongitude(lon) + 180) / 360) * n));
}

/** Mercator row for a latitude, clamped to the projection's ±85.0511° limit. */
export function latToTileY(lat: number, z: number): number {
  const n = tilesPerAxis(z);
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat));
  const mercator = Math.log(Math.tan(Math.PI / 4 + toRadians(clamped) / 2));
  return Math.min(n - 1, Math.max(0, Math.floor(((1 - mercator / Math.PI) / 2) * n)));
}

export function tileForPoint(point: LatLon, z: number): TileRef {
  return { z: clampZoom(z), x: lonToTileX(point.lon, z), y: latToTileY(point.lat, z) };
}

export type TileBounds = { north: number; south: number; west: number; east: number };

export function tileBounds(tile: TileRef): TileBounds {
  const n = tilesPerAxis(tile.z);
  return {
    west: (tile.x / n) * 360 - 180,
    east: ((tile.x + 1) / n) * 360 - 180,
    north: toDegrees(Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n)))),
    south: toDegrees(Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / n)))),
  };
}

/** MBTiles stores rows bottom-up (TMS) while a map view is top-down. */
export function toTmsY(y: number, z: number): number {
  return tilesPerAxis(z) - 1 - y;
}

export function tileKey(tile: TileRef): string {
  return `${tile.z}/${tile.x}/${tile.y}`;
}

/** Parent tile covering `tile` at a coarser zoom. */
export function ancestorTile(tile: TileRef, zoom: number): TileRef {
  const z = clampZoom(zoom);
  if (z >= tile.z) return { ...tile, z };
  const scale = 2 ** (tile.z - z);
  return { z, x: Math.floor(tile.x / scale), y: Math.floor(tile.y / scale) };
}

export function metersPerPixel(lat: number, z: number): number {
  return (156_543.033_92 * Math.cos(toRadians(lat))) / tilesPerAxis(z);
}

export function metersPerTile(lat: number, z: number): number {
  return metersPerPixel(lat, z) * TILE_SIZE;
}

/**
 * Finest zoom that still shows at least `minMetersPerTile` of ground per tile,
 * capped by whatever the installed region pack actually contains.
 */
export function chooseZoom(lat: number, minMetersPerTile: number, availableMaxZoom: number): number {
  const cap = clampZoom(availableMaxZoom);
  for (let z = cap; z > 0; z -= 1) {
    if (metersPerTile(lat, z) >= minMetersPerTile) return z;
  }
  return 0;
}

/**
 * Tiles covering a viewport centred on `center`, capped at `maxTiles` so a
 * zoomed-out request can never ask a cheap handset for hundreds of bitmaps.
 */
export function visibleTiles(
  center: LatLon,
  zoom: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
  maxTiles = 48,
): TileRef[] {
  const z = clampZoom(zoom);
  const n = tilesPerAxis(z);
  const centerX = ((wrapLongitude(center.lon) + 180) / 360) * n;
  const mercator = Math.log(Math.tan(Math.PI / 4 + toRadians(center.lat) / 2));
  const centerY = ((1 - mercator / Math.PI) / 2) * n;

  const halfW = viewportWidthPx / 2 / TILE_SIZE;
  const halfH = viewportHeightPx / 2 / TILE_SIZE;
  const minX = Math.floor(centerX - halfW);
  const maxX = Math.floor(centerX + halfW);
  const minY = Math.max(0, Math.floor(centerY - halfH));
  const maxY = Math.min(n - 1, Math.floor(centerY + halfH));

  const tiles: TileRef[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (tiles.length >= maxTiles) return tiles;
      // Wrap across the antimeridian rather than dropping the column.
      tiles.push({ z, x: ((x % n) + n) % n, y });
    }
  }
  return tiles;
}

/** Screen position of a point inside a viewport, in logical pixels. */
export function projectToViewport(
  point: LatLon,
  center: LatLon,
  zoom: number,
  viewportWidthPx: number,
  viewportHeightPx: number,
): { x: number; y: number } {
  const z = clampZoom(zoom);
  const scale = tilesPerAxis(z) * TILE_SIZE;
  const project = (p: LatLon) => ({
    x: ((wrapLongitude(p.lon) + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(Math.PI / 4 + toRadians(p.lat) / 2)) / Math.PI) / 2) * scale,
  });
  const projectedPoint = project(point);
  const projectedCenter = project(center);
  return {
    x: viewportWidthPx / 2 + (projectedPoint.x - projectedCenter.x),
    y: viewportHeightPx / 2 + (projectedPoint.y - projectedCenter.y),
  };
}
