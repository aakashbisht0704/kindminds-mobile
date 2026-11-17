/**
 * Chat: the BitChat-style mesh, presented the way people already know how to
 * use a messenger.
 *
 * The list is rooms plus people in range. A thread is either a broadcast room
 * or an end-to-end sealed direct conversation. The radio engine underneath is
 * the same one the mesh tests exercise: store locally, relay with a TTL, split
 * large files, and verify every received file with SHA-256.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
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
import { File } from 'expo-file-system';
import Svg, { Path } from 'react-native-svg';

import { ActionButton, EmptyState, Pill, ProgressBar } from '../components/ui';
import { VoiceButton } from '../components/VoiceButton';
import {
  buildDmSummaries,
  CHAT_ROOMS,
  dmTimeline,
  dayLabel,
  lastForDm,
  lastForRoom,
  previewText,
  roomTimeline,
  sortPeersByProximity,
  type ChatRoomId,
} from '../core/chat';
import { compassPoint, distanceMeters, formatDistance, initialBearingDeg } from '../core/geo';
import { MAX_FILE_BYTES } from '../core/mesh/protocol';
import type { InboxMessage, Peer } from '../core/mesh/engine';
import { formatPackSize, listPacks, type MapPack } from '../services/tile-pack';
import type { RadioState } from '../services/ble-mesh';
import { useModels } from '../state/useModels';
import type { DevicesApi, MeshApi } from '../state/useMesh';
import { tapFeedback } from '../services/haptics';
import { useKeyboardVisible } from '../hooks/useKeyboardVisible';
import { hitSlop, palette, radius, shadow, severityColor, space, type Severity } from '../theme';

const RADIO_COPY: Record<
  RadioState,
  { text: string; detail: string; severity: Severity }
> = {
  off: {
    text: 'radio off',
    severity: 'caution',
    detail: 'Bluetooth is off. Switch it on to hear nearby people.',
  },
  unauthorized: {
    text: 'permission denied',
    severity: 'hazard',
    detail: 'Bluetooth permission was refused. Grant it in system settings.',
  },
  unsupported: {
    text: 'unsupported',
    severity: 'hazard',
    detail: 'This device has no usable Bluetooth LE radio.',
  },
  scanning: {
    text: 'scanning only',
    severity: 'caution',
    detail: 'This phone could not advertise, so others cannot find it. It can still hear links it starts.',
  },
  ready: {
    text: 'ready',
    severity: 'safe',
    detail: 'Bluetooth is up and advertising. Messages move to every linked phone.',
  },
  error: {
    text: 'radio error',
    severity: 'hazard',
    detail: 'The Bluetooth stack reported an error. Toggling airplane mode usually clears it.',
  },
};

const PEER_SEVERITY: Record<Peer['status'], Severity> = {
  ok: 'safe',
  injured: 'caution',
  trapped: 'hazard',
  assisting: 'info',
};

const timeFormat = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

type Thread = { type: 'room'; id: ChatRoomId } | { type: 'dm'; peerId: string };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function roomLabel(id: string): string {
  return CHAT_ROOMS.find((room) => room.id === id)?.label ?? id;
}

function lastPreview(message: InboxMessage | null, selfId: string | null): string | null {
  if (!message) return null;
  if (message.senderId === selfId) return `You: ${previewText(message)}`;
  return `${message.senderCallsign.split(' ')[0] ?? message.senderCallsign}: ${previewText(message)}`;
}

export function ChatScreen({
  mesh,
  devices,
  onThreadOpenChange,
}: {
  mesh: MeshApi;
  devices: DevicesApi;
  onThreadOpenChange?: (open: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const models = useModels();
  const [thread, setThread] = useState<Thread | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachView, setAttachView] = useState<'menu' | 'packs'>('menu');
  const [packs, setPacks] = useState<MapPack[]>([]);
  const [sharingPack, setSharingPack] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  const radio = RADIO_COPY[mesh.radio];
  const self = devices.location.point;
  const dmSummaries = useMemo(
    () => buildDmSummaries(mesh.messages, mesh.peers, mesh.peerId),
    [mesh.messages, mesh.peers, mesh.peerId],
  );
  const activeIds = useMemo(() => new Set(mesh.peers.map((peer) => peer.peerId)), [mesh.peers]);
  const pastDms = dmSummaries.filter((summary) => !activeIds.has(summary.peerId));
  const nearbyPeers = useMemo(() => sortPeersByProximity(mesh.peers, self), [mesh.peers, self]);
  const pinnedRoom = CHAT_ROOMS[0];
  const pinnedLast = lastForRoom(mesh.messages, pinnedRoom.id);

  const activePeer =
    thread?.type === 'dm'
      ? (mesh.peers.find((peer) => peer.peerId === thread.peerId) ?? null)
      : null;
  const historyPeer =
    thread?.type === 'dm'
      ? (dmSummaries.find((summary) => summary.peerId === thread.peerId) ?? null)
      : null;
  const threadTitle =
    thread?.type === 'room'
      ? `# ${roomLabel(thread.id).toLowerCase()}`
      : (activePeer?.callsign ?? historyPeer?.callsign ?? 'Direct message');
  const canSend = thread?.type === 'room' ? true : Boolean(activePeer?.boxPublicKey);

  const threadMessages = useMemo(() => {
    if (!thread) return [];
    return thread.type === 'room'
      ? roomTimeline(mesh.messages, thread.id)
      : dmTimeline(mesh.messages, thread.peerId);
  }, [mesh.messages, thread]);

  const closeThread = useCallback(() => {
    setThread(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    onThreadOpenChange?.(thread !== null);
  }, [onThreadOpenChange, thread]);

  useEffect(
    () => () => {
      onThreadOpenChange?.(false);
    },
    [onThreadOpenChange],
  );

  useEffect(() => {
    if (!thread) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeThread();
      return true;
    });
    return () => subscription.remove();
  }, [closeThread, thread]);

  useEffect(() => {
    if (!thread) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 60);
    return () => clearTimeout(timer);
  }, [thread, threadMessages.length]);

  const openRoom = useCallback((id: ChatRoomId) => {
    setThread({ type: 'room', id });
    setDraft('');
    setNotice(null);
  }, []);

  const openDm = useCallback((peerId: string) => {
    setThread({ type: 'dm', peerId });
    setDraft('');
    setNotice(null);
  }, []);

  async function announce() {
    setAnnouncing(true);
    try {
      const sent = await mesh.announce();
      setNotice(
        sent === 0
          ? 'No Bluetooth link is open yet, so nobody heard that. Keep both phones close and this screen open.'
          : `Presence sent to ${sent} link${sent === 1 ? '' : 's'}.`,
      );
    } finally {
      setAnnouncing(false);
    }
  }

  async function send() {
    if (!thread) return;
    const text = draft.trim();
    if (text.length === 0) return;
    setSending(true);
    try {
      let delivered = 0;
      if (thread.type === 'room') {
        delivered = await mesh.sendBroadcast(text, thread.id);
      } else {
        const id = await mesh.sendDirect(text, thread.peerId);
        delivered = id ? 1 : 0;
      }
      setDraft('');
      setNotice(
        delivered === 0
          ? 'Saved locally. It will travel when another node is in range.'
          : thread.type === 'dm'
            ? 'Sealed and sent.'
            : `Sent to ${delivered} link${delivered === 1 ? '' : 's'}.`,
      );
    } finally {
      setSending(false);
    }
  }

  async function shareLocation() {
    if (!thread) return;
    setAttachOpen(false);
    const sent = await mesh.sendLocation(
      thread.type === 'room' ? thread.id : 'general',
      thread.type === 'dm' ? thread.peerId : undefined,
    );
    setNotice(
      sent
        ? thread.type === 'dm'
          ? 'Location addressed to this peer. It is on their map.'
          : `Location shared in #${roomLabel(thread.id).toLowerCase()}.`
        : 'No position fix yet.',
    );
  }

  async function shareFile() {
    if (!thread) return;
    setAttachOpen(false);
    try {
      const picked = await File.pickFileAsync(undefined, '*/*');
      const first = Array.isArray(picked) ? picked[0] : picked;
      if (!first) return;
      const name = decodeURIComponent(first.uri.split('/').pop() || 'shared-file');
      const size = first.size ?? 0;
      if (size > MAX_FILE_BYTES) {
        setNotice(`Files are limited to ${formatBytes(MAX_FILE_BYTES)} over Bluetooth.`);
        return;
      }
      const lower = name.toLowerCase();
      const mime = lower.endsWith('.mbtiles')
        ? 'application/vnd.mapbox-vector-tile'
        : lower.endsWith('.png')
          ? 'image/png'
          : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
            ? 'image/jpeg'
            : 'application/octet-stream';
      const targetRoom = thread.type === 'room' ? thread.id : 'maps';
      if (thread.type === 'dm') {
        setNotice('Files are shared in #maps. Direct file transfer is not sealed yet.');
      }
      const sent = await mesh.shareFile(first.uri, name, mime, targetRoom);
      setNotice(
        sent > 0
          ? `${name} queued for the mesh.`
          : 'No peer link is open. The file was not sent.',
      );
    } catch {
      setNotice('Could not read that file.');
    }
  }

  async function sharePack(pack: MapPack) {
    if (!thread) return;
    setAttachOpen(false);
    setSharingPack(pack.name);
    setNotice(
      thread.type === 'dm'
        ? `Sending ${pack.name} in #maps. Direct file transfer is not sealed yet.`
        : `Sending ${pack.name}. Keep the app open…`,
    );
    try {
      const sent = await mesh.shareFile(
        pack.uri,
        pack.name,
        'application/vnd.mapbox-vector-tile',
        'maps',
      );
      setNotice(
        sent > 0
          ? `${pack.name} queued for the mesh.`
          : 'No peer link is open. The pack was not sent.',
      );
    } finally {
      setSharingPack(null);
    }
  }

  function openAttach() {
    setAttachView('menu');
    setAttachOpen(true);
    void listPacks().then(setPacks);
  }

  if (!thread) {
    return (
      <View style={styles.root}>
        <View style={[styles.listHeader, { paddingTop: insets.top + space.sm }]}>
          <View style={styles.headerCopy}>
            <Text style={styles.listTitle}>Chat</Text>
            <Text style={styles.listSub} numberOfLines={1}>
              {mesh.peers.length === 0
                ? mesh.linkCount > 0
                  ? `${mesh.linkCount} Bluetooth link${mesh.linkCount === 1 ? '' : 's'} · waiting for presence`
                  : 'No one in range yet'
                : `${mesh.peers.length} nearby · ${mesh.linkCount} link${mesh.linkCount === 1 ? '' : 's'}`}
            </Text>
          </View>
        </View>

        <ScrollView
          style={styles.listScroll}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          {mesh.radio !== 'ready' ? (
            <View style={styles.noticeBar}>
              <Text style={styles.noticeText}>{radio.detail}</Text>
            </View>
          ) : null}
          {notice ? (
            <View style={styles.noticeBar}>
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Pinned room</Text>
          </View>
          <View style={styles.rows}>
            {CHAT_ROOMS.slice(0, 1).map((room) => {
              const last = lastForRoom(mesh.messages, room.id);
              return (
                <ChatRow
                  key={room.id}
                  avatar="#"
                  avatarColor={palette.primaryWash}
                  avatarColorText={palette.primaryText}
                  title={`# ${room.label.toLowerCase()}`}
                  subtitle={
                    lastPreview(last, mesh.peerId) ??
                    last?.text ??
                    room.description
                  }
                  meta={last ? timeFormat.format(new Date(last.receivedAt)) : ''}
                  onPress={() => openRoom(room.id)}
                />
              );
            })}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Closest to you</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Announce my presence"
              disabled={announcing}
              hitSlop={space.sm}
              android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
              onPress={() => {
                tapFeedback();
                void announce();
              }}
              style={({ pressed }) => [styles.sectionActionButton, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={styles.sectionAction}>
                {announcing ? 'Announcing…' : 'Announce'}
              </Text>
            </Pressable>
          </View>

          {mesh.peers.length === 0 ? (
            <View style={styles.emptyPeople}>
              <Text style={styles.emptyTitle}>
                {mesh.linkCount > 0 ? 'Link open, waiting for a name' : 'Nobody in range yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {mesh.linkCount > 0
                  ? `This phone is linked to ${mesh.linkCount} ${mesh.linkCount === 1 ? 'phone' : 'phones'} but has not received an announcement yet. Presence is re-sent every 15 seconds, so keep both screens open for a moment.`
                  : 'No Bluetooth link yet. Both phones need Bluetooth on, permissions granted, and this screen open. A link usually appears within a few seconds of the two phones seeing each other.'}
              </Text>
              <ActionButton
                label="Announce my presence"
                tone="ghost"
                busy={announcing}
                onPress={() => void announce()}
              />
            </View>
          ) : (
            <View style={styles.rows}>
              {nearbyPeers.map((peer) => {
                const last = lastForDm(mesh.messages, peer.peerId);
                const distance =
                  self && peer.lastKnown ? distanceMeters(self, peer.lastKnown) : null;
                const bearing =
                  self && peer.lastKnown ? initialBearingDeg(self, peer.lastKnown) : null;
                const fallback =
                  distance !== null && bearing !== null
                    ? `${peer.status} · ${formatDistance(distance)} ${compassPoint(bearing)}`
                    : `${peer.status} · ${peer.hops} hop${peer.hops === 1 ? '' : 's'}`;
                return (
                  <ChatRow
                    key={peer.peerId}
                    avatar={initials(peer.callsign)}
                    avatarColor={palette.raised}
                    avatarColorText={palette.inkMuted}
                    statusColor={severityColor[PEER_SEVERITY[peer.status]]}
                    title={peer.callsign}
                    subtitle={lastPreview(last, mesh.peerId) ?? fallback}
                    meta={
                      distance !== null
                        ? formatDistance(distance)
                        : last
                          ? timeFormat.format(new Date(last.receivedAt))
                          : peer.status
                    }
                    onPress={() => openDm(peer.peerId)}
                  />
                );
              })}
            </View>
          )}

          <View style={styles.roomChips}>
            {CHAT_ROOMS.slice(1).map((room) => (
              <Pressable
                key={room.id}
                accessibilityRole="button"
                accessibilityLabel={`Open room ${room.label}`}
                android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
                onPress={() => {
                  tapFeedback();
                  openRoom(room.id);
                }}
                style={({ pressed }) => [styles.roomChip, { opacity: pressed ? 0.7 : 1 }]}
              >
                <Text style={styles.roomChipText}># {room.label.toLowerCase()}</Text>
              </Pressable>
            ))}
          </View>

          {pastDms.length > 0 ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showPast }}
                hitSlop={space.sm}
                onPress={() => {
                  tapFeedback();
                  setShowPast((current) => !current);
                }}
                style={styles.pastToggle}
              >
                <Text style={styles.sectionTitle}>
                  {showPast ? 'Hide past conversations' : `Past conversations (${pastDms.length})`}
                </Text>
                <Text style={styles.sectionAction}>{showPast ? 'Hide' : 'Show'}</Text>
              </Pressable>
              {showPast ? <View style={styles.rows}>
                {pastDms.map((summary) => (
                  <ChatRow
                    key={summary.peerId}
                    avatar={initials(summary.callsign)}
                    avatarColor={palette.raised}
                    avatarColorText={palette.inkFaint}
                    title={summary.callsign}
                    subtitle={previewText(summary.last)}
                    meta="offline"
                    onPress={() => openDm(summary.peerId)}
                  />
                ))}
              </View> : null}
            </>
          ) : null}

          <Text style={styles.footer}>
            {mesh.radio === 'ready'
              ? `${mesh.peers.length} nearby · ${mesh.linkCount} link${mesh.linkCount === 1 ? '' : 's'} · ${mesh.messages.length} message${mesh.messages.length === 1 ? '' : 's'}`
              : radio.text}
          </Text>
        </ScrollView>
      </View>
    );
  }

  const roomDescription =
    thread.type === 'room'
      ? (CHAT_ROOMS.find((room) => room.id === thread.id)?.description ?? '')
      : '';
  const threadSubtitle =
    thread.type === 'room'
      ? `${mesh.peers.length} nearby · ${mesh.linkCount} link${mesh.linkCount === 1 ? '' : 's'} · ${radio.text}`
      : activePeer
        ? `${activePeer.status}${activePeer.boxPublicKey ? ' · text sealed' : ' · waiting for key'}`
        : 'Not in range · history only';

  let previousDay = '';
  const timeline = threadMessages.map((message) => {
    const day = dayLabel(message.receivedAt);
    const divider = day !== previousDay;
    previousDay = day;
    return (
      <View key={message.messageId}>
        {divider ? (
          <View style={styles.dayWrap}>
            <Text style={styles.dayPill}>{day}</Text>
          </View>
        ) : null}
        <MessageBubble
          message={message}
          mine={message.senderId === mesh.peerId}
          showSender={thread.type === 'room' && message.senderId !== mesh.peerId}
          radio={mesh.radio}
        />
      </View>
    );
  });

  return (
    <View style={styles.root}>
      <View style={[styles.threadHeader, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to chats"
          hitSlop={hitSlop}
          android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
          onPress={() => {
            tapFeedback();
            closeThread();
          }}
          style={({ pressed }) => [styles.backButton, { opacity: pressed ? 0.65 : 1 }]}
        >
          <BackIcon />
        </Pressable>
        <View
          style={[
            styles.threadAvatar,
            {
              backgroundColor:
                thread.type === 'room'
                  ? palette.primaryWash
                  : palette.raised,
            },
          ]}
        >
          <Text
            style={[
              styles.threadAvatarText,
              { color: thread.type === 'room' ? palette.primaryText : palette.inkMuted },
            ]}
          >
            {thread.type === 'room' ? '#' : initials(threadTitle)}
          </Text>
          {activePeer ? (
            <View
              style={[
                styles.statusDot,
                { backgroundColor: severityColor[PEER_SEVERITY[activePeer.status]] },
              ]}
            />
          ) : null}
        </View>
        <View style={styles.threadCopy}>
          <Text style={styles.threadTitle} numberOfLines={1}>
            {threadTitle}
          </Text>
          <Text style={styles.threadSub} numberOfLines={1}>
            {threadSubtitle}
          </Text>
        </View>
        {thread.type === 'room' ? (
          <Pill
            label={`${mesh.peers.length} peers`}
            severity={mesh.peers.length > 0 ? 'safe' : 'neutral'}
          />
        ) : activePeer ? (
          <Pill label={activePeer.status} severity={PEER_SEVERITY[activePeer.status]} />
        ) : (
          <Pill label="offline" severity="caution" />
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.threadBody}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.messages}
          contentContainerStyle={styles.messagesContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          showsVerticalScrollIndicator={false}
        >
          {threadMessages.length === 0 ? (
            <View style={styles.emptyThread}>
              <Text style={styles.emptyTitle}>
                {thread.type === 'room' ? 'No messages in this room yet' : 'No messages yet'}
              </Text>
              <Text style={styles.emptyBody}>
                {thread.type === 'room'
                  ? roomDescription
                  : canSend
                    ? 'This conversation is sealed for this node. Say hello.'
                    : 'This peer is not in range. Their history stays readable here.'}
              </Text>
            </View>
          ) : (
            timeline
          )}
          {mesh.sharing ? (
            <View style={styles.progressStrip}>
              <View style={styles.progressHead}>
                <Text style={styles.progressLabel}>{`Sending ${mesh.sharing.name}`}</Text>
                <Text style={styles.progressMeta}>
                  {`${mesh.sharing.sent}/${mesh.sharing.total}`}
                </Text>
              </View>
              <ProgressBar
                ratio={mesh.sharing.total ? mesh.sharing.sent / mesh.sharing.total : 0}
              />
            </View>
          ) : null}
          {Object.values(mesh.fileProgress).map((progress) => (
            <View key={progress.name} style={styles.progressStrip}>
              <View style={styles.progressHead}>
                <Text style={styles.progressLabel}>{`Receiving ${progress.name}`}</Text>
                <Text style={styles.progressMeta}>
                  {`${formatBytes(progress.received)} / ${formatBytes(progress.total)}`}
                </Text>
              </View>
              <ProgressBar ratio={progress.total ? progress.received / progress.total : 0} />
            </View>
          ))}
        </ScrollView>

        {notice ? (
          <View style={styles.threadNotice}>
            <Text style={styles.threadNoticeText}>{notice}</Text>
          </View>
        ) : null}

        <View
          style={[
            styles.composerWrap,
            { paddingBottom: keyboardVisible ? space.xs : Math.max(insets.bottom, space.sm) },
          ]}
        >
          {!canSend ? (
            <Text style={styles.composerHint}>
              This peer is not in range. History stays readable; sending resumes when they return.
            </Text>
          ) : null}
          <View style={styles.composer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share a location, file, or map pack"
              hitSlop={hitSlop}
              android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
              onPress={() => {
                tapFeedback();
                openAttach();
              }}
              style={({ pressed }) => [
                styles.attachButton,
                { opacity: pressed ? 0.65 : 1, transform: [{ scale: pressed ? 0.94 : 1 }] },
              ]}
            >
              <PaperclipIcon />
            </Pressable>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              editable={canSend}
              placeholder={
                thread.type === 'room'
                  ? `Message #${roomLabel(thread.id).toLowerCase()}`
                  : `Message ${threadTitle}`
              }
              placeholderTextColor={palette.inkFaint}
              multiline
              maxLength={800}
              style={styles.composerInput}
              accessibilityLabel="Message"
              onFocus={() => {
                setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 220);
              }}
            />
            {models.voice ? (
              <VoiceButton
                enabled
                compact
                onTranscript={(text) => setDraft(text.slice(0, 800))}
                onError={setNotice}
              />
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send message"
              disabled={!canSend || sending || draft.trim().length === 0}
              hitSlop={hitSlop}
              android_ripple={{ color: 'rgba(255,255,255,0.20)', borderless: true }}
              onPress={() => {
                if (!canSend || draft.trim().length === 0) return;
                tapFeedback();
                void send();
              }}
              style={({ pressed }) => [
                styles.sendButton,
                {
                  backgroundColor:
                    canSend && draft.trim().length > 0 ? palette.primary : palette.raised,
                  opacity: pressed ? 0.85 : sending ? 0.6 : 1,
                  transform: [{ scale: pressed ? 0.94 : 1 }],
                },
              ]}
            >
              <SendIcon
                color={canSend && draft.trim().length > 0 ? palette.ink : palette.inkFaint}
              />
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={attachOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAttachOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setAttachOpen(false)} />
          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle}>
                  {attachView === 'menu' ? 'Share' : 'Share a map pack'}
                </Text>
                <Text style={styles.sheetSub}>
                  {thread.type === 'dm'
                    ? 'Location goes to this peer. Files are shared in #maps.'
                    : 'Everyone in range receives this.'}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close share sheet"
                hitSlop={hitSlop}
                android_ripple={{ color: 'rgba(249,115,22,0.10)', borderless: true }}
                onPress={() => {
                  tapFeedback();
                  setAttachOpen(false);
                }}
                style={({ pressed }) => [styles.sheetClose, { opacity: pressed ? 0.65 : 1 }]}
              >
                <Text style={styles.link}>Close</Text>
              </Pressable>
            </View>

            {attachView === 'menu' ? (
              <>
                <ActionButton
                  label="Share my location"
                  tone="ghost"
                  hint="Drops a pin on nearby maps"
                  onPress={() => void shareLocation()}
                />
                <ActionButton
                  label="Share a file"
                  tone="ghost"
                  hint={
                    thread.type === 'dm'
                      ? 'Goes to #maps; direct files are not sealed yet'
                      : `Up to ${formatBytes(MAX_FILE_BYTES)}`
                  }
                  onPress={() => void shareFile()}
                />
                <ActionButton
                  label="Share a map pack"
                  tone="ghost"
                  hint="Send the offline map to nearby nodes"
                  onPress={() => setAttachView('packs')}
                />
              </>
            ) : (
              <>
                <ActionButton
                  label="Back"
                  tone="ghost"
                  onPress={() => setAttachView('menu')}
                />
                {packs.length === 0 ? (
                  <EmptyState
                    title="No map packs installed"
                    body="Download or import a pack from the Map screen first."
                  />
                ) : (
                  packs.map((pack) => (
                    <View key={pack.uri} style={styles.packRow}>
                      <View style={styles.packCopy}>
                        <Text style={styles.packName} numberOfLines={1}>
                          {pack.name}
                        </Text>
                        <Text style={styles.packMeta}>
                          {`${formatPackSize(pack.sizeBytes)} · ${pack.tileCount} tiles`}
                        </Text>
                      </View>
                      <ActionButton
                        label={sharingPack === pack.name ? 'Sending' : 'Share'}
                        tone="soft"
                        busy={sharingPack === pack.name}
                        disabled={sharingPack !== null}
                        onPress={() => void sharePack(pack)}
                      />
                    </View>
                  ))
                )}
              </>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ChatRow({
  avatar,
  avatarColor,
  avatarColorText,
  title,
  subtitle,
  meta,
  onPress,
  statusColor,
}: {
  avatar: string;
  avatarColor: string;
  avatarColorText: string;
  title: string;
  subtitle: string;
  meta: string;
  onPress: () => void;
  statusColor?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      android_ripple={{ color: 'rgba(249,115,22,0.08)' }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={[styles.rowAvatar, { backgroundColor: avatarColor }]}>
        <Text style={[styles.rowAvatarText, { color: avatarColorText }]}>{avatar}</Text>
        {statusColor ? (
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        ) : null}
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {meta}
      </Text>
    </Pressable>
  );
}

function MessageBubble({
  message,
  mine,
  showSender,
  radio,
}: {
  message: InboxMessage;
  mine: boolean;
  showSender: boolean;
  radio: RadioState;
}) {
  return (
    <View style={[styles.messageRow, mine ? styles.messageRowMine : styles.messageRowTheirs]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        {showSender ? (
          <Text style={styles.senderName}>{message.senderCallsign}</Text>
        ) : null}
        {message.kind === 'file' && message.file ? (
          <View style={styles.fileBubble}>
            <View style={styles.fileBadge}>
              <Text style={styles.fileBadgeText}>FILE</Text>
            </View>
            <View style={styles.fileCopy}>
              <Text style={styles.fileName} numberOfLines={1}>
                {message.file.name}
              </Text>
              <Text style={styles.fileMeta}>
                {`${formatBytes(message.file.size)} · ${message.file.kind === 'map' ? 'map' : 'file'}`}
              </Text>
            </View>
          </View>
        ) : message.kind === 'location' ? (
          <View style={styles.locationBubble}>
            <PinIcon color={mine ? palette.primaryText : palette.info} />
            <Text style={styles.messageText}>{message.text}</Text>
          </View>
        ) : (
          <Text style={styles.messageText}>{message.text}</Text>
        )}
        <View style={styles.bubbleMeta}>
          <Text style={styles.messageTime}>
            {timeFormat.format(new Date(message.receivedAt))}
          </Text>
          {message.encrypted ? <Text style={styles.sealed}>sealed</Text> : null}
          {mine ? (
            <Text style={styles.check}>
              {radio === 'ready' ? (message.encrypted ? '✓✓' : '✓') : 'queued'}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
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

function PaperclipIcon() {
  return (
    <Svg width={21} height={21} viewBox="0 0 24 24">
      <Path
        d="M8.5 12.5l6-6a3 3 0 1 1 4.2 4.2l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l7.2-7.2"
        stroke={palette.inkMuted}
        strokeWidth={1.8}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SendIcon({ color }: { color: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path d="M3.4 20.4 21 12 3.4 3.6l.2 6.1L15 12 3.6 14.3z" fill={color} />
    </Svg>
  );
}

function PinIcon({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M12 21s6-5.3 6-10a6 6 0 1 0-12 0c0 4.7 6 10 6 10z"
        stroke={color}
        strokeWidth={1.8}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M12 11.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z" fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },

  listHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    backgroundColor: palette.canvas,
  },
  headerCopy: { flex: 1, gap: 2 },
  listTitle: { color: palette.ink, fontSize: 30, lineHeight: 34, fontWeight: '800', letterSpacing: -0.8 },
  listSub: { color: palette.inkMuted, fontSize: 13 },
  listScroll: { flex: 1 },
  listContent: { paddingBottom: space.xxl * 2 },

  noticeBar: {
    marginHorizontal: space.md,
    marginTop: space.sm,
    backgroundColor: palette.cautionDim,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
  },
  noticeText: { color: palette.caution, fontSize: 12 },

  roomChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, paddingHorizontal: space.lg },
  roomChip: {
    paddingHorizontal: space.md,
    minHeight: 38,
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: palette.raised,
    overflow: 'hidden',
  },
  roomChipText: { color: palette.inkMuted, fontSize: 12, fontWeight: '600' },
  pastToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  sectionHint: { color: palette.inkFaint, fontSize: 11 },
  sectionActionButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.xs,
    marginRight: -space.xs,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  sectionAction: { color: palette.accent, fontSize: 13, fontWeight: '600' },

  rows: { backgroundColor: palette.surface },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 68,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  rowAvatar: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowAvatarText: { fontSize: 15, fontWeight: '800' },
  statusDot: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: palette.surface,
  },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { color: palette.ink, fontSize: 16, fontWeight: '600' },
  rowSubtitle: { color: palette.inkMuted, fontSize: 13 },
  rowMeta: { color: palette.inkFaint, fontSize: 11, maxWidth: 74, textAlign: 'right' },

  emptyPeople: {
    marginHorizontal: space.lg,
    paddingVertical: space.md,
    gap: space.xs,
  },
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: palette.inkMuted, fontSize: 13, lineHeight: 18 },

  footer: {
    fontVariant: ['tabular-nums'] as ('tabular-nums')[],
    color: palette.inkMuted,
    fontSize: 11,
    textAlign: 'center',
    marginTop: space.lg,
    paddingHorizontal: space.md,
  },

  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    backgroundColor: palette.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
    ...shadow,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  threadAvatar: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadAvatarText: { fontSize: 16, fontWeight: '800' },
  threadCopy: { flex: 1, gap: 1 },
  threadTitle: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  threadSub: { color: palette.inkMuted, fontSize: 11 },
  threadBody: { flex: 1 },
  messages: { flex: 1, backgroundColor: palette.sand },
  messagesContent: {
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
    paddingBottom: space.md,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  emptyThread: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    gap: space.xs,
  },
  dayWrap: { alignItems: 'center', marginVertical: space.sm },
  dayPill: {
    color: palette.inkMuted,
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: palette.canvas,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  messageRow: { flexDirection: 'row', marginVertical: 2 },
  messageRowMine: { justifyContent: 'flex-end' },
  messageRowTheirs: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '84%',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 2,
  },
  bubbleMine: {
    backgroundColor: '#FFE3CE',
    borderBottomRightRadius: 4,
  },
  bubbleTheirs: {
    backgroundColor: palette.surface,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
  },
  senderName: { color: palette.primaryText, fontSize: 11, fontWeight: '800' },
  messageText: { color: palette.ink, fontSize: 15, lineHeight: 20 },
  messageTime: { color: palette.inkFaint, fontSize: 9 },
  bubbleMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 5,
  },
  sealed: { color: palette.safe, fontSize: 9, fontWeight: '700' },
  check: { color: palette.info, fontSize: 10, fontWeight: '700' },

  fileBubble: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minWidth: 180 },
  fileBadge: {
    backgroundColor: palette.raised,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 7,
  },
  fileBadgeText: { color: palette.inkMuted, fontSize: 9, fontWeight: '800' },
  fileCopy: { flex: 1, gap: 1 },
  fileName: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  fileMeta: { color: palette.inkFaint, fontSize: 10 },
  locationBubble: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },

  progressStrip: {
    backgroundColor: palette.canvas,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: space.xs,
    marginVertical: space.xs,
  },
  progressHead: { flexDirection: 'row', justifyContent: 'space-between', gap: space.sm },
  progressLabel: { color: palette.inkMuted, fontSize: 11, flex: 1 },
  progressMeta: { color: palette.inkFaint, fontSize: 10 },

  threadNotice: {
    backgroundColor: palette.cautionDim,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  threadNoticeText: { color: palette.caution, fontSize: 11 },

  composerWrap: {
    backgroundColor: palette.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
    paddingHorizontal: space.sm,
    paddingTop: space.xs,
    gap: space.xs,
  },
  composerHint: { color: palette.caution, fontSize: 10, paddingHorizontal: space.xs },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.xs,
  },
  attachButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    backgroundColor: palette.raised,
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    color: palette.ink,
    fontSize: 16,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(24, 20, 16, 0.38)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: palette.canvas,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.xs,
    ...shadow,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingBottom: space.xs,
  },
  sheetTitleWrap: { flex: 1, gap: 1 },
  sheetTitle: { color: palette.ink, fontSize: 20, fontWeight: '800' },
  sheetSub: { color: palette.inkMuted, fontSize: 12 },
  sheetClose: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  link: { color: palette.primaryText, fontSize: 13, fontWeight: '700' },
  packRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.line,
  },
  packCopy: { flex: 1, gap: 1 },
  packName: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  packMeta: { color: palette.inkFaint, fontSize: 11 },
});
