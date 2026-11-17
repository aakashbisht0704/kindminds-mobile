/**
 * Offline map packs (MBTiles).
 *
 * A pack is a single SQLite file the user loads *before* the disaster and keeps
 * in the app's document directory. Reading it is an indexed SELECT; there is no
 * tile server, no cache-miss network call, and no way for the map to silently go
 * blank because a CDN is gone. When no pack is installed the map canvas draws a
 * coordinate grid and says so, instead of pretending.
 *
 * Uses the SDK 54 ExpoFileSystem object API (`Paths`/`Directory`/`File`). The
 * legacy `copyAsync` is used only for picker results, because the object API's
 * `File.copy` cannot read Android `content://` URIs.
 */

import { Directory, File, Paths } from 'expo-file-system';
import { copyAsync } from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';

import { bytesToBase64 } from '../core/mesh/bytes';
import { isRasterTile, tileBounds, toTmsY, type TileRef } from '../core/tiles';

export const PACK_DIRECTORY_NAME = 'map-packs';

export type MapPack = {
  name: string;
  uri: string;
  minZoom: number;
  maxZoom: number;
  bounds: { north: number; south: number; west: number; east: number } | null;
  attribution?: string;
  source?: string;
  tileCount: number;
  sizeBytes: number;
};

const connections = new Map<string, SQLite.SQLiteDatabase>();

/** SQLite wants a filesystem path, not a `file://` URI. */
function toDatabasePath(uri: string): string {
  return uri.replace(/^file:\/\//, '');
}

async function openPack(uri: string): Promise<SQLite.SQLiteDatabase> {
  const existing = connections.get(uri);
  if (existing) return existing;

  // expo-sqlite 54 always joins the database name onto a directory. Passing an
  // absolute path as the name therefore produces a bogus path, so split the
  // pack URI into its directory and filename.
  const path = toDatabasePath(uri);
  const slash = path.lastIndexOf('/');
  const directory = slash >= 0 ? path.slice(0, slash) : undefined;
  const name = slash >= 0 ? path.slice(slash + 1) : path;

  // No `readOnly` flag exists in this expo-sqlite version, so the read-only
  // posture is enforced by convention: every statement in this file is a
  // SELECT, and nothing else in the app is handed this connection.
  const instance = await SQLite.openDatabaseAsync(name, {}, directory);
  connections.set(uri, instance);
  return instance;
}

export function packDirectory(): Directory {
  return new Directory(Paths.document, PACK_DIRECTORY_NAME);
}

export function ensurePackDirectory(): void {
  const directory = packDirectory();
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
}

const PACK_EXTENSIONS = ['.mbtiles', '.sqlite', '.db'];

function isPackFile(file: File): boolean {
  const lower = file.name.toLowerCase();
  return PACK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Recover a usable centre from the actual max-zoom tiles when metadata is weak. */
function boundsFromTileExtent(
  extent:
    | { min_x: number | null; max_x: number | null; min_y: number | null; max_y: number | null }
    | null,
  zoom: number,
): MapPack['bounds'] | null {
  if (!extent) return null;
  const { min_x: minX, max_x: maxX, min_y: minTmsY, max_y: maxTmsY } = extent;
  if (
    minX === null ||
    maxX === null ||
    minTmsY === null ||
    maxTmsY === null ||
    ![minX, maxX, minTmsY, maxTmsY, zoom].every(Number.isFinite)
  ) {
    return null;
  }
  const n = 2 ** zoom;
  const top = tileBounds({ z: zoom, x: minX, y: n - 1 - maxTmsY });
  const bottom = tileBounds({ z: zoom, x: minX, y: n - 1 - minTmsY });
  const left = tileBounds({ z: zoom, x: minX, y: 0 });
  const right = tileBounds({ z: zoom, x: maxX, y: 0 });
  return { north: top.north, south: bottom.south, west: left.west, east: right.east };
}

/** Reads the metadata table MBTiles requires, tolerating packs that omit rows. */
/** Close a cached pack connection before replacing or moving the file. */
export async function closePack(uri: string): Promise<void> {
  const instance = connections.get(uri);
  if (!instance) return;
  connections.delete(uri);
  await instance.closeAsync().catch(() => {});
}

export async function inspectPack(file: File): Promise<MapPack | null> {
  try {
    const instance = await openPack(file.uri);
    const rows = await instance.getAllAsync<{ name: string; value: string }>(
      'SELECT name, value FROM metadata',
    );
    const meta = new Map(rows.map((row) => [row.name, row.value]));

    const zoomRow = await instance.getFirstAsync<{ min_zoom: number | null; max_zoom: number | null }>(
      'SELECT MIN(zoom_level) AS min_zoom, MAX(zoom_level) AS max_zoom FROM tiles',
    );
    const countRow = await instance.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM tiles');
    const maxZoom = zoomRow?.max_zoom ?? 0;
    const extent = await instance.getFirstAsync<{
      min_x: number | null;
      max_x: number | null;
      min_y: number | null;
      max_y: number | null;
    }>(
      'SELECT MIN(tile_column) AS min_x, MAX(tile_column) AS max_x, MIN(tile_row) AS min_y, MAX(tile_row) AS max_y FROM tiles WHERE zoom_level = ?',
      maxZoom,
    );

    const parseBounds = (value: string | undefined) => {
      if (!value) return null;
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
      const [west, south, east, north] = parts as [number, number, number, number];
      return { west, south, east, north };
    };

    return {
      name: meta.get('name') ?? file.name.replace(/\.[^.]+$/, ''),
      uri: file.uri,
      minZoom: zoomRow?.min_zoom ?? 0,
      maxZoom: zoomRow?.max_zoom ?? 14,
      bounds: parseBounds(meta.get('bounds')) ?? boundsFromTileExtent(extent, maxZoom),
      attribution: meta.get('attribution') ?? undefined,
      source: meta.get('source') ?? undefined,
      tileCount: countRow?.count ?? 0,
      sizeBytes: file.size,
    };
  } catch {
    return null;
  }
}

export async function listPacks(): Promise<MapPack[]> {
  try {
    ensurePackDirectory();
    const files = packDirectory()
      .list()
      .filter((entry): entry is File => entry instanceof File && isPackFile(entry));
    const packs = await Promise.all(files.map((file) => inspectPack(file)));
    return packs.filter((pack): pack is MapPack => pack !== null);
  } catch {
    return [];
  }
}

/**
 * LRU cache of decoded tiles as base64 data URIs.
 *
 * ponytail: O(1) Map get/set with insertion-order eviction, no scan on read.
 * 96 entries covers a 4x4 tile viewport at two zoom levels plus margin.
 */
export class TileCache {
  private readonly entries = new Map<string, string | null>();

  clear(): void {
    this.entries.clear();
  }

  constructor(private readonly capacity = 96) {}

  get(key: string): string | null | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) ?? null;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string | null): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

const tileCache = new TileCache();

/** Drop decoded tiles after a pack is replaced or imported. */
export function clearTileCache(): void {
  tileCache.clear();
}

/** A tile as a `data:` URI the Image component can render, or null if absent. */
export async function readTile(packUri: string, tile: TileRef): Promise<string | null> {
  const key = `${packUri}|${tile.z}/${tile.x}/${tile.y}`;
  const cached = tileCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const instance = await openPack(packUri);
    const row = await instance.getFirstAsync<{ tile_data: Uint8Array }>(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
      tile.z,
      tile.x,
      toTmsY(tile.y, tile.z),
    );
    if (!row?.tile_data) {
      tileCache.set(key, null);
      return null;
    }
    // A 403/HTML body stored as a tile must never reach an Image component.
    if (!isRasterTile(row.tile_data)) {
      tileCache.set(key, null);
      return null;
    }
    const isPng = row.tile_data[0] === 0x89 && row.tile_data[1] === 0x50;
    const isWebp =
      row.tile_data[0] === 0x52 && row.tile_data[1] === 0x49 && row.tile_data[8] === 0x57;
    const mime = isPng ? 'image/png' : isWebp ? 'image/webp' : 'image/jpeg';
    const uri = `data:${mime};base64,${bytesToBase64(row.tile_data)}`;
    tileCache.set(key, uri);
    return uri;
  } catch {
    tileCache.set(key, null);
    return null;
  }
}

/** True when a pack already holds this exact tile. */
export async function hasTile(packUri: string, tile: TileRef): Promise<boolean> {
  try {
    const instance = await openPack(packUri);
    const row = await instance.getFirstAsync<{ present: number }>(
      'SELECT 1 AS present FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ? AND tile_data IS NOT NULL LIMIT 1',
      tile.z,
      tile.x,
      toTmsY(tile.y, tile.z),
    );
    return Boolean(row);
  } catch {
    return false;
  }
}

export const MAX_OVERZOOM = 18;

/**
 * Clamp to the pack, then allow a few levels of raster overzoom so a z16 pack
 * can reach street level instead of stopping dead at the downloaded ceiling.
 */
export function pickZoom(pack: MapPack | null, preferred: number): number {
  if (!pack) return Math.min(preferred, 14);
  const cap = Math.min(MAX_OVERZOOM, pack.maxZoom + 4);
  return Math.min(cap, Math.max(pack.minZoom, Math.round(preferred)));
}

/**
 * A picker returns a content:// URI whose basename is not a usable filename
 * (`image%3A1000105062`). Decode it, keep only the last segment, and keep the
 * pack readable by SQLite with a known extension.
 */
function pickedPackName(uri: string): string {
  const raw = uri.split('/').pop() ?? '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  const leaf = decoded.split(/[\\/:]/).pop() ?? '';
  const cleaned = leaf.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '');
  if (cleaned.length === 0) return `imported-pack-${Date.now()}.mbtiles`;
  return /\.(mbtiles|sqlite|db)$/i.test(cleaned) ? cleaned : `${cleaned}-${Date.now()}.mbtiles`;
}

/**
 * Import a pack the user already has on the device (downloaded earlier, or
 * handed over on a USB stick at a relief point).
 */
export async function importPack(source: File): Promise<MapPack | null> {
  ensurePackDirectory();
  const target = new File(packDirectory(), pickedPackName(source.uri));
  if (target.exists) target.delete();
  // The picker hands back a content:// URI on Android; File.copy cannot read
  // those, but the legacy copy uses ContentResolver.openInputStream.
  await copyAsync({ from: source.uri, to: target.uri });
  clearTileCache();
  return inspectPack(target);
}

/** Picker-based import, used by the settings screen. */
export async function pickAndImportPack(): Promise<MapPack | null> {
  try {
    const picked = await File.pickFileAsync(undefined, '*/*');
    const first = Array.isArray(picked) ? picked[0] : picked;
    if (!first) return null;
    // The picker resolves the native base class; re-wrap it so `copy`/`size`
    // come from the SDK's File implementation rather than the raw binding.
    return await importPack(new File(first.uri));
  } catch {
    return null;
  }
}

const megaByteFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

export function formatPackSize(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${megaByteFormat.format(bytes / (1024 * 1024))} MB`;
}
