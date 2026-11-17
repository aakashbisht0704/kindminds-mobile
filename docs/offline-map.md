# Offline map

The map has no map SDK and no tile server at runtime. It reads a standard
**MBTiles** raster pack from the app's private storage, draws it on a canvas
with markers and controls, and falls back to a coordinate grid when no pack
covers the current view.

## Pieces

| Module | Role |
| --- | --- |
| `src/core/tiles.ts` | slippy-map maths, TMS row conversion, raster validation, ancestor lookup |
| `src/core/geo.ts` | haversine distance, bearing, bounds, fix smoothing, formatting |
| `src/core/map-pan.ts` | drag-to-pan direction and zoom anchoring |
| `src/services/tile-pack.ts` | open/read/import MBTiles, tile cache, overzoom policy |
| `src/services/region-pack.ts` | build the first-run pack, incrementally expand it |
| `src/services/places.ts` | offline-first search and directions |
| `src/components/MapCanvas.tsx` | tile rendering, markers, grid fallback |
| `src/screens/MapScreen.tsx` | pack selection, search sheet, route/navigation banner |

## Map maths

- Web Mercator, 256 px tiles, zoom clamped to 0–22.
- Screen tile rows use XYZ (north-up); MBTiles stores TMS rows, so reads convert
  with `toTmsY(y, z) = 2^z - 1 - y`.
- `isRasterTile` accepts PNG, JPEG, or WebP magic bytes. An HTML 403 page from a
  blocked tile server is rejected before it can reach an `Image` component.
- Overzoom: `pickZoom` clamps to the pack, then allows up to 4 levels beyond
  `pack.maxZoom`, capped at 18. A z15 pack therefore still renders at street
  level, as a scaled tile rather than a blank square.
- When a zoom level is missing, the canvas falls back to the nearest ancestor
  tile (up to 4 levels coarser) and scales it. The dock tells the user when the
  view is beyond the pack.

## Building the first-run pack

`downloadRegionPack` runs during onboarding, after a **fresh GPS fix**. It
refuses to build a map around a default or stale location.

- Two-tier pyramid: a broad context ring at z8–12 and a close street-level ring
  at z13–15 around the fix.
- Default budget: 700 tiles, with `bboxAround(center, 0.5°)` for context and
  `0.02°` for detail. If the budget is exceeded, the detail ceiling is lowered
  first, then the context ceiling.
- The pack is written as `local-area.mbtiles` with standard MBTiles metadata
  (`name`, `format`, `bounds`, `minzoom`, `maxzoom`, `attribution`).
- Initial creation uses SQLite `VACUUM INTO`, so the result is one
  self-contained file with no WAL sidecar. Later expansions commit in place.
- A failed or interrupted setup leaves no half-written pack: partial
  `local-area-*.mbtiles` files are removed before the next attempt, and the
  final file is replaced atomically.

The default tile source is Esri World Street Map:

```text
https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}
```

Attribution is stored in the pack. **Production deployments should point
`TILE_URL` at an authorised or self-hosted tile server.** Do not use OSM's public
tile endpoint: it returns 403 pages that must not be stored as tiles.

## Growing the pack

When the fix moves outside the detailed ring, `MapScreen` checks whether the
pack has a z13–15 tile at the new position and calls `expandRegionPack` if not.
It runs at most once every 2 minutes and only after moving at least 750 m.

`expandRegionPack` behaviour:

- If the new fix is inside the pack bounds: add only the missing z13–15 detail
  ring around it.
- If the fix has left the pack entirely: add a fresh z8–12 context ring plus the
  detail ring.
- Existing tiles are skipped by querying the pack first. Bounds are extended and
  the update is committed atomically.
- Hard cap: 6,000 tiles. At the cap the result is `full` and the Map screen says
  the pack is full and points at Layers.
- Offline attempts fail quietly (`reason: 'offline'`) and are retried later.
  A 6-second tile timeout keeps a dead network from stalling the map.

## Backup and import

A pack is portable: users can copy an `.mbtiles` file to the phone or receive
one at a relief point. **Layers → Import pack** picks a file, validates it as an
MBTiles database, normalises a safe filename (Android `content://` URIs are not
usable filenames), and lists it alongside downloaded packs. Received map packs
from the mesh appear through the same list.

## Search and directions

Search is offline-first. On-device results are always listed before any network
result:

1. typed coordinates (`37.422, -122.084` or `37.422 -122.084`),
2. the current fix ("My location"),
3. Bluetooth peers with a last-known position,
4. SOS pins,
5. the installed map centre.

Address lookup uses OpenStreetMap Nominatim and road routing uses OSRM **only
when the user submits a search or presses Directions**. Both have timeouts and
fail silently:

- Address search returns the offline result set.
- Directions fall back to a direct line between the two points, with a straight-
  line distance and bearing.
- A place outside the installed pack is labelled: tiles may be blank, but
  directions still work.

Route views frame both ends. Navigation keeps the position centred and shows
distance, bearing, and an **End** control.

## Known limits

- Raster only; there is no vector rendering, rotation, or 3D.
- The first pack is bounded. Deep detail is available only near the fix used to
  build it, or after an online expansion.
- Expansion needs a fresh fix and reachability to the tile server. Without
  either, the existing pack stays usable.
- Esri serves "map data not yet available" placeholders above z15 in some areas,
  which is why the default detail ceiling is z15 and overzoom starts there.
- Online search and routing are convenience features, not part of the offline
  promise. Nominatim/OSRM public endpoints have usage policies; self-host them
  for heavy use.
