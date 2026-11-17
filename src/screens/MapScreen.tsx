/**
 * Full-bleed offline map.
 *
 * The map is the page, not a card inside it. Tiles come from the installed
 * MBTiles pack; the vector overlay adds you, peers, SOS alerts, scale, and
 * attribution. Controls float above the map so the ground stays visible.
 *
 * When no pack is installed the canvas still draws a coordinate grid and offers
 * one clear action: download a map. A 403 HTML page from a tile server must
 * never be stored or rendered as a tile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, G, Path } from 'react-native-svg';

import { MapCanvas, type MapMarker } from '../components/MapCanvas';
import { MapSearchSheet } from '../components/MapSearchSheet';
import {
  ActionButton,
  AppText,
  Card,
  EmptyState,
  Pill,
  ProgressBar,
  Readout,
  SectionLabel,
  StatRow,
} from '../components/ui';
import {
  compassPoint,
  distanceMeters,
  formatCoordinate,
  formatDistance,
  initialBearingDeg,
  type LatLon,
} from '../core/geo';
import { shiftCenter } from '../core/map-pan';
import { tileForPoint } from '../core/tiles';
import { describeFixAge, locateForMap } from '../services/location';
import { downloadRegionPack, expandRegionPack } from '../services/region-pack';
import {
  directRoute,
  fetchRoute,
  fitRouteZoom,
  routeCenter,
  routeHeadline,
  type PlaceResult,
  type RouteResult,
} from '../services/places';
import {
  formatPackSize,
  hasTile,
  listPacks,
  pickAndImportPack,
  pickZoom,
  type MapPack,
} from '../services/tile-pack';
import type { DevicesApi, MeshApi } from '../state/useMesh';
import { tapFeedback } from '../services/haptics';
import { hitSlop, palette, radius, shadow, space, type Severity } from '../theme';

const WORLD_CENTER: LatLon = { lat: 20, lon: 0 };

function describeBattery(battery: DevicesApi['battery']): string {
  if (battery.level === null) return 'unknown';
  const percent = `${Math.round(battery.level * 100)}%`;
  if (battery.state === 'charging') return `${percent} · charging`;
  if (battery.state === 'full') return `${percent} · full`;
  return battery.state === 'unplugged' ? `${percent} · unplugged` : percent;
}

function touchDistance(touches: readonly { pageX: number; pageY: number }[]): number {
  const [a, b] = touches;
  if (!a || !b) return 0;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

const FIX_STATUS: Record<string, { text: string; severity: Severity }> = {
  idle: { text: 'starting', severity: 'neutral' },
  waiting: { text: 'searching for satellites', severity: 'caution' },
  live: { text: 'live fix', severity: 'safe' },
  denied: { text: 'location denied', severity: 'hazard' },
  unavailable: { text: 'GPS unavailable', severity: 'hazard' },
};

/** Move the viewport by a screen-space drag, keeping Web Mercator honest. */
export function MapScreen({
  mesh,
  devices,
  packVersion = 0,
}: {
  mesh: MeshApi;
  devices: DevicesApi;
  packVersion?: number;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [packs, setPacks] = useState<MapPack[]>([]);
  const [packsLoaded, setPacksLoaded] = useState(false);
  const [packIndex, setPackIndex] = useState(0);
  const [zoom, setZoom] = useState(15);
  const [mapSize, setMapSize] = useState({
    width: windowWidth,
    height: Math.max(320, windowHeight - 120),
  });
  const [viewCenter, setViewCenter] = useState<LatLon | null>(null);
  const [follow, setFollow] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const [packsOpen, setPacksOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadDetail, setDownloadDetail] = useState('');
  const [downloadNotice, setDownloadNotice] = useState<string | null>(null);
  const [sharingPack, setSharingPack] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);
  const [expansionDetail, setExpansionDetail] = useState('');
  const [expansionNotice, setExpansionNotice] = useState<string | null>(null);
  const expandingRef = useRef(false);
  const lastExpandAttempt = useRef(0);
  const lastExpandPoint = useRef<LatLon | null>(null);
  const mountedRef = useRef(true);

  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPlace, setSelectedPlace] = useState<PlaceResult | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [placeNotice, setPlaceNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPacksLoaded(false);
    void listPacks().then((found) => {
      if (!cancelled) {
        setPacks(found);
        setPacksLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [packVersion]);

  useEffect(() => {
    if (packIndex >= packs.length) setPackIndex(0);
  }, [packIndex, packs.length]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A frozen GPS must look frozen, so the fix-age line is refreshed on a slow
  // timer rather than only when some other state happens to change.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);

  const self = devices.location.point;
  const pack = packs[packIndex] ?? null;
  const effectiveZoom = pickZoom(pack, zoom);

  // When the fix moves beyond the detailed ring, grow the pack around the new
  // position. Existing tiles are skipped, so this stays a small incremental
  // download. Offline attempts fail quietly and are retried later.
  useEffect(() => {
    if (!packsLoaded || !self || !pack || downloading || expandingRef.current) return;
    const now = Date.now();
    if (now - lastExpandAttempt.current < 120_000) return;
    if (lastExpandPoint.current && distanceMeters(lastExpandPoint.current, self) < 750) return;
    expandingRef.current = true;
    void (async () => {
      try {
        const coverageZoom = Math.min(15, Math.max(13, pack.maxZoom));
        const covered = await hasTile(pack.uri, tileForPoint(self, coverageZoom));
        if (covered || !mountedRef.current) return;
        lastExpandAttempt.current = Date.now();
        setExpanding(true);
        setExpansionNotice(null);
        setExpansionDetail('Expanding offline map…');
        const result = await expandRegionPack(pack, self, {
          onProgress: (_fraction, detail) => {
            if (mountedRef.current) setExpansionDetail(`Expanding map… ${detail}`);
          },
        });
        if (!mountedRef.current) return;
        if (result.reason === 'expanded' && result.pack) {
          lastExpandPoint.current = self;
          const found = await listPacks();
          if (!mountedRef.current) return;
          const next = found.length > 0 ? found : [result.pack];
          setPacks(next);
          setPacksLoaded(true);
          const index = next.findIndex((candidate) => candidate.uri === result.pack?.uri);
          if (index >= 0) setPackIndex(index);
          setExpansionNotice(`Offline map expanded (+${result.added} tiles).`);
        } else if (result.reason === 'full') {
          setExpansionNotice('Offline map is full. Manage packs in Layers.');
        }
      } finally {
        expandingRef.current = false;
        if (mountedRef.current) {
          setExpanding(false);
          setExpansionDetail('');
        }
      }
    })();
  }, [packsLoaded, self?.lat, self?.lon, pack?.uri, pack?.tileCount, downloading]);

  useEffect(() => {
    if (!expansionNotice) return;
    const timer = setTimeout(() => setExpansionNotice(null), 4_500);
    return () => clearTimeout(timer);
  }, [expansionNotice]);

  const markers = useMemo<MapMarker[]>(() => {
    const list: MapMarker[] = [];
    if (self) list.push({ id: 'self', point: self, kind: 'self', label: 'You' });
    for (const peer of mesh.peers) {
      if (!peer.lastKnown) continue;
      list.push({
        id: peer.peerId,
        point: peer.lastKnown,
        kind: 'peer',
        label: peer.callsign,
      });
    }
    for (const alert of mesh.alerts) {
      // Your own SOS is already represented by the self marker.
      if (alert.mine) continue;
      // A zero coordinate is the protocol's "no fix", not a point off Africa.
      if (alert.payload.lat === 0 && alert.payload.lon === 0) continue;
      list.push({
        id: alert.messageId,
        point: { lat: alert.payload.lat, lon: alert.payload.lon },
        kind: 'sos',
        label: alert.senderCallsign,
      });
    }
    if (selectedPlace) {
      list.push({
        id: 'selected-place',
        point: selectedPlace.point,
        kind: 'place',
        label: selectedPlace.name,
      });
    }
    return list;
  }, [self, mesh.peers, mesh.alerts, selectedPlace]);

  const neighborWithFix = mesh.peers.find((peer) => peer.lastKnown !== null) ?? null;
  const packCenter = pack?.bounds
    ? {
        lat: (pack.bounds.north + pack.bounds.south) / 2,
        lon: (pack.bounds.east + pack.bounds.west) / 2,
      }
    : null;
  const followedCenter = self ?? neighborWithFix?.lastKnown ?? packCenter ?? WORLD_CENTER;
  const center = follow ? followedCenter : (viewCenter ?? followedCenter);

  // Refs keep an in-progress drag stable even while the center state updates.
  const centerRef = useRef(center);
  const zoomRef = useRef(effectiveZoom);
  const packRef = useRef(pack);
  const dragStart = useRef(center);
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartZoom = useRef(effectiveZoom);
  const pinching = useRef(false);
  centerRef.current = center;
  zoomRef.current = effectiveZoom;
  packRef.current = pack;

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gesture) =>
          gesture.numberActiveTouches >= 2 ||
          Math.abs(gesture.dx) > 5 ||
          Math.abs(gesture.dy) > 5,
        onPanResponderGrant: (event) => {
          dragStart.current = centerRef.current;
          const touches = event.nativeEvent.touches;
          pinching.current = touches.length >= 2;
          pinchStartDistance.current = pinching.current ? touchDistance(touches) : null;
          pinchStartZoom.current = zoomRef.current;
          setFollow(false);
        },
        onPanResponderMove: (event, gesture) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const distance = touchDistance(touches);
            if (!pinching.current || pinchStartDistance.current === null) {
              pinching.current = true;
              pinchStartDistance.current = distance;
              pinchStartZoom.current = zoomRef.current;
              return;
            }
            const ratio = distance / Math.max(1, pinchStartDistance.current);
            setZoom(pickZoom(packRef.current, pinchStartZoom.current + Math.log2(ratio)));
            return;
          }
          if (pinching.current) return;
          setViewCenter(shiftCenter(dragStart.current, zoomRef.current, gesture.dx, gesture.dy));
        },
        onPanResponderRelease: () => {
          pinching.current = false;
          pinchStartDistance.current = null;
        },
        onPanResponderTerminate: () => {
          pinching.current = false;
          pinchStartDistance.current = null;
        },
        onPanResponderTerminationRequest: () => true,
      }),
    [],
  );

  const onMapLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    setMapSize((current) => {
      const next = { width: Math.round(width), height: Math.round(height) };
      return current.width === next.width && current.height === next.height ? current : next;
    });
  }, []);

  const recenter = useCallback(() => {
    if (!self) {
      void devices.refreshFix();
      return;
    }
    setFollow(true);
    setViewCenter(null);
  }, [devices, self]);

  const clearPlace = useCallback(() => {
    setSelectedPlace(null);
    setRoute(null);
    setRouteBusy(false);
    setNavigating(false);
    setPlaceNotice(null);
  }, []);

  const selectPlace = useCallback(
    (place: PlaceResult) => {
      setSearchOpen(false);
      setSelectedPlace(place);
      setRoute(null);
      setRouteBusy(false);
      setNavigating(false);
      setFollow(place.source === 'self');
      setViewCenter(place.point);
      setZoom(pickZoom(pack, 15));
      const bounds = pack?.bounds;
      const outside =
        bounds &&
        (place.point.lat > bounds.north ||
          place.point.lat < bounds.south ||
          place.point.lon > bounds.east ||
          place.point.lon < bounds.west);
      setPlaceNotice(
        outside
          ? 'This place is outside the installed offline map. Tiles may be blank; directions still work.'
          : null,
      );
    },
    [pack],
  );

  const getDirections = useCallback(async () => {
    if (!selectedPlace) return;
    if (!self) {
      setPlaceNotice('Wait for a GPS fix before starting directions.');
      return;
    }
    setRouteBusy(true);
    try {
      const result = await fetchRoute(self, selectedPlace.point);
      setRoute(result);
      const centerPoint = routeCenter(result.points);
      if (centerPoint) {
        setFollow(false);
        setViewCenter(centerPoint);
        setZoom(fitRouteZoom(result.points, mapSize.width, mapSize.height));
      }
      setPlaceNotice(
        result.mode === 'direct'
          ? 'Direct line guidance. Road routing was unavailable.'
          : null,
      );
    } finally {
      setRouteBusy(false);
    }
  }, [selectedPlace, self, mapSize.width, mapSize.height, pack]);

  const startNavigation = useCallback(() => {
    if (!route || !selectedPlace) return;
    setNavigating(true);
    setFollow(true);
    setViewCenter(null);
    setZoom(pickZoom(pack, 16));
  }, [route, selectedPlace, pack]);

  const endNavigation = useCallback(() => {
    setNavigating(false);
    setFollow(false);
    setViewCenter(selectedPlace?.point ?? null);
  }, [selectedPlace]);

  const sharePack = useCallback(
    async (candidate: MapPack) => {
      setSharingPack(candidate.name);
      setShareNotice(`Sending ${candidate.name}. Keep the app open…`);
      try {
        const sent = await mesh.shareFile(
          candidate.uri,
          candidate.name,
          'application/vnd.mapbox-vector-tile',
          'maps',
        );
        setShareNotice(
          sent > 0
            ? `${candidate.name} queued for the mesh.`
            : 'No peer link is open. The pack was not sent.',
        );
      } finally {
        setSharingPack(null);
      }
    },
    [mesh],
  );

  const importPack = useCallback(async () => {
    setImporting(true);
    setDownloadNotice(null);
    try {
      const imported = await pickAndImportPack();
      if (imported) {
        const found = await listPacks();
        setPacks(found);
        setPacksLoaded(true);
        const index = found.findIndex((candidate) => candidate.uri === imported.uri);
        if (index >= 0) setPackIndex(index);
        setDownloadNotice(`${imported.name} is now installed.`);
      }
    } finally {
      setImporting(false);
    }
  }, []);

  const downloadMap = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadDetail('Finding your area…');
    setDownloadNotice(null);
    try {
      let point = self;
      if (!point) {
        setDownloadDetail('Finding your location…');
        point = (await locateForMap(15_000))?.point ?? null;
      }
      if (!point) {
        setDownloadNotice(
          'No location fix. Turn on GPS, move outside, then retry. A map is only downloaded for where you actually are.',
        );
        return;
      }
      const onProgress = (fraction: number, detail: string) => {
        setDownloadProgress(fraction);
        setDownloadDetail(detail);
      };
      const result = await downloadRegionPack({ center: point, onProgress });
      if (!result) {
        setDownloadNotice('No tiles were downloaded. Check the connection and try again.');
        return;
      }
      const found = await listPacks();
      const next = found.length > 0 ? found : [result];
      setPacks(next);
      setPacksLoaded(true);
      const index = next.findIndex((candidate) => candidate.uri === result.uri);
      if (index >= 0) setPackIndex(index);
      setDownloadNotice('Your local map is saved on the phone.');
    } catch {
      setDownloadNotice('Download failed. Check the connection and try again.');
    } finally {
      setDownloading(false);
    }
  }, [downloading, self]);

  const status = FIX_STATUS[devices.location.status] ?? {
    text: 'GPS state unknown',
    severity: 'neutral' as Severity,
  };
  const nearestPeer = mesh.peers.find((peer) => peer.lastKnown !== null) ?? null;
  const accuracyText =
    devices.location.accuracyM === null
      ? 'unknown'
      : `+/- ${formatDistance(devices.location.accuracyM)}`;
  const battery = describeBattery(devices.battery);
  const recenterLabel = !self ? 'Find me' : follow ? 'Centered' : 'Center on me';

  const selectedDistance =
    self && selectedPlace ? distanceMeters(self, selectedPlace.point) : null;
  const navigationBearing =
    self && selectedPlace ? initialBearingDeg(self, selectedPlace.point) : 0;
  const showPlaceCard = Boolean(selectedPlace && !navigating);
  const mapBottomInset = showPlaceCard ? 232 : navigating ? 32 : 96;

  return (
    <View style={styles.root}>
      <View style={styles.mapWrap} onLayout={onMapLayout} {...panResponder.panHandlers}>
        <MapCanvas
          center={center}
          zoom={effectiveZoom}
          markers={markers}
          route={route?.points ?? null}
          pack={pack}
          width={mapSize.width}
          height={mapSize.height}
          accuracyM={devices.location.accuracyM}
          style={styles.fullBleed}
          showReadout={false}
          bottomInset={mapBottomInset}
          attribution={pack ? (pack.attribution ?? '© OpenStreetMap contributors') : undefined}
        />

        {expanding || expansionNotice ? (
          <View
            pointerEvents="none"
            style={[
              styles.expansionToast,
              { bottom: (showPlaceCard ? 232 : navigating ? 32 : 96) + insets.bottom + 12 },
            ]}
          >
            {expanding ? <ActivityIndicator size="small" color={palette.primary} /> : null}
            <Text style={styles.expansionText}>
              {expanding ? expansionDetail || 'Expanding offline map…' : expansionNotice}
            </Text>
          </View>
        ) : null}

        {navigating && selectedPlace ? (
          <View style={[styles.navBanner, { paddingTop: insets.top + space.sm }]}>
            <View style={styles.navArrow}>
              <ArrowIcon bearing={navigationBearing} />
            </View>
            <View style={styles.navCopy}>
              <Text style={styles.navDistance}>
                {route
                  ? formatDistance(route.distanceM)
                  : selectedDistance !== null
                    ? formatDistance(selectedDistance)
                    : 'No GPS fix'}
              </Text>
              <Text style={styles.navInstruction} numberOfLines={2}>
                {route?.mode === 'road' ? 'Follow the route line' : 'Direct line guidance'} ·{' '}
                {selectedPlace.name}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End navigation"
              hitSlop={hitSlop}
              android_ripple={{ color: 'rgba(192,68,46,0.10)', borderless: true }}
              onPress={() => {
                tapFeedback();
                endNavigation();
              }}
              style={({ pressed }) => [styles.endButton, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={styles.endText}>End</Text>
            </Pressable>
          </View>
        ) : (
          <View
            pointerEvents="box-none"
            style={[styles.topOverlay, { paddingTop: insets.top + space.sm }]}
          >
            <View style={styles.topRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Search places or coordinates"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
                onPress={() => {
                  tapFeedback();
                  setSearchOpen(true);
                }}
                style={({ pressed }) => [styles.searchBar, { opacity: pressed ? 0.9 : 1 }]}
              >
                <SearchIcon color={palette.inkMuted} />
                <Text style={styles.searchPlaceholder} numberOfLines={1}>
                  Search places or coordinates
                </Text>
              </Pressable>
              <Pill label={status.text} severity={status.severity} />
            </View>

            {!self ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Try for a GPS fix"
                android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
                onPress={() => {
                  tapFeedback();
                  void devices.refreshFix();
                }}
                style={({ pressed }) => [styles.banner, { opacity: pressed ? 0.85 : 1 }]}
              >
                <View style={styles.bannerCopy}>
                  <Text style={styles.bannerTitle}>
                    {pack
                      ? devices.location.status === 'denied'
                        ? 'Location denied — showing your offline map'
                        : 'No GPS fix yet — showing your offline map'
                      : 'No GPS fix yet'}
                  </Text>
                  <Text style={styles.bannerBody}>
                    {pack
                      ? 'Tap to try for a fix. You can still search, pan, and zoom the downloaded area.'
                      : 'Tap to try for a fix, or download an offline map below.'}
                  </Text>
                </View>
                <Text style={styles.bannerAction}>Try</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        {!selectedPlace && !navigating ? (
          <>
            <View pointerEvents="box-none" style={styles.zoomWrap}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Zoom in"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
                onPress={() => {
                  tapFeedback();
                  setZoom(pickZoom(pack, effectiveZoom + 1));
                }}
                style={({ pressed }) => [
                  styles.zoomButton,
                  { opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
                ]}
              >
                <Text style={styles.zoomLabel}>+</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Zoom out"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
                onPress={() => {
                  tapFeedback();
                  setZoom(pickZoom(pack, effectiveZoom - 1));
                }}
                style={({ pressed }) => [
                  styles.zoomButton,
                  { opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
                ]}
              >
                <Text style={styles.zoomLabel}>−</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={self && follow ? 'Centred on you' : 'Centre on me'}
              hitSlop={hitSlop}
              android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
              onPress={() => {
                tapFeedback();
                recenter();
              }}
              style={({ pressed }) => [
                styles.locateFab,
                { opacity: pressed ? 0.75 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
              ]}
            >
              <LocateIcon color={self && follow ? palette.primary : palette.ink} />
            </Pressable>
          </>
        ) : null}

        {!pack && packsLoaded ? (
          <View pointerEvents="box-none" style={styles.centerNotice}>
            <View style={styles.centerCard}>
              <AppText variant="title">No offline map yet</AppText>
              <AppText variant="caption" color={palette.inkMuted}>
                Download the area around you once. It stays on the phone.
              </AppText>
              <ActionButton
                label={downloading ? 'Downloading…' : 'Download map'}
                tone="primary"
                busy={downloading}
                onPress={() => void downloadMap()}
              />
              {downloadProgress > 0 ? <ProgressBar ratio={downloadProgress} /> : null}
              <AppText variant="caption" color={palette.inkFaint}>
                {downloadDetail || 'One small download, then it works offline.'}
              </AppText>
            </View>
          </View>
        ) : null}

        {!selectedPlace && !navigating ? (
          <View pointerEvents="box-none" style={styles.dockWrap}>
            <View style={styles.dock}>
              <View style={styles.dockRow}>
                <View style={styles.dockCopy}>
                  <Text style={styles.dockTitle} numberOfLines={1}>
                    {pack ? pack.name : 'No offline map'}
                  </Text>
                  <Text style={styles.dockSub} numberOfLines={1}>
                    {self ? `${formatCoordinate(self)} · ${accuracyText}` : 'No GPS fix'}
                    {` · ${mesh.peers.length} peer${mesh.peers.length === 1 ? '' : 's'} · z${effectiveZoom}${
                      pack && effectiveZoom > pack.maxZoom
                        ? ` · ${2 ** (effectiveZoom - pack.maxZoom)}×`
                        : ''
                    }`}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Map layers and packs"
                  hitSlop={hitSlop}
                  android_ripple={{ color: 'rgba(249,115,22,0.10)' }}
                  onPress={() => {
                    tapFeedback();
                    setPacksOpen(true);
                  }}
                  style={({ pressed }) => [styles.layersButton, { opacity: pressed ? 0.75 : 1 }]}
                >
                  <LayersIcon color={palette.primaryText} />
                  <Text style={styles.layersText}>Layers</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {showPlaceCard && selectedPlace ? (
          <View style={styles.placeCard}>
            <View style={styles.placeTop}>
              <View style={styles.placeCopy}>
                <Text style={styles.placeKicker}>{placeSourceLabel(selectedPlace.source)}</Text>
                <Text style={styles.placeName} numberOfLines={1}>
                  {selectedPlace.name}
                </Text>
                <Text style={styles.placeSub} numberOfLines={2}>
                  {selectedPlace.subtitle}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear selected place"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
                onPress={() => {
                  tapFeedback();
                  clearPlace();
                }}
                style={({ pressed }) => [styles.placeClose, { opacity: pressed ? 0.65 : 1 }]}
              >
                <CloseIcon />
              </Pressable>
            </View>

            <View style={styles.placeMetaRow}>
              {selectedDistance !== null ? (
                <Text style={styles.placeDistance}>{formatDistance(selectedDistance)} away</Text>
              ) : null}
              {route ? (
                <Text style={styles.routeHeadline} numberOfLines={1}>
                  {routeHeadline(route)}
                </Text>
              ) : null}
            </View>

            {placeNotice ? <Text style={styles.placeNotice}>{placeNotice}</Text> : null}

            <View style={styles.placeActions}>
              <View style={styles.placeAction}>
                {route ? (
                  <ActionButton
                    label="Start"
                    tone="primary"
                    onPress={() => {
                      tapFeedback();
                      startNavigation();
                    }}
                  />
                ) : (
                  <ActionButton
                    label={routeBusy ? 'Routing…' : 'Directions'}
                    tone="primary"
                    busy={routeBusy}
                    disabled={!self || selectedPlace.source === 'self'}
                    onPress={() => void getDirections()}
                  />
                )}
              </View>
              <View style={styles.placeAction}>
                <ActionButton label="Clear" tone="ghost" onPress={clearPlace} />
              </View>
            </View>
          </View>
        ) : null}
      </View>

      <MapSearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={selectPlace}
        self={self}
        peers={mesh.peers}
        alerts={mesh.alerts}
        packCenter={packCenter}
        packName={pack?.name ?? null}
      />

      <Modal
        visible={packsOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPacksOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPacksOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitle}>
                <AppText variant="title">Maps &amp; layers</AppText>
                <AppText variant="caption" color={palette.inkMuted}>
                  Stored on this phone. Nothing here needs a server.
                </AppText>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close map packs"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
                onPress={() => {
                  tapFeedback();
                  setPacksOpen(false);
                }}
                style={({ pressed }) => [styles.close, { opacity: pressed ? 0.65 : 1 }]}
              >
                <AppText variant="caption" color={palette.primaryText}>
                  Close
                </AppText>
              </Pressable>
            </View>

            <ScrollView
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetContent}
              showsVerticalScrollIndicator={false}
            >
              {packs.length === 0 ? (
                <EmptyState
                  title="No offline pack installed"
                  body="Download the area around you, or import an MBTiles file you saved before the disaster."
                />
              ) : (
                packs.map((candidate, index) => (
                  <Card key={candidate.uri} severity={index === packIndex ? 'info' : undefined}>
                    <AppText variant="title" numberOfLines={1}>
                      {candidate.name}
                    </AppText>
                    <Readout size={12} color={palette.inkMuted}>
                      {`z${candidate.minZoom}-${candidate.maxZoom} · ${candidate.tileCount} tiles · ${formatPackSize(candidate.sizeBytes)}`}
                    </Readout>
                    <View style={styles.packActions}>
                      <View style={styles.packButton}>
                        <ActionButton
                          label={index === packIndex ? 'In use' : 'Use this pack'}
                          tone={index === packIndex ? 'ghost' : 'primary'}
                          disabled={index === packIndex}
                          onPress={() => {
                            setPackIndex(index);
                            setFollow(true);
                            setViewCenter(null);
                          }}
                        />
                      </View>
                      <View style={styles.packButton}>
                        <ActionButton
                          label={sharingPack === candidate.name ? 'Sending' : 'Share'}
                          tone="ghost"
                          busy={sharingPack === candidate.name}
                          disabled={sharingPack !== null}
                          onPress={() => void sharePack(candidate)}
                          accessibilityHint="Sends this map pack to nearby mesh nodes"
                        />
                      </View>
                    </View>
                  </Card>
                ))
              )}

              {pack && pack.maxZoom < 15 ? (
                <View style={styles.updateBlock}>
                  <AppText variant="caption" color={palette.caution}>
                    This pack stops at z{pack.maxZoom}. Download a fresh local map for street-level
                    detail and deeper zoom.
                  </AppText>
                  <ActionButton
                    label="Download detailed map"
                    tone="soft"
                    busy={downloading}
                    onPress={() => void downloadMap()}
                  />
                </View>
              ) : null}

              <View style={styles.downloadBlock}>
                {!pack || pack.maxZoom >= 15 ? (
                  <ActionButton
                    label={
                      downloading
                        ? 'Downloading map…'
                        : self
                          ? 'Download local map'
                          : 'Find my area'
                    }
                    tone="primary"
                    busy={downloading}
                    onPress={() => void downloadMap()}
                  />
                ) : null}
                {downloadProgress > 0 ? <ProgressBar ratio={downloadProgress} /> : null}
                {downloadDetail ? (
                  <AppText variant="caption" color={palette.inkMuted}>
                    {downloadDetail}
                  </AppText>
                ) : null}
                {downloadNotice ? (
                  <AppText variant="caption" color={palette.caution}>
                    {downloadNotice}
                  </AppText>
                ) : null}
                <ActionButton
                  label="Install from file"
                  tone="ghost"
                  busy={importing}
                  onPress={() => void importPack()}
                  accessibilityHint="Pick an MBTiles file from this device"
                />
              </View>

              {shareNotice ? (
                <AppText variant="caption" color={palette.caution}>
                  {shareNotice}
                </AppText>
              ) : null}

              <SectionLabel>Nearby and device</SectionLabel>
              <Card>
                <StatRow
                  label="Peers heard"
                  value={String(mesh.peers.length)}
                  severity={mesh.peers.length > 0 ? 'safe' : 'neutral'}
                />
                <StatRow
                  label="Open SOS alerts"
                  value={String(mesh.alerts.length)}
                  severity={mesh.alerts.length > 0 ? 'hazard' : 'neutral'}
                />
                <StatRow label="Battery" value={battery} />
                <StatRow label="Fix" value={describeFixAge(devices.location.updatedAt, now)} />
                {nearestPeer && self && nearestPeer.lastKnown ? (
                  <StatRow
                    label={`Nearest: ${nearestPeer.callsign}`}
                    value={`${formatDistance(distanceMeters(self, nearestPeer.lastKnown))} ${compassPoint(
                      initialBearingDeg(self, nearestPeer.lastKnown),
                    )}`}
                  />
                ) : (
                  <AppText variant="caption" color={palette.inkFaint}>
                    No peer has shared a position yet.
                  </AppText>
                )}
              </Card>

              <AppText variant="caption" color={palette.inkFaint}>
                Map data © Esri, HERE, Garmin, and OpenStreetMap contributors. Use this map for
                orientation, not as a substitute for local officials.
              </AppText>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function placeSourceLabel(source: PlaceResult['source']): string {
  switch (source) {
    case 'self':
      return 'YOUR LOCATION';
    case 'peer':
      return 'NEARBY PERSON';
    case 'sos':
      return 'OPEN SOS';
    case 'map':
      return 'OFFLINE MAP';
    case 'coordinate':
      return 'DROPPED PIN';
    case 'online':
      return 'OPENSTREETMAP';
  }
}

function SearchIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M16 16l5 5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function LayersIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M12 3l9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5"
        stroke={color}
        strokeWidth={1.8}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function LocateIcon({ color }: { color: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={7} stroke={color} strokeWidth={1.9} fill="none" />
      <Circle cx={12} cy={12} r={2.4} fill={color} />
      <Path
        d="M12 2v3M12 19v3M2 12h3M19 12h3"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M6 6l12 12M18 6L6 18"
        stroke={palette.inkMuted}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function ArrowIcon({ bearing }: { bearing: number }) {
  return (
    <Svg width={34} height={34} viewBox="0 0 34 34">
      <G transform={`rotate(${bearing} 17 17)`}>
        <Path d="M17 5l8 22-8-5-8 5 8-22z" fill={palette.jade} />
      </G>
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  mapWrap: { flex: 1, overflow: 'hidden' },
  fullBleed: { borderRadius: 0, borderWidth: 0 },

  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    gap: space.sm,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  searchBar: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: palette.surface,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    overflow: 'hidden',
    ...shadow,
  },
  searchPlaceholder: { flex: 1, color: palette.inkMuted, fontSize: 14 },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: palette.surface,
    borderRadius: radius.md,
    padding: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    overflow: 'hidden',
    ...shadow,
  },
  bannerCopy: { flex: 1, gap: 1 },
  bannerTitle: { color: palette.ink, fontSize: 12, fontWeight: '700' },
  bannerBody: { color: palette.inkMuted, fontSize: 11 },
  bannerAction: {
    color: palette.primaryText,
    fontSize: 12,
    fontWeight: '800',
    paddingHorizontal: space.xs,
  },

  zoomWrap: {
    position: 'absolute',
    right: space.md,
    bottom: 158,
    gap: space.xs,
  },
  zoomButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    overflow: 'hidden',
    ...shadow,
  },
  zoomLabel: { color: palette.ink, fontSize: 24, fontWeight: '600', lineHeight: 26 },
  locateFab: {
    position: 'absolute',
    right: space.md,
    bottom: 96,
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    overflow: 'hidden',
    ...shadow,
  },

  expansionToast: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
    ...shadow,
  },
  expansionText: { color: palette.ink, fontSize: 12, fontWeight: '600' },

  dockWrap: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.sm,
  },
  dock: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    padding: space.sm,
    ...shadow,
  },
  dockRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dockCopy: { flex: 1, gap: 1 },
  dockTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  dockSub: { color: palette.inkMuted, fontSize: 11 },
  layersButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: palette.primaryWash,
    overflow: 'hidden',
  },
  layersText: { color: palette.primaryText, fontSize: 13, fontWeight: '700' },

  centerNotice: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    top: '34%',
  },
  centerCard: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    padding: space.md,
    gap: space.sm,
    ...shadow,
  },

  navBanner: {
    position: 'absolute',
    top: 0,
    left: space.md,
    right: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    ...shadow,
  },
  navArrow: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: palette.jadeWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navCopy: { flex: 1, gap: 1 },
  navDistance: { color: palette.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  navInstruction: { color: palette.inkMuted, fontSize: 12, lineHeight: 16 },
  endButton: {
    minWidth: 52,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  endText: { color: palette.hazard, fontSize: 14, fontWeight: '800' },

  placeCard: {
    position: 'absolute',
    left: space.md,
    right: space.md,
    bottom: space.sm,
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    padding: space.md,
    gap: space.sm,
    ...shadow,
  },
  placeTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  placeCopy: { flex: 1, gap: 1 },
  placeKicker: {
    color: palette.primaryText,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  placeName: { color: palette.ink, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  placeSub: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  placeClose: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  placeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  placeDistance: { color: palette.inkMuted, fontSize: 12, fontWeight: '600' },
  routeHeadline: {
    color: palette.primaryText,
    fontSize: 12,
    fontWeight: '700',
    flexShrink: 1,
    textAlign: 'right',
  },
  placeNotice: {
    color: palette.caution,
    fontSize: 11,
    lineHeight: 16,
    backgroundColor: palette.cautionDim,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  placeActions: { flexDirection: 'row', gap: space.sm },
  placeAction: { flex: 1 },

  updateBlock: {
    backgroundColor: palette.cautionDim,
    borderRadius: radius.md,
    padding: space.sm,
    gap: space.xs,
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(24, 20, 16, 0.38)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '84%',
    backgroundColor: palette.canvas,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.sm,
    ...shadow,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  sheetTitle: { flex: 1, gap: 1 },
  close: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { gap: space.sm, paddingBottom: space.lg },
  packActions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  packButton: { flex: 1 },
  downloadBlock: { gap: space.xs, paddingTop: space.xs },
});
