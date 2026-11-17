/**
 * Kit screen: the 72-hour checklist, plus the two settings that matter in a
 * disaster (who you are on the mesh, and how to wipe the phone).
 *
 * The checklist is persisted item by item so a half-packed kit survives an app
 * kill. Every item carries its reason inline: a checklist that does not explain
 * itself gets dismissed.
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  ActionButton,
  AppText,
  Card,
  CheckButton,
  Divider,
  Field,
  ProgressBar,
  Readout,
  Screen,
  ScreenHeader,
  SectionLabel,
  StatRow,
} from '../components/ui';
import { ModelManager } from '../components/ModelManager';
import {
  GROUP_LABELS,
  KIT_GROUPS,
  KIT_ITEMS,
  kitProgress,
  type KitGroup,
} from '../core/preparedness';
import { eraseAllData, loadChecklist, setChecklistItem } from '../services/storage';
import type { MeshApi } from '../state/useMesh';
import { palette, radius, space } from '../theme';

const KIT_PRIORITY: Record<string, number> = {
  'water-3l': 1,
  'water-filter': 2,
  'first-aid': 3,
  meds: 4,
  torch: 5,
  powerbank: 6,
  blanket: 7,
  whistle: 8,
};

function priorityOf(itemId: string): number {
  return KIT_PRIORITY[itemId] ?? 99;
}

export function KitScreen({ mesh, onClose }: { mesh: MeshApi; onClose?: () => void }) {
  const [packed, setPacked] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [callsignDraft, setCallsignDraft] = useState(mesh.callsign);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showDevice, setShowDevice] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadChecklist().then((stored) => {
      if (cancelled) return;
      setPacked(stored);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The persisted callsign arrives after the first render, so seed the field
  // once it lands without stomping what the user is already typing.
  useEffect(() => {
    setCallsignDraft((current) => (current.length === 0 ? mesh.callsign : current));
  }, [mesh.callsign]);

  const progress = kitProgress(packed);
  const nextItems = KIT_ITEMS.filter((item) => packed[item.id] !== true)
    .slice()
    .sort((left, right) => priorityOf(left.id) - priorityOf(right.id))
    .slice(0, 3);

  function toggle(itemId: string) {
    const next = packed[itemId] !== true;
    setPacked((current) => ({ ...current, [itemId]: next }));
    void setChecklistItem(itemId, next);
  }

  async function wipe() {
    setWiping(true);
    try {
      await eraseAllData();
      setPacked({});
      setConfirmWipe(false);
    } finally {
      setWiping(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Prepare"
        subtitle="Three essentials first. The full list is here when you need it."
        trailing={
          onClose ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Close prepare" hitSlop={space.sm} onPress={onClose} style={styles.done}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          ) : null
        }
      />

      <Card>
        <StatRow
          label="Packed"
          value={`${progress.packed} of ${progress.total}`}
          severity={progress.ratio === 1 ? 'safe' : 'caution'}
        />
        <ProgressBar ratio={progress.ratio} severity="safe" />
        {!loaded ? (
          <AppText variant="caption" color={palette.inkFaint}>
            Loading saved checklist.
          </AppText>
        ) : null}
      </Card>

      {nextItems.length > 0 ? (
        <Card style={styles.nextCard}>
          <AppText variant="title">Do these next</AppText>
          <AppText variant="caption" color={palette.inkMuted}>
            These give the biggest safety gain. Tap when each is packed.
          </AppText>
          {nextItems.map((item) => (
            <View key={item.id} style={styles.itemRow}>
              <View style={styles.itemText}>
                <AppText variant="body">{item.label}</AppText>
                <AppText variant="caption" color={palette.inkFaint}>{item.why}</AppText>
              </View>
              <CheckButton checked={packed[item.id] === true} onPress={() => toggle(item.id)} label={`${item.label}. Packed`} />
            </View>
          ))}
        </Card>
      ) : (
        <Card severity="safe">
          <AppText variant="title">You are prepared.</AppText>
          <AppText variant="body" color={palette.inkMuted}>
            Every item on the list is packed. Keep the phone charged and the offline map installed.
          </AppText>
        </Card>
      )}

      <ActionButton
        label={showAll ? 'Hide full checklist' : `Show full checklist (${progress.total} items)`}
        tone="ghost"
        onPress={() => setShowAll((current) => !current)}
      />

      {showAll ? KIT_GROUPS.map((group: KitGroup) => {
        const items = KIT_ITEMS.filter((item) => item.group === group);
        if (items.length === 0) return null;
        const groupPacked = items.filter((item) => packed[item.id] === true).length;
        return (
          <View key={group} style={styles.group}>
            <View style={styles.groupHead}>
              <SectionLabel>{GROUP_LABELS[group]}</SectionLabel>
              <Readout size={11} color={palette.inkFaint}>
                {`${groupPacked}/${items.length}`}
              </Readout>
            </View>
            {items.map((item) => {
              const checked = packed[item.id] === true;
              return (
                <Card key={item.id} severity={checked ? 'safe' : undefined}>
                  <View style={styles.itemRow}>
                    <View style={styles.itemText}>
                      <AppText variant="body" color={checked ? palette.inkMuted : palette.ink}>
                        {item.label}
                      </AppText>
                      <AppText variant="caption" color={palette.inkFaint}>
                        {item.why}
                      </AppText>
                    </View>
                    <CheckButton
                      checked={checked}
                      onPress={() => toggle(item.id)}
                      label={`${item.label}. ${checked ? 'Packed' : 'Not packed'}`}
                    />
                  </View>
                </Card>
              );
            })}
          </View>
        );
      }) : null}

      <SectionLabel>On-device models</SectionLabel>
      <ModelManager />

      <ActionButton
        label={showDevice ? 'Hide device and data' : 'Device and data'}
        tone="ghost"
        onPress={() => setShowDevice((current) => !current)}
      />
      {showDevice ? (
        <>
      <SectionLabel>Mesh identity</SectionLabel>
      <Card>
        <Field
          label="Your callsign"
          value={callsignDraft}
          onChangeText={setCallsignDraft}
          placeholder="e.g. Ana, blue tent"
          maxLength={24}
          hint="Shown to neighbours instead of your node id. Keep it recognisable."
        />
        <ActionButton
          label="Save callsign"
          tone="ghost"
          disabled={callsignDraft.trim().length === 0}
          onPress={() => mesh.setCallsign(callsignDraft)}
        />
        <Divider />
        <StatRow label="Node id" value={mesh.peerId ? mesh.peerId.slice(0, 12) : 'starting'} />
        <StatRow label="Radio" value={mesh.radio} />
        <StatRow
          label="Links"
          value={`${mesh.linkCount} open · ${mesh.peers.length} announced`}
        />
        <StatRow
          label="Frames out / in"
          value={`${mesh.sentFrames} / ${mesh.receivedFrames}`}
        />
        {mesh.radioError ? <StatRow label="Last radio note" value={mesh.radioError} /> : null}
      </Card>

      <SectionLabel>Data</SectionLabel>
      <Card severity={confirmWipe ? 'hazard' : undefined}>
        <AppText variant="body" color={palette.inkMuted}>
          Everything this app stores lives on this phone. Erasing removes the mesh history, peer list,
          checklist, and this device's identity, which cannot be recovered.
        </AppText>
        {confirmWipe ? (
          <>
            <AppText variant="body" color={palette.hazard}>
              This is irreversible. The identity is destroyed, so neighbours will see a new node id.
            </AppText>
            <ActionButton
              label="Erase everything"
              tone="danger"
              busy={wiping}
              onPress={() => void wipe()}
            />
            <ActionButton label="Cancel" tone="ghost" onPress={() => setConfirmWipe(false)} />
          </>
        ) : (
          <ActionButton
            label="Erase all data"
            tone="ghost"
            onPress={() => setConfirmWipe(true)}
            accessibilityHint="Asks for a second confirmation before deleting anything"
          />
        )}
      </Card>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  done: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.pill, overflow: 'hidden' },
  doneText: { color: palette.accent, fontSize: 14, fontWeight: '600' },
  nextCard: { gap: space.md },
  group: { gap: space.sm },
  groupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  itemText: { flex: 1, gap: space.xxs },
});
