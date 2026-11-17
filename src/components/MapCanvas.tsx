/**
 * The offline map canvas.
 *
 * Two layers, deliberately separable:
 *  1. Tiles from the installed MBTiles pack, if any.
 *  2. A vector overlay of everything that matters (you, peers, SOS alerts,
 *     scale, crosshair) drawn with react-native-svg.
 *
 * With no pack installed the overlay still renders on a coordinate grid, so the
 * screen is never an empty grey rectangle that leaves a user wondering whether
 * the app is broken.
 */

import { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { distanceMeters, formatCoordinate, formatDistance, type LatLon } from '../core/geo';
import { ancestorTile, projectToViewport, TILE_SIZE, tileBounds, tileKey, visibleTiles } from '../core/tiles';
import { readTile, type MapPack } from '../services/tile-pack';
import { palette, radius, space, type } from '../theme';

export type MapMarker = {
  id: string;
  point: LatLon;
  kind: 'self' | 'peer' | 'sos' | 'place';
  label: string;
  /** SOS wins priority ordering regardless of distance. */
  severity?: 'hazard' | 'caution' | 'info' | 'safe';
};

const MARKER_COLOR: Record<MapMarker['kind'], string> = {
  self: palette.jade,
  peer: palette.info,
  sos: palette.hazard,
  place: palette.primary,
};

const MARKER_RADIUS: Record<MapMarker['kind'], number> = { self: 7, peer: 6, sos: 9, place: 8 };

export function MapCanvas({
  center,
  zoom,
  markers,
  pack,
  width,
  height,
  accuracyM,
  style,
  showReadout = true,
  bottomInset = space.lg,
  attribution,
  route,
}: {
  center: LatLon;
  zoom: number;
  markers: MapMarker[];
  route?: LatLon[] | null;
  pack: MapPack | null;
  width: number;
  height: number;
  accuracyM: number | null;
  style?: StyleProp<ViewStyle>;
  showReadout?: boolean;
  /** Space reserved by a floating control sheet at the bottom. */
  bottomInset?: number;
  attribution?: string;
}) {
  const tiles = useMemo(
    () => (pack ? visibleTiles(center, zoom, width, height, 64) : []),
    [pack, center.lat, center.lon, zoom, width, height],
  );

  type ResolvedTile = { uri: string; z: number; x: number; y: number };
  const [loaded, setLoaded] = useState<Record<string, ResolvedTile>>({});

  // A replaced pack reuses the same filename, so drop every decoded tile.
  useEffect(() => {
    setLoaded({});
  }, [pack?.uri, pack?.source, pack?.maxZoom, pack?.tileCount]);

  // Load each visible tile at the best available ancestor. A pack can have a
  // max zoom that is only present in part of its bounds; without this fallback
  // the viewport would go white just past that coverage.
  useEffect(() => {
    if (!pack || tiles.length === 0) return;
    let cancelled = false;
    void (async () => {
      const found: Record<string, ResolvedTile> = {};
      await Promise.all(
        tiles.map(async (tile) => {
          const minFallbackZoom = Math.max(pack.minZoom, tile.z - 4);
          for (let z = tile.z; z >= minFallbackZoom; z -= 1) {
            const candidate = ancestorTile(tile, z);
            const uri = await readTile(pack.uri, candidate);
            if (uri) {
              found[tileKey(candidate)] = { uri, ...candidate };
              break;
            }
          }
        }),
      );
      if (cancelled) return;
      setLoaded(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [pack, tiles]);

  const placedMarkers = markers.map((marker) => ({
    ...marker,
    ...projectToViewport(marker.point, center, zoom, width, height),
    distance: distanceMeters(center, marker.point),
  }));

  const visibleMarkers = placedMarkers.filter(
    (marker) => marker.x > -40 && marker.x < width + 40 && marker.y > -40 && marker.y < height + 40,
  );

  const routePoints = route
    ?.map((point) => projectToViewport(point, center, zoom, width, height))
    .map((point) => `${point.x},${point.y}`)
    .join(' ');

  const selfMarker = visibleMarkers.find((marker) => marker.kind === 'self');
  const gridStep = 64;
  const gridLinesX = Array.from({ length: Math.ceil(width / gridStep) }, (_, index) => index * gridStep);
  const gridLinesY = Array.from({ length: Math.ceil(height / gridStep) }, (_, index) => index * gridStep);
  const loadedCount = Object.keys(loaded).length;
  // The grid is a fallback for a pack-less canvas, not a permanent overlay.
  const showGrid = !pack || loadedCount === 0;

  return (
    <View style={[styles.container, { width, height }, style]}>
      {pack && loadedCount === 0 ? (
        <View style={styles.notice}>
          <Text style={[type.caption, { color: palette.caution }]}>
            No tiles at this zoom in {pack.name}
          </Text>
        </View>
      ) : null}

      {/* Tiles are drawn first so the vector overlay always sits on top. */}
      {Object.entries(loaded).map(([key, tile]) => {
        const bounds = tileBounds({ z: tile.z, x: tile.x, y: tile.y });
        const corner = projectToViewport(
          { lat: bounds.north, lon: bounds.west },
          center,
          zoom,
          width,
          height,
        );
        const size = Math.round(TILE_SIZE * 2 ** Math.max(0, zoom - tile.z));
        return (
          <Image
            key={key}
            source={{ uri: tile.uri }}
            style={[
              styles.tile,
              {
                left: Math.round(corner.x),
                top: Math.round(corner.y),
                width: size,
                height: size,
              },
            ]}
            resizeMode="cover"
            accessible={false}
          />
        );
      })}

      <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
        {showGrid ? (
          <>
            {gridLinesX.map((x) => (
              <Line key={`gx-${x}`} x1={x} y1={0} x2={x} y2={height} stroke={palette.line} strokeWidth={1} />
            ))}
            {gridLinesY.map((y) => (
              <Line key={`gy-${y}`} x1={0} y1={y} x2={width} y2={y} stroke={palette.line} strokeWidth={1} />
            ))}
          </>
        ) : null}

        {/* Accuracy circle: honesty about how wrong the fix could be. */}
        {selfMarker && accuracyM ? (
          <Circle
            cx={selfMarker.x}
            cy={selfMarker.y}
            r={Math.max(6, Math.min(accuracyM / 4, 90))}
            fill={palette.jadeWash}
            fillOpacity={0.7}
            stroke={palette.jade}
            strokeOpacity={0.4}
          />
        ) : null}

        {routePoints ? (
          <G>
            <Polyline
              points={routePoints}
              fill="none"
              stroke={palette.surface}
              strokeWidth={9}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <Polyline
              points={routePoints}
              fill="none"
              stroke={palette.primary}
              strokeWidth={5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </G>
        ) : null}

        {visibleMarkers.map((marker) => (
          <G key={marker.id}>
            <Circle
              cx={marker.x}
              cy={marker.y}
              r={MARKER_RADIUS[marker.kind] + 5}
              fill={MARKER_COLOR[marker.kind]}
              fillOpacity={0.18}
            />
            <Circle
              cx={marker.x}
              cy={marker.y}
              r={MARKER_RADIUS[marker.kind]}
              fill={MARKER_COLOR[marker.kind]}
              stroke={palette.canvas}
              strokeWidth={1.5}
            />
            <SvgText
              x={marker.x}
              y={marker.y - MARKER_RADIUS[marker.kind] - 6}
              fill={palette.ink}
              fontSize={10}
              fontWeight="600"
              textAnchor="middle"
            >
              {marker.label.slice(0, 16)}
            </SvgText>
          </G>
        ))}

        {/* Scale bar: 64 px is a fixed screen length, so label the ground width. */}
        <G>
          <Line
            x1={space.md}
            y1={height - bottomInset}
            x2={space.md + 64}
            y2={height - bottomInset}
            stroke={palette.ink}
            strokeWidth={2}
          />
          <SvgText
            x={space.md + 68}
            y={height - bottomInset + 4}
            fill={palette.inkMuted}
            fontSize={10}
            fontWeight="600"
          >
            {formatDistance((64 * 156_543.033_92 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom)}
          </SvgText>
        </G>
      </Svg>

      {showReadout ? (
        <View style={styles.corner} pointerEvents="none">
          <Text style={[type.readout, styles.cornerText]}>{formatCoordinate(center)}</Text>
          <Text style={[type.caption, styles.cornerText]}>zoom {zoom}</Text>
        </View>
      ) : null}

      {attribution && pack ? (
        <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
          <SvgText
            x={width - space.md}
            y={height - bottomInset - 7}
            fill={palette.inkMuted}
            fontSize={8}
            textAnchor="end"
          >
            {attribution}
          </SvgText>
        </Svg>
      ) : null}

      {visibleMarkers.length === 0 && !pack ? (
        <View style={styles.emptyOverlay} pointerEvents="none">
          <Text style={[type.title, { color: palette.inkMuted }]}>No signals nearby yet</Text>
          <Text style={[type.body, { color: palette.inkFaint, marginTop: space.xs }]}>
            Peers and SOS alerts appear here as soon as a Bluetooth link is made.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: palette.line,
    overflow: 'hidden',
  },
  tile: { position: 'absolute' },
  notice: {
    position: 'absolute',
    top: 150,
    left: space.sm,
    zIndex: 2,
    backgroundColor: palette.canvas,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.xs,
  },
  corner: {
    position: 'absolute',
    left: space.sm,
    top: space.sm,
    backgroundColor: palette.canvas,
    opacity: 0.85,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.xs,
    gap: 1,
  },
  cornerText: { color: palette.inkMuted, fontSize: 10 },
  emptyOverlay: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.xl,
    backgroundColor: palette.canvas,
    opacity: 0.92,
    borderRadius: radius.sm,
    padding: space.md,
  },
});
