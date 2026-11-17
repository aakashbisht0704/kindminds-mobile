/**
 * Build a small, useful offline map for the place the user is in.
 *
 * We download a bounded raster tile pyramid around the current fix (z8–z12 by
 * default, plus street-level z13–z16 close to the fix) and write it into a
 * standard MBTiles file.
 * The map screen already reads MBTiles, so no new renderer is needed.
 *
 * Production deployments should point TILE_URL at an authorised/self-hosted
 * tile server. The default is Esri's World Street Map (attribution required),
 * used with a small one-time budget. Never point this at OSM's public tile
 * endpoint: it returns 403 pages that would otherwise be stored as tiles.
 */

import * as SQLite from 'expo-sqlite';
import { File } from 'expo-file-system';

import {
  clearTileCache,
  closePack,
  ensurePackDirectory,
  inspectPack,
  packDirectory,
  type MapPack,
} from './tile-pack';
import type { LatLon } from '../core/geo';
import { isRasterTile, toTmsY } from '../core/tiles';

export const TILE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const TILE_ATTRIBUTION = '© Esri, HERE, Garmin, OpenStreetMap contributors';
const TILE_SOURCE = 'esri-world-street-v5';
const USER_AGENT = 'KindMinds/0.1 (offline disaster kit; first-run map setup)';

export type RegionBbox = { north: number; south: number; east: number; west: number };

export type RegionPackOptions = {
  center?: LatLon | null;
  name?: string;
  minZoom?: number;
  maxZoom?: number;
  maxTiles?: number;
  /** Context radius around the fix, in degrees. */
  radiusDeg?: number;
  /** Street-level detail radius around the fix, in degrees. */
  detailRadiusDeg?: number;
  /** Highest street-level zoom to try; overzoom handles beyond this. */
  detailMaxZoom?: number;
  tileUrl?: string;
  onProgress?: (fraction: number, detail: string) => void;
  signal?: AbortSignal;
};

function bboxAround(point: LatLon, radiusDeg = 0.5): RegionBbox {
  return {
    north: Math.min(85, point.lat + radiusDeg),
    south: Math.max(-85, point.lat - radiusDeg),
    east: Math.min(180, point.lon + radiusDeg),
    west: Math.max(-180, point.lon - radiusDeg),
  };
}

function worldBbox(): RegionBbox {
  return { north: 85, south: -85, east: 180, west: -180 };
}

function boundsContain(
  bounds: MapPack['bounds'],
  point: LatLon,
  marginDeg = 0.02,
): boolean {
  if (!bounds) return false;
  return (
    point.lat <= bounds.north + marginDeg &&
    point.lat >= bounds.south - marginDeg &&
    point.lon <= bounds.east + marginDeg &&
    point.lon >= bounds.west - marginDeg
  );
}

function lonToTile(lon: number, zoom: number): number {
  const n = 2 ** zoom;
  return Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
}

function latToTile(lat: number, zoom: number): number {
  const n = 2 ** zoom;
  const rad = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  const value = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return Math.max(0, Math.min(n - 1, value));
}

function tileRange(bbox: RegionBbox, zoom: number) {
  return {
    minX: lonToTile(bbox.west, zoom),
    maxX: lonToTile(bbox.east, zoom),
    minY: latToTile(bbox.north, zoom),
    maxY: latToTile(bbox.south, zoom),
  };
}

function countTiles(bbox: RegionBbox, minZoom: number, maxZoom: number): number {
  let total = 0;
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const range = tileRange(bbox, zoom);
    total += (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
  }
  return total;
}

function databaseDirectory(): string {
  return packDirectory().uri.replace(/^file:\/\//, '');
}

export async function downloadRegionPack(options: RegionPackOptions = {}): Promise<MapPack | null> {
  ensurePackDirectory();
  const requestedMin = options.minZoom ?? 8;
  const requestedMax = options.maxZoom ?? 15;
  const maxTiles = options.maxTiles ?? 700;
  const bbox = options.center
    ? bboxAround(options.center, options.radiusDeg ?? 0.5)
    : worldBbox();
  const detailBbox = options.center
    ? bboxAround(options.center, options.detailRadiusDeg ?? 0.02)
    : null;
  const baseName = options.name ?? (options.center ? 'Local area map' : 'World overview map');
  const tileUrl = options.tileUrl ?? TILE_URL;

  // Keep the broad context pyramid shallow; spend the remaining tile budget on
  // street-level detail close to the user. This is what makes deep zoom useful
  // instead of a 64x blur of a z12 tile.
  let minZoom = requestedMin;
  let baseMaxZoom = Math.min(requestedMax, 12);
  const detailMinZoom = Math.max(minZoom, 13);
  let detailMaxZoom = detailBbox ? Math.min(requestedMax, options.detailMaxZoom ?? 15) : 0;
  if (!options.center) {
    minZoom = 0;
    baseMaxZoom = 4;
    detailMaxZoom = 0;
  }

  const detailCount = () =>
    detailBbox && detailMaxZoom >= detailMinZoom
      ? countTiles(detailBbox, detailMinZoom, detailMaxZoom)
      : 0;
  const totalCount = () => countTiles(bbox, minZoom, baseMaxZoom) + detailCount();
  while (totalCount() > maxTiles && detailBbox && detailMaxZoom >= detailMinZoom) {
    detailMaxZoom -= 1;
  }
  while (totalCount() > maxTiles && baseMaxZoom > minZoom) {
    baseMaxZoom -= 1;
  }
  const maxZoom = Math.max(baseMaxZoom, detailMaxZoom);

  // Remove partial packs from interrupted setups. The final pack uses a stable
  // name and is replaced atomically, so it is never touched here.
  for (const entry of packDirectory().list()) {
    if (entry instanceof File && entry.name.startsWith('local-area-') && entry.name.endsWith('.mbtiles')) {
      try {
        entry.delete();
      } catch {
        // best-effort cleanup
      }
    }
  }

  const finalName = options.center ? 'local-area.mbtiles' : 'world-overview.mbtiles';
  const finalTarget = new File(packDirectory(), finalName);
  if (finalTarget.exists) {
    const existing =
      (finalTarget.size ?? 0) > 40 * 1024 ? await inspectPack(finalTarget) : null;
    if (
      existing &&
      existing.source === TILE_SOURCE &&
      (!options.center || boundsContain(existing.bounds, options.center))
    ) {
      options.onProgress?.(1, 'Already installed');
      return existing;
    }
    // Replace an old, partial, or corrupt pack before writing the new one.
    await closePack(finalTarget.uri);
    finalTarget.delete();
    clearTileCache();
  }

  const fileName = `${finalName.replace('.mbtiles', '')}-${Date.now()}.mbtiles.part`;
  const target = new File(packDirectory(), fileName);
  if (target.exists) target.delete();

  const db = await SQLite.openDatabaseAsync(fileName, {}, databaseDirectory());
  // MBTiles is a portable single file. WAL sidecars would be left behind by the
  // atomic rename, so force a rollback journal before writing any tiles.
  await db.execAsync('PRAGMA journal_mode = DELETE;');
  const tiles: { z: number; x: number; y: number }[] = [];
  const addTiles = (area: RegionBbox, from: number, to: number) => {
    for (let zoom = from; zoom <= to; zoom += 1) {
      const range = tileRange(area, zoom);
      for (let x = range.minX; x <= range.maxX; x += 1) {
        for (let y = range.minY; y <= range.maxY; y += 1) {
          tiles.push({ z: zoom, x, y });
        }
      }
    }
  };
  addTiles(bbox, minZoom, baseMaxZoom);
  if (detailBbox && detailMaxZoom >= detailMinZoom) {
    addTiles(detailBbox, detailMinZoom, detailMaxZoom);
  }

  try {
    await db.execAsync(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    `);

    const bounds = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
    await db.execAsync('BEGIN');
    for (const [name, value] of [
      ['name', baseName],
      ['format', 'jpg'],
      ['minzoom', String(minZoom)],
      ['maxzoom', String(maxZoom)],
      ['bounds', bounds],
      ['type', 'baselayer'],
      ['version', '1'],
      ['source', TILE_SOURCE],
      ['attribution', TILE_ATTRIBUTION],
    ] as const) {
      await db.runAsync('INSERT INTO metadata (name, value) VALUES (?, ?)', name, value);
    }
    await db.execAsync('COMMIT');

    let written = 0;
    let inserted = 0;
    for (const tile of tiles) {
      if (options.signal?.aborted) throw new Error('cancelled');
      const url = tileUrl
        .replace('{z}', String(tile.z))
        .replace('{x}', String(tile.x))
        .replace('{y}', String(tile.y));
      try {
        const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
        if (response.ok && contentType.startsWith('image/')) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (isRasterTile(bytes)) {
            const tmsY = 2 ** tile.z - 1 - tile.y;
            await db.runAsync(
              'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
              tile.z,
              tile.x,
              tmsY,
              bytes,
            );
            inserted += 1;
          }
        }
      } catch {
        // A missing tile is a gap, not a failed pack.
      }
      written += 1;
      options.onProgress?.(written / Math.max(1, tiles.length), `${written}/${tiles.length} tiles`);
      // Be polite to the tile server; the pack is a one-time setup download.
      if (written % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 120));
    }

    if (inserted === 0) {
      await db.closeAsync().catch(() => {});
      target.delete();
      return null;
    }
    // VACUUM INTO writes a fresh single-file database. This avoids losing
    // inserts that still live in a -wal sidecar when the file is renamed.
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => {});
    const finalPath = finalTarget.uri.replace(/^file:\/\//, '');
    const escaped = finalPath.replace(/'/g, "''");
    await db.execAsync(`VACUUM INTO '${escaped}'`);
    await db.closeAsync().catch(() => {});
    target.delete();
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = new File(packDirectory(), `${fileName}${suffix}`);
      if (sidecar.exists) sidecar.delete();
    }
    const pack = await inspectPack(finalTarget);
    clearTileCache();
    if (!pack) {
      finalTarget.delete();
      return null;
    }
    return pack;
  } catch {
    await db.closeAsync().catch(() => {});
    target.delete();
    return null;
  } finally {
    await db.closeAsync().catch(() => {});
  }
}

export type ExpandRegionOptions = {
  radiusDeg?: number;
  detailRadiusDeg?: number;
  detailMaxZoom?: number;
  maxTileCount?: number;
  tileUrl?: string;
  onProgress?: (fraction: number, detail: string) => void;
  signal?: AbortSignal;
};

export type RegionExpansionResult = {
  pack: MapPack | null;
  added: number;
  reason: 'expanded' | 'covered' | 'offline' | 'full' | 'failed';
};

const EXPANSION_CONTEXT_MIN = 8;
const EXPANSION_CONTEXT_MAX = 12;
const EXPANSION_DETAIL_MIN = 13;
const DEFAULT_MAX_PACK_TILES = 6_000;

function unionBounds(a: MapPack['bounds'], b: RegionBbox): RegionBbox {
  if (!a) return b;
  return {
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west),
  };
}

async function fetchTileBytes(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !contentType.startsWith('image/')) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return isRasterTile(bytes) ? bytes : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Add the tiles around a new fix to an existing pack.
 *
 * This is deliberately incremental: inside the existing context only the
 * z13–15 detail ring is added; when the user has left the context entirely a
 * fresh context ring is added too. Existing tiles are never downloaded again.
 */
export async function expandRegionPack(
  pack: MapPack,
  center: LatLon,
  options: ExpandRegionOptions = {},
): Promise<RegionExpansionResult> {
  const maxTileCount = options.maxTileCount ?? DEFAULT_MAX_PACK_TILES;
  if (pack.tileCount >= maxTileCount) return { pack, added: 0, reason: 'full' };

  const inside = boundsContain(pack.bounds, center, 0.02);
  const detailBbox = bboxAround(center, options.detailRadiusDeg ?? 0.02);
  const contextBbox = inside ? detailBbox : bboxAround(center, options.radiusDeg ?? 0.5);
  const detailMaxZoom = Math.min(15, options.detailMaxZoom ?? 15);
  const wanted = new Map<string, { z: number; x: number; y: number }>();

  const addArea = (area: RegionBbox, from: number, to: number) => {
    for (let z = from; z <= to; z += 1) {
      const range = tileRange(area, z);
      for (let x = range.minX; x <= range.maxX; x += 1) {
        for (let y = range.minY; y <= range.maxY; y += 1) {
          wanted.set(`${z}/${x}/${y}`, { z, x, y });
        }
      }
    }
  };

  if (!inside) addArea(contextBbox, EXPANSION_CONTEXT_MIN, EXPANSION_CONTEXT_MAX);
  if (detailMaxZoom >= EXPANSION_DETAIL_MIN) {
    addArea(detailBbox, EXPANSION_DETAIL_MIN, detailMaxZoom);
  }

  let db: SQLite.SQLiteDatabase | null = null;
  try {
    await closePack(pack.uri);
    const path = pack.uri.replace(/^file:\/\//, '');
    const slash = path.lastIndexOf('/');
    const directory = slash >= 0 ? path.slice(0, slash) : undefined;
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    db = await SQLite.openDatabaseAsync(name, {}, directory);
    const rows = await db.getAllAsync<{ zoom_level: number; tile_column: number; tile_row: number }>(
      'SELECT zoom_level, tile_column, tile_row FROM tiles WHERE zoom_level BETWEEN ? AND ?',
      EXPANSION_CONTEXT_MIN,
      detailMaxZoom,
    );
    const existing = new Set(rows.map((row) => `${row.zoom_level}/${row.tile_column}/${row.tile_row}`));
    const missing = [...wanted.values()].filter((tile) => !existing.has(`${tile.z}/${tile.x}/${toTmsY(tile.y, tile.z)}`));
    if (missing.length === 0) {
      await db.closeAsync().catch(() => {});
      return { pack, added: 0, reason: 'covered' };
    }
    if (pack.tileCount + missing.length > maxTileCount) {
      await db.closeAsync().catch(() => {});
      return { pack, added: 0, reason: 'full' };
    }

    const tileUrl = options.tileUrl ?? TILE_URL;
    const downloaded: Array<{ tile: { z: number; x: number; y: number }; bytes: Uint8Array }> = [];
    let consecutiveFailures = 0;
    for (let index = 0; index < missing.length; index += 1) {
      if (options.signal?.aborted) break;
      const tile = missing[index];
      if (!tile) continue;
      const url = tileUrl
        .replace('{z}', String(tile.z))
        .replace('{x}', String(tile.x))
        .replace('{y}', String(tile.y));
      const bytes = await fetchTileBytes(url, 8_000, options.signal);
      if (bytes) {
        downloaded.push({ tile, bytes });
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        // Fail fast instead of waiting eight seconds per tile on a dead link.
        if (consecutiveFailures >= 5) break;
      }
      options.onProgress?.(
        (index + 1) / Math.max(1, missing.length),
        `${index + 1}/${missing.length} new tiles`,
      );
      if ((index + 1) % 20 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }

    if (downloaded.length === 0) {
      await db.closeAsync().catch(() => {});
      return { pack, added: 0, reason: 'offline' };
    }

    await db.execAsync('PRAGMA journal_mode = DELETE;');
    await db.execAsync('BEGIN IMMEDIATE');
    for (const entry of downloaded) {
      await db.runAsync(
        'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
        entry.tile.z,
        entry.tile.x,
        toTmsY(entry.tile.y, entry.tile.z),
        entry.bytes,
      );
    }
    const bounds = unionBounds(pack.bounds, inside ? detailBbox : contextBbox);
    const maxZoom = Math.max(pack.maxZoom, ...downloaded.map((entry) => entry.tile.z));
    const minZoom = Math.min(pack.minZoom, ...downloaded.map((entry) => entry.tile.z));
    for (const [metadataName, metadataValue] of [
      ['bounds', `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`],
      ['maxzoom', String(maxZoom)],
      ['minzoom', String(minZoom)],
    ] as const) {
      await db.runAsync('DELETE FROM metadata WHERE name = ?', metadataName);
      await db.runAsync(
        'INSERT INTO metadata (name, value) VALUES (?, ?)',
        metadataName,
        metadataValue,
      );
    }
    await db.execAsync('COMMIT');
    await db.closeAsync().catch(() => {});
    db = null;
    clearTileCache();
    const updated = await inspectPack(new File(pack.uri));
    return { pack: updated, added: downloaded.length, reason: updated ? 'expanded' : 'failed' };
  } catch {
    if (db) {
      await db.execAsync('ROLLBACK').catch(() => {});
      await db.closeAsync().catch(() => {});
    }
    return { pack, added: 0, reason: 'failed' };
  }
}

/** A tiny world overview used when the user declines location access. */
export async function downloadWorldOverview(onProgress?: RegionPackOptions['onProgress']) {
  return downloadRegionPack({ center: null, onProgress, maxTiles: 341 });
}

/** True when the app can build a local pack from a fix. */
export function canBuildRegionPack(point: LatLon | null): boolean {
  return point !== null;
}
