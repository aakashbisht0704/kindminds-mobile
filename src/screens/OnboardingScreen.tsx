/**
 * First launch.
 *
 * The full app leaves the factory with Shruti and Mirage already inside it, so
 * there is no voice/vision download in the field. This screen explains the
 * actual product, asks for a fresh GPS fix, downloads the local map, and copies
 * the included models into app storage. The text model is deliberately not here: it is a
 * 986 MB optional download from Prepare.
 */

import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { ActionButton, AppText, Card, ProgressBar } from '../components/ui';
import { formatCoordinate, type LatLon } from '../core/geo';
import { locateForMap } from '../services/location';
import { BUNDLED_BYTES, installBundledModels } from '../services/bundled-models';
import { MODEL_URLS } from '../services/downloads';
import { downloadRegionPack } from '../services/region-pack';
import { tapFeedback } from '../services/haptics';
import { KINDMINDS_LITE } from '../config';
import { palette, radius, space, type } from '../theme';

const SLIDES = [
  {
    title: 'The streets around you, offline.',
    body: 'A compact map of your area downloads once. Search, directions, and turn-by-turn guidance keep working without a signal.',
    preview: 'map' as const,
  },
  {
    title: 'Message the phones around you.',
    body: 'Rooms, direct messages, and map packs travel over Bluetooth. No tower, no account, no server.',
    preview: 'chat' as const,
  },
  {
    title: 'Ask by voice. Stay grounded.',
    body: 'Shruti turns speech into text on this phone. Answers come from approved offline records, never invented.',
    preview: 'assist' as const,
  },
  {
    title: 'Ready before the network goes.',
    body: 'Shruti and Mirage are already in this app. Add the Qwen2.5 text model later if you want answers in your own words.',
    preview: 'ready' as const,
  },
] as const;

type ProgressState = { map: number; models: number };

const INITIAL_PROGRESS: ProgressState = { map: 0, models: 0 };

function formatMb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function OnboardingScreen({ onComplete }: { onComplete: () => void }) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView | null>(null);
  const [step, setStep] = useState(0);
  const [downloadMap, setDownloadMap] = useState(true);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [setup, setSetup] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const slide = SLIDES[step] ?? SLIDES[0];
  const last = step === SLIDES.length - 1;
  const mapBytes = 8 * 1024 * 1024;

  const downloadLabel = useMemo(() => {
    if (KINDMINDS_LITE) return downloadMap ? 'About 8 MB to download' : 'No download selected';
    if (downloadMap) return `About 8 MB to download · ${formatMb(BUNDLED_BYTES)} included`;
    return `${formatMb(BUNDLED_BYTES)} included in this app`;
  }, [downloadMap]);

  function next() {
    if (!last) {
      setStep((current) => Math.min(SLIDES.length - 1, current + 1));
      scrollRef.current?.scrollTo({ y: 0, animated: true });
      return;
    }
    void runSetup();
  }

  function back() {
    setStep((current) => Math.max(0, current - 1));
    setError(null);
  }

  async function runSetup() {
    if (setup === 'running') return;
    setSetup('running');
    setError(null);
    setProgress(INITIAL_PROGRESS);
    setDetail(downloadMap ? 'Finding your location…' : 'Preparing the included models…');

    try {
      let center: LatLon | null = null;
      if (downloadMap) {
        const fix = await locateForMap(25_000, 30_000);
        center = fix?.point ?? null;
        if (!center) {
          throw new Error(
            'No location fix yet. Turn on GPS, move outside, and retry so the map matches where you are.',
          );
        }
        setDetail(
          `Found your area at ${formatCoordinate(center)}${fix?.accuracyM ? ` (±${Math.round(fix.accuracyM)} m)` : ''}. Downloading the local map…`,
        );
      }

      await Promise.all([
        downloadMap
          ? (async () => {
              const pack = await downloadRegionPack({
                center,
                onProgress: (fraction, text) => {
                  setProgress((current) => ({ ...current, map: fraction }));
                  setDetail(text);
                },
              });
              if (!pack) throw new Error('The map download did not complete.');
              setProgress((current) => ({ ...current, map: 1 }));
            })()
          : Promise.resolve(),
        KINDMINDS_LITE
          ? Promise.resolve()
          : installBundledModels((fraction, text) => {
              setProgress((current) => ({ ...current, models: fraction }));
              setDetail(text);
            }).then(() => {
              setProgress((current) => ({ ...current, models: 1 }));
            }),
      ]);

      setDetail(downloadMap ? 'Your offline kit is ready.' : 'The included models are ready.');
      setSetup('done');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (caught) {
      setSetup('error');
      setError(caught instanceof Error ? caught.message : 'Setup did not finish.');
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }]}>
      <View style={styles.topBar}>
        <View style={styles.wordmark}>
          <View style={styles.mark} />
          <Text style={styles.wordmarkText}>KindMinds</Text>
        </View>
        <Text style={styles.stepText}>{`${step + 1} / ${SLIDES.length}`}</Text>
      </View>

      <View style={styles.progress}>
        {SLIDES.map((candidate, index) => (
          <View
            key={candidate.title}
            style={[styles.progressSegment, index <= step && styles.progressSegmentOn]}
          />
        ))}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.content, !last && styles.slideContent]}
        showsVerticalScrollIndicator={false}
      >
        <SlidePreview kind={slide.preview} />

        <View style={styles.copy}>
          <AppText variant="display" style={styles.headline}>{slide.title}</AppText>
          <AppText variant="body" color={palette.inkMuted}>{slide.body}</AppText>
        </View>

        {last ? (
          <Card style={styles.setupCard}>
            <View style={styles.setupHead}>
              <View style={styles.setupTitleWrap}>
                <AppText variant="title">What installs now</AppText>
                <AppText variant="caption" color={palette.inkMuted}>{downloadLabel}</AppText>
              </View>
            </View>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: downloadMap }}
              accessibilityLabel="Download the local area map"
              onPress={() => {
                tapFeedback();
                setDownloadMap((value) => !value);
              }}
              style={({ pressed }) => [styles.installRow, { opacity: pressed ? 0.8 : 1 }]}
            >
              <View style={styles.installCopy}>
                <Text style={styles.installTitle}>Local area map</Text>
                <Text style={styles.installDetail}>
                  {`About ${formatMb(mapBytes)} · built around your current location`}
                </Text>
              </View>
              <View style={[styles.check, downloadMap && styles.checkOn]}>
                {downloadMap ? <Text style={styles.checkMark}>✓</Text> : null}
              </View>
            </Pressable>

      
            {!KINDMINDS_LITE ? (
              <View style={styles.includedList}>
                <IncludedRow kind="voice" title="Shruti voice" detail={`${formatMb(MODEL_URLS.voice.bytes)} · included`} />
                <IncludedRow kind="vision" title="Mirage vision" detail={`${formatMb(MODEL_URLS.vision.bytes)} · included`} />
              </View>
            ) : null}

            <Text style={styles.note}>
              {KINDMINDS_LITE
                ? 'This build uses approved records without on-device models.'
                : 'Qwen2.5 1.5B, the text model, can be downloaded later from Prepare.'}
            </Text>

            {setup === 'running' || setup === 'done' ? (
              <View style={styles.liveStatus}>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>{downloadMap ? 'Map' : 'Map skipped'}</Text>
                  <Text style={styles.statusValue}>{downloadMap ? `${Math.round(progress.map * 100)}%` : '—'}</Text>
                </View>
                {downloadMap ? <ProgressBar ratio={progress.map} severity="safe" /> : null}
                {!KINDMINDS_LITE ? (
                  <>
                    <View style={styles.statusRow}>
                      <Text style={styles.statusLabel}>Shruti + Mirage</Text>
                      <Text style={styles.statusValue}>{`${Math.round(progress.models * 100)}%`}</Text>
                    </View>
                    <ProgressBar ratio={progress.models} severity="safe" />
                  </>
                ) : null}
                <Text style={styles.detail}>{detail || 'Working…'}</Text>
              </View>
            ) : null}

            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.errorHint}>Retry, or skip and add the map from Layers later.</Text>
              </View>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>

      <View style={styles.footer}>
        {!last ? (
          <View style={styles.footerNav}>
            <View style={styles.footerBack}>
              {step > 0 ? (
                <Pressable accessibilityRole="button" onPress={back} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back</Text>
                </Pressable>
              ) : null}
            </View>
            <View style={styles.footerNext}>
              <ActionButton label="Next" onPress={next} />
            </View>
          </View>
        ) : (
          <>
            <ActionButton
              label={
                setup === 'done'
                  ? 'Open KindMinds'
                  : setup === 'running'
                    ? 'Setting up'
                    : setup === 'error'
                      ? 'Try again'
                      : downloadMap
                        ? 'Download map and continue'
                        : 'Finish setup'
              }
              busy={setup === 'running'}
              onPress={setup === 'done' ? onComplete : () => void runSetup()}
            />
            <View style={styles.footerLinks}>
              <Pressable
                accessibilityRole="button"
                disabled={setup === 'running' || setup === 'done'}
                onPress={back}
                style={styles.textButton}
              >
                <Text style={styles.textButtonLabel}>Back</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={setup === 'running' || setup === 'done'}
                onPress={setup === 'error' ? () => void runSetup() : onComplete}
                style={styles.textButton}
              >
                <Text style={styles.textButtonLabel}>
                  {setup === 'running' ? 'Keep this screen open' : 'Skip for now'}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

function IncludedRow({ kind, title, detail }: { kind: 'voice' | 'vision'; title: string; detail: string }) {
  return (
    <View style={styles.installRow}>
      <View style={styles.includedIcon}>
        <Text style={styles.includedGlyph}>{kind === 'voice' ? 'S' : 'M'}</Text>
      </View>
      <View style={styles.installCopy}>
        <Text style={styles.installTitle}>{title}</Text>
        <Text style={styles.installDetail}>{detail}</Text>
      </View>
      <Text style={styles.includedTag}>Included</Text>
    </View>
  );
}

function SlidePreview({ kind }: { kind: 'map' | 'chat' | 'assist' | 'ready' }) {
  if (kind === 'map') {
    return (
      <View style={[styles.preview, styles.mapPreview]}>
        <View style={[styles.road, { top: '28%', transform: [{ rotate: '-8deg' }] }]} />
        <View style={[styles.road, styles.roadMajor, { top: '52%' }]} />
        <View style={[styles.road, { top: '76%', transform: [{ rotate: '6deg' }] }]} />
        <View style={[styles.roadVertical, { left: '28%' }]} />
        <View style={[styles.roadVertical, { left: '68%' }]} />
        <View style={styles.mapPin}>
          <View style={styles.mapPinDot} />
        </View>
        <View style={styles.mapLabel}>
          <Text style={styles.mapLabelText}>You are here</Text>
        </View>
        <View style={styles.previewChrome}>
          <View style={styles.searchBar}>
            <View style={styles.searchDot} />
            <Text style={styles.searchText}>Search places or coordinates</Text>
          </View>
        </View>
      </View>
    );
  }

  if (kind === 'chat') {
    return (
      <View style={[styles.preview, styles.chatPreview]}>
        <View style={styles.previewChrome}>
          <Text style={styles.previewTitle}>Chat</Text>
          <Text style={styles.previewMeta}>2 people nearby</Text>
        </View>
        <View style={styles.personRow}>
          <View style={[styles.avatar, { backgroundColor: palette.accentWash }]}>
            <Text style={[styles.avatarText, { color: palette.accent }]}>J</Text>
          </View>
          <View style={styles.personCopy}>
            <Text style={styles.personName}>Jamal</Text>
            <Text style={styles.personMeta}>40 m away · Bluetooth</Text>
          </View>
          <View style={styles.bubbleSmall}>
            <Text style={styles.bubbleSmallText}>Water here</Text>
          </View>
        </View>
        <View style={styles.personRow}>
          <View style={[styles.avatar, { backgroundColor: palette.primaryWash }]}>
            <Text style={[styles.avatarText, { color: palette.primaryText }]}>M</Text>
          </View>
          <View style={styles.personCopy}>
            <Text style={styles.personName}>Mira</Text>
            <Text style={styles.personMeta}>120 m away · Bluetooth</Text>
          </View>
          <View style={styles.bubbleSmall}>
            <Text style={styles.bubbleSmallText}>On my way</Text>
          </View>
        </View>
        <View style={styles.previewComposer}>
          <Text style={styles.previewComposerText}>Message nearby people</Text>
          <View style={styles.miniSend}>
            <Text style={styles.miniSendText}>↑</Text>
          </View>
        </View>
      </View>
    );
  }

  if (kind === 'assist') {
    return (
      <View style={[styles.preview, styles.assistPreview]}>
        <View style={styles.previewChrome}>
          <Text style={styles.previewTitle}>Ask KindMinds</Text>
        </View>
        <View style={styles.userBubble}>
          <Text style={styles.userBubbleText}>I'm anxious</Text>
        </View>
        <Text style={styles.replyText}>
          Let’s slow this down. Breathe in for four, hold for two, out for six.
        </Text>
        <View style={styles.voiceRow}>
          <View style={styles.voiceButton}>
            <Text style={styles.voiceGlyph}>Voice</Text>
          </View>
          <Text style={styles.voiceCopy}>Tap to talk. Shruti works offline.</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.preview, styles.readyPreview]}>
      <View style={styles.previewChrome}>
        <Text style={styles.previewTitle}>Included offline</Text>
      </View>
      <ReadyLine title="Map" detail="Your area" />
      <ReadyLine title="Shruti" detail="Voice input" />
      <ReadyLine title="Mirage" detail="Photo descriptions" />
      <View style={styles.readyDivider} />
      <Text style={styles.readyFootnote}>Qwen2.5 1.5B is optional and can be added later.</Text>
    </View>
  );
}

function ReadyLine({ title, detail }: { title: string; detail: string }) {
  return (
    <View style={styles.readyLine}>
      <Text style={styles.readyTitle}>{title}</Text>
      <Text style={styles.readyDetail}>{detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas, paddingHorizontal: space.xl },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wordmark: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 10, height: 10, borderRadius: radius.pill, backgroundColor: palette.primary },
  wordmarkText: { color: palette.ink, fontSize: 15, fontWeight: '700', letterSpacing: -0.2 },
  stepText: { ...type.readout, color: palette.inkMuted, fontSize: 11 },
  progress: { flexDirection: 'row', gap: space.xs, marginTop: space.lg },
  progressSegment: { flex: 1, height: 3, borderRadius: radius.pill, backgroundColor: palette.line },
  progressSegmentOn: { backgroundColor: palette.ink },
  scroll: { flex: 1 },
  content: { gap: space.xl, paddingTop: space.xl, paddingBottom: space.lg, flexGrow: 1 },
  slideContent: { justifyContent: 'center' },
  preview: {
    height: 250,
    borderRadius: radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: palette.line,
  },
  mapPreview: { backgroundColor: '#E9E3D8', justifyContent: 'flex-end' },
  road: { position: 'absolute', left: '-10%', right: '-10%', height: 8, backgroundColor: palette.surface },
  roadMajor: { height: 14, backgroundColor: '#F7F3EC' },
  roadVertical: { position: 'absolute', top: 0, bottom: 0, width: 7, backgroundColor: palette.surface },
  mapPin: {
    position: 'absolute',
    left: '48%',
    top: '48%',
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: palette.accent,
    borderWidth: 4,
    borderColor: palette.surface,
  },
  mapPinDot: { flex: 1 },
  mapLabel: { position: 'absolute', left: space.md, bottom: 76, backgroundColor: palette.surface, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 6 },
  mapLabelText: { color: palette.ink, fontSize: 11, fontWeight: '600' },
  previewChrome: { padding: space.md, gap: space.xs },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: palette.surface, borderRadius: radius.md, paddingHorizontal: space.md, minHeight: 44 },
  searchDot: { width: 10, height: 10, borderRadius: radius.pill, borderWidth: 2, borderColor: palette.inkMuted },
  searchText: { color: palette.inkMuted, fontSize: 12 },
  chatPreview: { backgroundColor: palette.surface, gap: space.sm },
  previewTitle: { color: palette.ink, fontSize: 18, fontWeight: '700', letterSpacing: -0.2 },
  previewMeta: { color: palette.inkMuted, fontSize: 11 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md },
  avatar: { width: 38, height: 38, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontWeight: '700' },
  personCopy: { flex: 1, gap: 1 },
  personName: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  personMeta: { color: palette.inkMuted, fontSize: 11 },
  bubbleSmall: { backgroundColor: palette.raised, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: 6 },
  bubbleSmallText: { color: palette.inkMuted, fontSize: 10, fontWeight: '600' },
  previewComposer: { margin: space.md, marginTop: 'auto', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, backgroundColor: palette.raised, borderRadius: radius.md, paddingLeft: space.md, paddingRight: 4, minHeight: 44 },
  previewComposerText: { color: palette.inkMuted, fontSize: 12 },
  miniSend: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: palette.primary, alignItems: 'center', justifyContent: 'center' },
  miniSendText: { color: palette.surface, fontSize: 20, fontWeight: '600' },
  assistPreview: { backgroundColor: palette.surface, gap: space.sm },
  userBubble: { alignSelf: 'flex-end', marginHorizontal: space.md, backgroundColor: palette.primary, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  userBubbleText: { color: palette.surface, fontSize: 13, fontWeight: '600' },
  replyText: { marginHorizontal: space.md, color: palette.ink, fontSize: 14, lineHeight: 21 },
  voiceRow: { marginTop: 'auto', margin: space.md, flexDirection: 'row', alignItems: 'center', gap: space.sm, borderTopWidth: 1, borderTopColor: palette.line, paddingTop: space.md },
  voiceButton: { width: 52, height: 44, borderRadius: radius.pill, backgroundColor: palette.accentWash, alignItems: 'center', justifyContent: 'center' },
  voiceGlyph: { color: palette.accent, fontSize: 11, fontWeight: '700' },
  voiceCopy: { flex: 1, color: palette.inkMuted, fontSize: 11 },
  readyPreview: { backgroundColor: palette.surface, gap: space.sm, paddingTop: space.sm },
  readyLine: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: space.md, paddingVertical: space.sm, borderTopWidth: 1, borderTopColor: palette.line },
  readyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  readyDetail: { color: palette.inkMuted, fontSize: 12 },
  readyDivider: { height: 1, backgroundColor: palette.line, marginHorizontal: space.md },
  readyFootnote: { color: palette.inkMuted, fontSize: 11, paddingHorizontal: space.md, paddingBottom: space.md },
  copy: { gap: space.sm },
  headline: { color: palette.ink, maxWidth: '95%' },
  setupCard: { gap: space.md, padding: space.lg },
  setupHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm },
  setupTitleWrap: { flex: 1, gap: 2 },

  installRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 56 },
  installCopy: { flex: 1, gap: 2 },
  installTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  installDetail: { color: palette.inkMuted, fontSize: 11, lineHeight: 15 },
  check: { width: 28, height: 28, borderRadius: radius.pill, borderWidth: 1.5, borderColor: palette.lineStrong, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: palette.ink, borderColor: palette.ink },
  checkMark: { color: palette.surface, fontSize: 14, fontWeight: '700' },
  includedList: { gap: 0, borderTopWidth: 1, borderTopColor: palette.line },
  includedIcon: { width: 32, height: 32, borderRadius: radius.sm, backgroundColor: palette.raised, alignItems: 'center', justifyContent: 'center' },
  includedGlyph: { color: palette.accent, fontSize: 12, fontWeight: '700' },
  includedTag: { color: palette.safe, fontSize: 11, fontWeight: '700' },
  note: { color: palette.inkMuted, fontSize: 11, lineHeight: 16, borderTopWidth: 1, borderTopColor: palette.line, paddingTop: space.sm },
  liveStatus: { gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: palette.line },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusLabel: { color: palette.ink, fontSize: 12, fontWeight: '600' },
  statusValue: { ...type.readout, color: palette.inkMuted, fontSize: 11 },
  detail: { color: palette.inkMuted, fontSize: 11, lineHeight: 15, paddingTop: space.xs },
  errorBox: { backgroundColor: palette.hazardDim, borderRadius: radius.sm, padding: space.sm, gap: 2 },
  errorText: { color: palette.hazard, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  errorHint: { color: palette.inkMuted, fontSize: 11, lineHeight: 15 },
  footer: { gap: space.xs, paddingTop: space.sm },
  footerNav: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  footerBack: { flex: 1, alignItems: 'flex-start' },
  footerNext: { minWidth: 132 },
  footerLinks: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  textButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.xs },
  textButtonLabel: { color: palette.inkMuted, fontSize: 13, fontWeight: '600' },
});
