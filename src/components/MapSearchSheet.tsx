/**
 * Google-style full-screen place search with an offline-first result list.
 * Address lookup is opt-in and only runs when the user submits a query; the
 * phone's own fix, peers, SOS alerts, map centre, and typed coordinates always
 * work without a connection.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';

import type { LatLon } from '../core/geo';
import { distanceMeters, formatDistance } from '../core/geo';
import type { Peer, SosAlert } from '../core/mesh/engine';
import {
  offlinePlaces,
  searchOnlinePlaces,
  type PlaceResult,
  type PlaceSource,
} from '../services/places';
import { hitSlop, palette, radius, shadow, space, type } from '../theme';
import { tapFeedback } from '../services/haptics';

const SOURCE_LABEL: Record<PlaceSource, string> = {
  self: 'GPS',
  peer: 'BT',
  sos: 'SOS',
  map: 'MAP',
  coordinate: 'PIN',
  online: 'OSM',
};

const SOURCE_COLOR: Record<PlaceSource, string> = {
  self: palette.jade,
  peer: palette.info,
  sos: palette.hazard,
  map: palette.inkMuted,
  coordinate: palette.primary,
  online: palette.info,
};

export function MapSearchSheet({
  visible,
  onClose,
  onSelect,
  self,
  peers,
  alerts,
  packCenter,
  packName,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (place: PlaceResult) => void;
  self: LatLon | null;
  peers: readonly Peer[];
  alerts: readonly SosAlert[];
  packCenter: LatLon | null;
  packName?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const [online, setOnline] = useState<PlaceResult[]>([]);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineTried, setOnlineTried] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setOnline([]);
    setOnlineBusy(false);
    setOnlineTried(false);
    const timer = setTimeout(() => inputRef.current?.focus(), 260);
    return () => clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    setOnline([]);
    setOnlineTried(false);
  }, [query]);

  const offline = useMemo(
    () =>
      offlinePlaces(query, {
        self,
        peers,
        alerts,
        packCenter,
        packName,
      }),
    [alerts, packCenter, packName, peers, query, self],
  );

  async function submit() {
    const text = query.trim();
    if (text.length < 2 || onlineBusy) return;
    setOnlineBusy(true);
    setOnlineTried(true);
    try {
      const found = await searchOnlinePlaces(text);
      setOnline(found);
    } finally {
      setOnlineBusy(false);
    }
  }

  function choose(place: PlaceResult) {
    tapFeedback();
    onSelect(place);
    onClose();
  }

  const showEmpty = query.trim().length >= 2 && !onlineBusy && onlineTried && offline.length === 0 && online.length === 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close search"
            hitSlop={hitSlop}
            android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
            onPress={onClose}
            style={({ pressed }) => [styles.back, { opacity: pressed ? 0.65 : 1 }]}
          >
            <BackIcon />
          </Pressable>
          <View style={styles.inputWrap}>
            <SearchIcon color={palette.inkMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={() => void submit()}
              placeholder="Search places or coordinates"
              placeholderTextColor={palette.inkFaint}
              ref={inputRef}
              style={styles.input}
              autoCorrect={false}
              returnKeyType="search"
              selectionColor={palette.primary}
              accessibilityLabel="Search places or coordinates"
            />
            {query.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                hitSlop={hitSlop}
                onPress={() => {
                  setQuery('');
                  setOnline([]);
                  setOnlineTried(false);
                }}
                style={styles.clear}
              >
                <Text style={styles.clearText}>×</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <KeyboardAvoidingView
          style={styles.body}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            showsVerticalScrollIndicator={false}
          >
            {offline.length > 0 ? (
              <>
                <Text style={styles.section}>{query.trim() ? 'On this phone' : 'Nearby'}</Text>
                {offline.map((place) => (
                  <PlaceRow
                    key={place.id}
                    place={place}
                    self={self}
                    onPress={() => choose(place)}
                  />
                ))}
              </>
            ) : null}

            {query.trim().length >= 2 ? (
              <>
                <View style={styles.sectionRow}>
                  <Text style={styles.section}>Online place search</Text>
                  {onlineBusy ? <ActivityIndicator size="small" color={palette.primary} /> : null}
                </View>
                {online.map((place) => (
                  <PlaceRow
                    key={place.id}
                    place={place}
                    self={self}
                    onPress={() => choose(place)}
                  />
                ))}
              </>
            ) : null}

            {showEmpty ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No match found</Text>
                <Text style={styles.emptyBody}>
                  Offline search covers your fix, nearby people, SOS alerts, map centre, and typed
                  coordinates. Address search needs a connection.
                </Text>
              </View>
            ) : null}

            {query.trim().length < 2 ? (
              <Text style={styles.hint}>
                Try a name, “37.422, -122.084”, or a nearby person. Address search runs online only
                when you press search.
              </Text>
            ) : null}

            <Text style={styles.privacy}>
              Online lookup uses OpenStreetMap Nominatim. KindMinds never sends your location with
              the query.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function PlaceRow({
  place,
  self,
  onPress,
}: {
  place: PlaceResult;
  self: LatLon | null;
  onPress: () => void;
}) {
  const distance = self ? distanceMeters(self, place.point) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${place.name}. ${place.subtitle}`}
      android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={[styles.source, { backgroundColor: `${SOURCE_COLOR[place.source]}14` }]}>
        <Text style={[styles.sourceText, { color: SOURCE_COLOR[place.source] }]}>
          {SOURCE_LABEL[place.source]}
        </Text>
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {place.name}
        </Text>
        <Text style={styles.rowSub} numberOfLines={2}>
          {place.subtitle}
        </Text>
      </View>
      {distance !== null ? (
        <Text style={styles.rowDistance}>{formatDistance(distance)}</Text>
      ) : null}
    </Pressable>
  );
}

function BackIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="M15 5l-7 7 7 7"
        stroke={palette.ink}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SearchIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={10.5} cy={10.5} r={6.5} stroke={color} strokeWidth={2} fill="none" />
      <Path d="M16 16l5 5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
    backgroundColor: palette.canvas,
    ...shadow,
  },
  back: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  inputWrap: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: palette.raised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
  },
  input: { flex: 1, color: palette.ink, fontSize: 16, paddingVertical: 0 },
  clear: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  clearText: { color: palette.inkMuted, fontSize: 24, lineHeight: 26 },
  body: { flex: 1 },
  content: { paddingBottom: space.xxl, gap: 0 },
  section: {
    ...type.caption,
    color: palette.inkMuted,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: space.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 64,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  source: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { color: palette.ink, fontSize: 16, fontWeight: '600' },
  rowSub: { color: palette.inkMuted, fontSize: 12, lineHeight: 17 },
  rowDistance: { color: palette.inkFaint, fontSize: 11, maxWidth: 64, textAlign: 'right' },
  empty: {
    margin: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: palette.raised,
    gap: space.xs,
  },
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: palette.inkMuted, fontSize: 13, lineHeight: 18 },
  hint: {
    color: palette.inkMuted,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  privacy: {
    color: palette.inkFaint,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
});
