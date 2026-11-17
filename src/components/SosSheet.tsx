/**
 * One-tap SOS.
 *
 * Opening this sheet is the deliberate first tap; the large button below sends
 * immediately with a safe default (medical, one person, current position).
 * Details are optional and live below the send action, never in front of it.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { ActionButton, AppText, Card, Chip, Field } from './ui';
import { VoiceButton } from './VoiceButton';
import { formatCoordinate, formatDistance } from '../core/geo';
import { SOS_NEEDS, SOS_PRIORITY, type SosNeed } from '../core/mesh/protocol';
import type { SosAlert } from '../core/mesh/engine';
import { useModels } from '../state/useModels';
import type { DevicesApi, MeshApi } from '../state/useMesh';
import { tapFeedback } from '../services/haptics';
import { palette, radius, shadow, space } from '../theme';

const NEED_COPY: Record<SosNeed, string> = {
  medical: 'Medical',
  rescue: 'Rescue',
  water: 'Water',
  food: 'Food',
  shelter: 'Shelter',
  power: 'Power',
};

const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

export function SosSheet({
  visible,
  mesh,
  devices,
  onClose,
}: {
  visible: boolean;
  mesh: MeshApi;
  devices: DevicesApi;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const models = useModels();
  const [needs, setNeeds] = useState<SosNeed[]>(['medical']);
  const [people, setPeople] = useState(1);
  const [note, setNote] = useState('');
  const [details, setDetails] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentId, setSentId] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  const self = devices.location.point;
  const incoming = mesh.alerts.filter((alert) => !alert.mine);

  useEffect(() => {
    if (!visible) return;
    setSentId(null);
    setSending(false);
    setDetails(false);
  }, [visible]);

  function toggleNeed(need: SosNeed) {
    tapFeedback();
    setNeeds((current) =>
      current.includes(need)
        ? current.filter((candidate) => candidate !== need)
        : [...current, need].sort((a, b) => SOS_PRIORITY[a] - SOS_PRIORITY[b]),
    );
  }

  async function send() {
    if (sending) return;
    setSending(true);
    try {
      const id = await mesh.sendSos({
        people: Math.max(1, Math.min(99, people)),
        needs: needs.length > 0 ? needs : ['rescue'],
        note: note.trim().slice(0, 180),
      });
      setSentId(id);
      setDetails(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } finally {
      setSending(false);
    }
  }

  async function acknowledge(alert: SosAlert) {
    setAcking(alert.messageId);
    try {
      await mesh.acknowledge(alert);
    } finally {
      setAcking(null);
    }
  }

  const priority = needs.includes('medical') ? 'Medical' : NEED_COPY[needs[0] ?? 'rescue'];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.md }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Send SOS</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close SOS" hitSlop={space.sm} onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Card severity="hazard" style={styles.sendCard}>
            <AppText variant="title">Send now. Details can wait.</AppText>
            <AppText variant="body" color={palette.inkMuted}>
              {`${priority} · ${people} ${people === 1 ? 'person' : 'people'} · ${
                self ? 'location attached' : 'no GPS fix'
              }. Nearby phones relay it onward.`}
            </AppText>
            <ActionButton
              label={sending ? 'Sending SOS…' : sentId ? 'Send again' : 'Send SOS now'}
              tone="danger"
              busy={sending}
              onPress={() => void send()}
              accessibilityHint="Broadcasts immediately to nearby phones"
            />
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} hitSlop={space.sm} onPress={() => { tapFeedback(); setDetails((value) => !value); }} style={styles.detailsToggle}>
              <Text style={styles.detailsText}>{details ? 'Hide details' : 'Add details (optional)'}</Text>
            </Pressable>
            <Text style={styles.position}>{self ? formatCoordinate(self) : 'No position fix yet — the alert still travels.'}</Text>
            {sentId ? <Text style={styles.sent}>{`Alert ${sentId.slice(0, 8)} is out. Send it again every 20 minutes.`}</Text> : null}
          </Card>

          {details ? (
            <>
              <Text style={styles.section}>What do you need?</Text>
              <View style={styles.chips}>
                {SOS_NEEDS.map((need) => (
                  <Chip key={need} label={NEED_COPY[need]} selected={needs.includes(need)} severity={SOS_PRIORITY[need] <= 1 ? 'hazard' : 'caution'} onPress={() => toggleNeed(need)} />
                ))}
              </View>
              <View style={styles.stepperRow}>
                <Text style={styles.section}>People with you</Text>
                <View style={styles.stepper}>
                  <Pressable accessibilityRole="button" accessibilityLabel="One fewer person" disabled={people <= 1} onPress={() => { tapFeedback(); setPeople((value) => Math.max(1, value - 1)); }} style={[styles.stepButton, people <= 1 && styles.stepDisabled]}>
                    <Text style={styles.stepText}>−</Text>
                  </Pressable>
                  <Text style={styles.people}>{people}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="One more person" disabled={people >= 99} onPress={() => { tapFeedback(); setPeople((value) => Math.min(99, value + 1)); }} style={styles.stepButton}>
                    <Text style={styles.stepText}>+</Text>
                  </Pressable>
                </View>
              </View>
              <Field
                label="Note"
                value={note}
                onChangeText={setNote}
                placeholder="Second floor, stairwell collapsed, can hear voices"
                multiline
                maxLength={180}
                hint="Anything a rescuer needs. Optional."
                trailing={<VoiceButton enabled={Boolean(models.voice)} onTranscript={(text) => setNote(text.slice(0, 180))} compact />}
              />
              <ActionButton label="Send with these details" tone="danger" busy={sending} onPress={() => void send()} />
            </>
          ) : null}

          <View style={styles.incomingHead}>
            <Text style={styles.section}>Incoming alerts</Text>
            <Text style={[styles.incomingCount, incoming.length > 0 && styles.incomingCountActive]}>
              {incoming.length === 0 ? 'None' : `${incoming.length} nearby`}
            </Text>
          </View>
          {incoming.length === 0 ? (
            <Text style={styles.empty}>No alerts from nearby phones.</Text>
          ) : (
            incoming.map((alert) => {
              const point = { lat: alert.payload.lat, lon: alert.payload.lon };
              const distance =
                self && (point.lat !== 0 || point.lon !== 0)
                  ? formatDistance(
                      Math.hypot(
                        (point.lat - self.lat) * 111_320,
                        (point.lon - self.lon) * 111_320 * Math.cos((self.lat * Math.PI) / 180),
                      ),
                    )
                  : null;
              return (
                <Card key={alert.messageId} severity="hazard" style={styles.alert}>
                  <View style={styles.alertHead}>
                    <AppText variant="title" numberOfLines={1}>{alert.senderCallsign}</AppText>
                    <Text style={styles.alertTime}>{timeFormat.format(new Date(alert.receivedAt))}</Text>
                  </View>
                  <Text style={styles.alertNeeds}>
                    {alert.payload.needs.map((need) => NEED_COPY[need]).join(' · ') || 'Unspecified'} · {alert.payload.people} {alert.payload.people === 1 ? 'person' : 'people'}{distance ? ` · ${distance}` : ''}
                  </Text>
                  {alert.payload.note ? <AppText variant="body">{alert.payload.note}</AppText> : null}
                  <ActionButton
                    label={alert.acknowledgedBy.length > 0 ? `Acknowledged by ${alert.acknowledgedBy.length}` : 'I can help'}
                    tone="ghost"
                    busy={acking === alert.messageId}
                    disabled={alert.acknowledgedBy.length > 0}
                    onPress={() => void acknowledge(alert)}
                  />
                </Card>
              );
            })
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingBottom: space.md },
  title: { color: palette.ink, fontSize: 30, lineHeight: 34, fontWeight: '800', letterSpacing: -0.7 },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm, borderRadius: radius.pill, overflow: 'hidden' },
  closeText: { color: palette.inkMuted, fontSize: 14, fontWeight: '700' },
  scroll: { flex: 1 },
  content: { gap: space.md, paddingHorizontal: space.lg, paddingBottom: space.xxl },
  sendCard: { gap: space.md, ...shadow },
  detailsToggle: { minHeight: 44, justifyContent: 'center' },
  detailsText: { color: palette.accent, fontSize: 13, fontWeight: '600' },
  position: { color: palette.inkMuted, fontSize: 11 },
  sent: { color: palette.safe, fontSize: 12, fontWeight: '700' },
  section: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  stepperRow: { gap: space.xs },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  stepButton: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  stepDisabled: { opacity: 0.35 },
  stepText: { color: palette.ink, fontSize: 24, fontWeight: '600' },
  people: { minWidth: 40, textAlign: 'center', color: palette.ink, fontSize: 22, fontWeight: '800' },
  incomingHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm },
  incomingCount: { color: palette.inkMuted, fontSize: 12, fontWeight: '600' },
  incomingCountActive: { color: palette.hazard, fontWeight: '700' },
  empty: { color: palette.inkMuted, fontSize: 13 },
  alert: { gap: space.sm },
  alertHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  alertTime: { color: palette.inkFaint, fontSize: 11 },
  alertNeeds: { color: palette.hazard, fontSize: 12, fontWeight: '700' },
});
