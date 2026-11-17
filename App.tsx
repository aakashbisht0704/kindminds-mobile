/**
 * App shell.
 *
 * One `MeshEngine` and one GPS watcher for the whole app lifetime: they are
 * created here once and handed down as props, because a second engine would
 * mean a second identity and a second radio subscription.
 *
 * Navigation is a plain tab strip rather than a router. Five destinations is
 * under the threshold where a navigation library earns its dependency, and in a
 * disaster the tab strip stays short and the permanent SOS action carries a live
 * count of unacknowledged alerts from other people.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AssistantScreen } from './src/screens/AssistantScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { KitScreen } from './src/screens/KitScreen';
import { SosSheet } from './src/components/SosSheet';
import { MapScreen } from './src/screens/MapScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { useDevices, useMesh } from './src/state/useMesh';
import { getSetting, setSetting } from './src/services/storage';
import { installBundledModels } from './src/services/bundled-models';
import { KINDMINDS_LITE } from './src/config';
import { tapFeedback } from './src/services/haptics';
import { TabIcon, type TabIconName } from './src/components/TabIcon';
import { hitSlop, palette, radius, shadow, space, type } from './src/theme';

type TabId = 'assist' | 'map' | 'chat';

const TABS: readonly { id: TabId; label: string; icon: TabIconName }[] = [
  { id: 'assist', label: 'Assist', icon: 'aid' },
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
];

function Shell() {
  const mesh = useMesh();
  const devices = useDevices();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabId>('assist');
  const [chatThreadOpen, setChatThreadOpen] = useState(false);
  const [sosOpen, setSosOpen] = useState(false);
  const [kitOpen, setKitOpen] = useState(false);

  useEffect(() => {
    if (tab !== 'chat') setChatThreadOpen(false);
  }, [tab]);

  const { setPosition } = mesh;
  const selfLat = devices.location.point?.lat ?? null;
  const selfLon = devices.location.point?.lon ?? null;
  const accuracyM = devices.location.accuracyM;

  // Publish the smoothed fix so announcements and SOS stamps carry a real
  // position. Depend on the primitives, not the point object, or every GPS
  // jitter would re-run this effect against an identical coordinate.
  useEffect(() => {
    if (selfLat === null || selfLon === null) return;
    setPosition({ lat: selfLat, lon: selfLon }, accuracyM);
  }, [selfLat, selfLon, accuracyM, setPosition]);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.body}>
        {tab === 'map' ? (
          <MapScreen
            mesh={mesh}
            devices={devices}
            packVersion={mesh.receivedFiles.filter((file) => file.kind === 'map').length}
          />
        ) : null}
        {tab === 'chat' ? (
          <ChatScreen
            mesh={mesh}
            devices={devices}
            onThreadOpenChange={setChatThreadOpen}
          />
        ) : null}
        {tab === 'assist' ? (
          <AssistantScreen
            onOpenKit={() => setKitOpen(true)}
            onOpenSos={() => setSosOpen(true)}
            onOpenChat={() => setTab('chat')}
            onOpenMap={() => setTab('map')}
          />
        ) : null}
      </View>

      {tab === 'chat' && chatThreadOpen ? null : (
        <View style={[styles.tabBarWrap, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <View style={styles.tabBar}>
          {TABS.map((item) => {
            const active = item.id === tab;
            const color = active ? palette.accent : palette.inkMuted;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)' }}
                onPress={() => {
                  if (!active) tapFeedback();
                  setTab(item.id);
                }}
                style={({ pressed }) => [
                  styles.tab,
                  active && styles.tabActive,
                  { opacity: pressed ? 0.8 : 1, transform: [{ scale: pressed ? 0.96 : 1 }] },
                ]}
              >
                <TabIcon name={item.icon} color={color} size={22} />
                <Text style={[type.caption, { color, fontWeight: active ? '700' : '500' }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mesh.alertCount > 0 ? `Send SOS, ${mesh.alertCount} alerts nearby` : 'Send SOS'}
            onPress={() => {
              tapFeedback();
              setSosOpen(true);
            }}
            style={({ pressed }) => [styles.sosAction, { opacity: pressed ? 0.82 : 1, transform: [{ scale: pressed ? 0.95 : 1 }] }]}
          >
            <TabIcon name="sos" color={palette.surface} size={22} />
            <Text style={styles.sosLabel}>SOS</Text>
            {mesh.alertCount > 0 ? (
              <View style={styles.sosBadge}>
                <Text style={styles.badgeText}>{mesh.alertCount > 9 ? '9+' : mesh.alertCount}</Text>
              </View>
            ) : null}
          </Pressable>
          </View>
        </View>
      )}

      <SosSheet visible={sosOpen} mesh={mesh} devices={devices} onClose={() => setSosOpen(false)} />
      <Modal
        visible={kitOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setKitOpen(false)}
      >
        <KitScreen mesh={mesh} onClose={() => setKitOpen(false)} />
      </Modal>
    </View>
  );
}

function BootScreen() {
  return (
    <View style={styles.boot}>
      <View style={styles.bootMark}>
        <Text style={styles.bootLetter}>K</Text>
      </View>
      <Text style={styles.bootTitle}>KindMinds</Text>
    </View>
  );
}

function AppRoot() {
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  const [modelsReady, setModelsReady] = useState(KINDMINDS_LITE);

  useEffect(() => {
    let cancelled = false;
    void getSetting('onboarding.complete').then((value) => {
      if (!cancelled) setOnboarded(value === '1');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The full build ships Shruti and Mirage inside the APK. Onboarding copies
  // them out on first run; this also repairs an upgraded install that kept
  // `onboarding.complete` but never received the model files. The marker keeps
  // a deliberate "Remove both" from being undone on the next launch.
  useEffect(() => {
    if (KINDMINDS_LITE || onboarded !== true) return;
    let cancelled = false;
    void (async () => {
      try {
        const installed = (await getSetting('models.bundled.installed')) === '1';
        if (!installed) {
          await installBundledModels();
          await setSetting('models.bundled.installed', '1');
        }
      } catch (error) {
        // Try again next launch; the buttons report the missing model clearly.
        console.warn('[KindMinds] Bundled model install failed', error);
      } finally {
        if (!cancelled) setModelsReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onboarded]);

  if (onboarded === null || (onboarded && !modelsReady)) {
    return <BootScreen />;
  }

  if (!onboarded) {
    return (
      <OnboardingScreen
        onComplete={() => {
          void setSetting('onboarding.complete', '1');
          setOnboarded(true);
        }}
      />
    );
  }

  return <Shell />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppRoot />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  body: { flex: 1 },
  tabBarWrap: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    backgroundColor: palette.canvas,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: palette.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: palette.line,
    paddingHorizontal: space.xs,
    paddingVertical: 6,
    gap: space.xxs,
    ...shadow,
  },
  tab: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  tabActive: { backgroundColor: palette.accentWash },
  sosAction: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    backgroundColor: palette.hazard,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    ...shadow,
  },
  sosLabel: { color: palette.surface, fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },
  sosBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: palette.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: '16%',
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: palette.hazard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: palette.surface, fontSize: 10, fontWeight: '700' },
  boot: { flex: 1, backgroundColor: palette.canvas, alignItems: 'center', justifyContent: 'center', gap: space.md },
  bootMark: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: palette.primaryWash,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bootLetter: { color: palette.primaryText, fontSize: 30, fontWeight: '800' },
  bootTitle: { color: palette.ink, fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
});
