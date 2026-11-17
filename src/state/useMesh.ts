/**
 * App-level mesh state.
 *
 * One `MeshEngine` per app lifetime, created after the identity secret is read
 * from SQLite (so the peer id is stable across reinstalls of the process but not
 * across a data wipe, which is the correct trade-off for an app that must work
 * on a stranger's borrowed phone).
 *
 * Everything the UI needs is derived during render from these two pieces of
 * state. There is no mirrored copy of peers or alerts in component state.
 *
 * Presence is not a button: the engine announces on boot, on every new link and
 * on a slow heartbeat, because a peer list that only fills when someone taps
 * "Announce" is indistinguishable from a broken radio.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Battery from 'expo-battery';
import { File } from 'expo-file-system';

import { MeshEngine, type InboxMessage, type MeshEvent, type Peer, type SosAlert } from '../core/mesh/engine';
import type { LatLon } from '../core/geo';
import { currentFix, watchLocation, type LocationSnapshot, INITIAL_LOCATION } from '../services/location';
import { bleMeshTransport, type BleLink, type RadioState } from '../services/ble-mesh';
import {
  getSetting,
  loadAlerts,
  loadIdentitySecret,
  loadMessages,
  loadPeers,
  saveAlert,
  saveIdentitySecret,
  saveMessage,
  savePeers,
  setSetting,
} from '../services/storage';
import { MAX_FILE_BYTES, type MeshPacket, type SosPayload } from '../core/mesh/protocol';
import { saveReceivedFile, type SavedFile } from '../services/received-files';

export type MeshState = {
  ready: boolean;
  peerId: string | null;
  /** Persisted callsign, so the settings field survives a restart. */
  callsign: string;
  peers: Peer[];
  /** Open BLE links, whether or not that phone has announced itself yet. */
  links: BleLink[];
  messages: InboxMessage[];
  alerts: SosAlert[];
  radio: RadioState;
  /** Last transport failure, for the device panel. */
  radioError: string | null;
  sentFrames: number;
  receivedFrames: number;
  receivedFiles: SavedFile[];
  fileProgress: Record<string, { name: string; received: number; total: number }>;
  sharing: { name: string; sent: number; total: number } | null;
};

const INITIAL_STATE: MeshState = {
  ready: false,
  peerId: null,
  callsign: '',
  peers: [],
  links: [],
  messages: [],
  alerts: [],
  radio: 'off',
  radioError: null,
  sentFrames: 0,
  receivedFrames: 0,
  receivedFiles: [],
  fileProgress: {},
  sharing: null,
};

/** How often a node re-states its presence while the app is open. */
const PRESENCE_INTERVAL_MS = 15_000;
/** Undelivered packets are retried for this long once a link appears. */
const PENDING_TTL_MS = 3 * 60_000;
const MAX_PENDING = 12;

type PendingPacket = { packet: MeshPacket; queuedAt: number };

export function useMesh() {
  const engineRef = useRef<MeshEngine | null>(null);
  const pendingRef = useRef<PendingPacket[]>([]);
  const [state, setState] = useState<MeshState>(INITIAL_STATE);

  /**
   * Send one packet over every live link, fragmenting to the current MTU.
   * Returns how many peers accepted it (0 when nothing is in range).
   */
  const dispatch = useCallback(async (packet: MeshPacket, queueIfUndelivered = true): Promise<number> => {
    const engine = engineRef.current;
    if (!engine) return 0;
    const budget = bleMeshTransport.frameBudget();
    let sent = 0;
    let delivered = 0;
    for (const frame of engine.framesFor(packet, budget)) {
      delivered = await bleMeshTransport.broadcast(frame);
      sent += delivered;
      if (delivered === 0) break;
    }
    if (delivered === 0 && queueIfUndelivered) {
      const pending = pendingRef.current;
      if (!pending.some((item) => item.packet.messageId === packet.messageId)) {
        pending.push({ packet, queuedAt: Date.now() });
        if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
      }
    }
    return sent;
  }, []);

  /** Retry what was typed while nothing was in range, oldest first. */
  const flushPending = useCallback(async (): Promise<number> => {
    const engine = engineRef.current;
    if (!engine || pendingRef.current.length === 0) return 0;
    if (bleMeshTransport.links().length === 0) return 0;
    const now = Date.now();
    const queue = pendingRef.current.filter((item) => now - item.queuedAt < PENDING_TTL_MS);
    pendingRef.current = [];
    const budget = bleMeshTransport.frameBudget();
    let sent = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index]!;
      let delivered = 0;
      for (const frame of engine.framesFor(item.packet, budget)) {
        delivered = await bleMeshTransport.broadcast(frame);
        sent += delivered;
        if (delivered === 0) break;
      }
      if (delivered === 0) {
        // The radio vanished again: keep this packet and the rest, in order.
        pendingRef.current = queue.slice(index);
        break;
      }
    }
    if (sent > 0) setState((previous) => ({ ...previous, sentFrames: previous.sentFrames + sent }));
    return sent;
  }, []);

  const announce = useCallback(async (): Promise<number> => {
    const engine = engineRef.current;
    if (!engine) return 0;
    // Presence is only useful now; a stale announcement is not worth queueing.
    const sent = await dispatch(engine.announce(), false);
    if (sent > 0) setState((previous) => ({ ...previous, sentFrames: previous.sentFrames + sent }));
    return sent;
  }, [dispatch]);

  // Boot: identity -> engine -> persisted history -> radio.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      const [secret, storedCallsign] = await Promise.all([
        loadIdentitySecret(),
        getSetting('mesh.callsign'),
      ]);
      const engine = secret ? MeshEngine.restore(secret) : new MeshEngine();
      if (!secret) await saveIdentitySecret(engine.secret);
      // A callsign typed once must survive an app kill: in a shelter nobody
      // remembers what they called themselves last night.
      if (storedCallsign) engine.setCallsign(storedCallsign);

      const [peers, messages, alerts] = await Promise.all([
        loadPeers(),
        loadMessages(),
        loadAlerts(),
      ]);
      if (cancelled) return;

      engineRef.current = engine;
      setState((previous) => ({
        ...previous,
        ready: true,
        peerId: engine.peerId,
        callsign: storedCallsign ?? '',
        peers: peers.length > 0 ? peers : engine.activePeers(),
        messages,
        alerts,
      }));

      unsubscribe = engine.subscribe((event: MeshEvent) => {
        setState((previous) => {
          switch (event.type) {
            case 'peers':
              void savePeers(event.peers);
              return { ...previous, peers: event.peers };
            case 'message':
              void saveMessage(event.message);
              return {
                ...previous,
                messages: [...previous.messages, event.message].slice(-500),
              };
            case 'sos': {
              void saveAlert(event.alert);
              const others = previous.alerts.filter((alert) => alert.messageId !== event.alert.messageId);
              return { ...previous, alerts: [...others, event.alert] };
            }
            case 'sos-ack':
              return {
                ...previous,
                alerts: previous.alerts.map((alert) =>
                  alert.messageId === event.messageId
                    ? { ...alert, acknowledgedBy: [...alert.acknowledgedBy, event.by] }
                    : alert,
                ),
              };
            case 'file-progress':
              return {
                ...previous,
                fileProgress: {
                  ...previous.fileProgress,
                  [event.transferId]: {
                    name: event.name,
                    received: event.received,
                    total: event.total,
                  },
                },
              };
            case 'file': {
              void (async () => {
                const saved = await saveReceivedFile(event.file);
                if (!saved) return;
                const receivedMessage: InboxMessage = {
                  messageId: `file-${event.file.transferId}-${event.file.receivedAt}`,
                  senderId: event.file.senderId,
                  senderCallsign: event.file.senderCallsign,
                  text: `Received ${event.file.name}`,
                  receivedAt: event.file.receivedAt,
                  createdAt: event.file.receivedAt,
                  hops: 0,
                  encrypted: false,
                  direct: false,
                  room: event.file.room,
                  recipientId: null,
                  kind: 'file',
                  file: {
                    name: event.file.name,
                    size: event.file.size,
                    mime: event.file.mime,
                    sha256: event.file.sha256,
                    kind: event.file.kind,
                  },
                };
                await saveMessage(receivedMessage);
                setState((current) => ({
                  ...current,
                  messages: [...current.messages, receivedMessage].slice(-500),
                  receivedFiles: [...current.receivedFiles, saved],
                }));
              })();
              return previous;
            }
            default:
              return previous;
          }
        });
      });

      const radioState = await bleMeshTransport.start(
        (frame) => {
          const outbound = engine.ingestFrame(frame);
          setState((previous) => ({
            ...previous,
            receivedFrames: previous.receivedFrames + 1,
            radioError: bleMeshTransport.lastError(),
          }));
          for (const relay of outbound) {
            void bleMeshTransport.broadcast(relay);
          }
        },
        (links) => {
          setState((previous) => ({
            ...previous,
            links,
            radioError: bleMeshTransport.lastError(),
          }));
          if (links.length === 0) return;
          // A link just came up: introduce ourselves now, then drain anything
          // that was typed while nobody was in range.
          void announce();
          void flushPending();
        },
      );
      if (cancelled) return;
      setState((previous) => ({ ...previous, radio: radioState, radioError: bleMeshTransport.lastError() }));
      if (radioState === 'ready' || radioState === 'scanning') void announce();
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      bleMeshTransport.stop();
    };
  }, [announce, flushPending]);

  // Presence heartbeat. Also expires peers that stopped announcing, so the list
  // does not keep showing a phone that walked away.
  useEffect(() => {
    if (!state.ready) return;
    const tick = () => {
      const engine = engineRef.current;
      if (!engine) return;
      const active = engine.activePeers();
      setState((previous) =>
        previous.peers.length === active.length
          ? previous
          : { ...previous, peers: active },
      );
      void announce();
      void flushPending();
    };
    const timer = setInterval(tick, PRESENCE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [announce, flushPending, state.ready]);

  const sendBroadcast = useCallback(async (text: string, room = 'general') => {
    const engine = engineRef.current;
    if (!engine || text.trim().length === 0) return 0;
    const packet = engine.sendBroadcast(text.trim(), room);
    const own = engine.history().slice(-1);
    for (const message of own) void saveMessage(message);
    const sent = await dispatch(packet);
    setState((previous) => ({
      ...previous,
      sentFrames: previous.sentFrames + sent,
      messages: [...previous.messages, ...own].slice(-500),
    }));
    return sent;
  }, [dispatch]);

  const sendDirect = useCallback(async (text: string, peerId: string) => {
    const engine = engineRef.current;
    if (!engine || text.trim().length === 0) return null;
    const packet = engine.sendDirect(text.trim(), peerId);
    if (!packet) return null;
    const own = engine.history().slice(-1);
    for (const message of own) void saveMessage(message);
    const sent = await dispatch(packet);
    setState((previous) => ({
      ...previous,
      sentFrames: previous.sentFrames + sent,
      messages: [...previous.messages, ...own].slice(-500),
    }));
    return packet.messageId;
  }, [dispatch]);

  const sendLocation = useCallback(async (room = 'general', peerId?: string) => {
    const engine = engineRef.current;
    if (!engine) return false;
    const packet = engine.sendLocation(room, peerId);
    if (!packet) return false;
    const own = engine.history().slice(-1);
    for (const message of own) void saveMessage(message);
    const sent = await dispatch(packet);
    setState((previous) => ({
      ...previous,
      sentFrames: previous.sentFrames + sent,
      messages: [...previous.messages, ...own].slice(-500),
    }));
    return true;
  }, [dispatch]);

  const shareFile = useCallback(
    async (uri: string, name: string, mime: string, room = 'maps') => {
      const engine = engineRef.current;
      if (!engine) return 0;
      const source = new File(uri);
      if (!source.exists) return 0;
      const bytes = await source.bytes();
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return 0;

      const packets = engine.shareFile(name, bytes, mime, room);
      if (packets.length === 0) return 0;
      const own = engine.history().slice(-1);
      for (const message of own) void saveMessage(message);
      const totalChunks = packets.length - 1;
      setState((previous) => ({
        ...previous,
        sharing: { name, sent: 0, total: totalChunks },
      }));

      let sent = 0;
      for (let index = 0; index < packets.length; index += 1) {
        // A file is too large to queue: if the link is gone, say so instead of
        // promising a transfer that will never resume.
        sent += await dispatch(packets[index]!, false);
        if (index > 0) {
          setState((previous) => ({
            ...previous,
            sharing: previous.sharing
              ? { ...previous.sharing, sent: Math.min(previous.sharing.total, index) }
              : null,
          }));
        }
      }
      setState((previous) => ({
        ...previous,
        sentFrames: previous.sentFrames + sent,
        sharing: previous.sharing ? { ...previous.sharing, sent: totalChunks } : null,
        messages: [...previous.messages, ...own].slice(-500),
      }));
      return sent;
    },
    [dispatch],
  );

  const sendSos = useCallback(async (input: Omit<SosPayload, 'lat' | 'lon' | 'accuracyM'>) => {
    const engine = engineRef.current;
    if (!engine) return null;
    // Stamp the position at send time: a stale coordinate in an SOS is worse
    // than an honest "no fix", and the payload always carries accuracy.
    const fix = await currentFix();
    const payload: SosPayload = {
      ...input,
      lat: fix?.point.lat ?? 0,
      lon: fix?.point.lon ?? 0,
      accuracyM: fix?.accuracyM ?? null,
    };
    const packet = engine.sendSos(payload);
    await dispatch(packet);
    setState((previous) => ({
      ...previous,
      alerts: [...previous.alerts.filter((alert) => alert.messageId !== packet.messageId), ...engine.sosAlerts()],
    }));
    return packet.messageId;
  }, [dispatch]);

  const acknowledge = useCallback(async (alert: SosAlert) => {
    const engine = engineRef.current;
    if (!engine) return;
    await dispatch(engine.ackSos(alert.messageId, alert.senderId));
  }, [dispatch]);

  /** Publish the smoothed fix so our announcements carry a real position. */
  const setPosition = useCallback((point: LatLon, accuracyM: number | null) => {
    engineRef.current?.setPosition(point, accuracyM);
  }, []);

  const setCallsign = useCallback((callsign: string) => {
    const trimmed = callsign.trim().slice(0, 24);
    engineRef.current?.setCallsign(trimmed);
    setState((previous) => ({ ...previous, callsign: trimmed }));
    if (trimmed.length > 0) void setSetting('mesh.callsign', trimmed);
  }, []);

  const alertCount = useMemo(
    () => state.alerts.filter((alert) => !alert.mine).length,
    [state.alerts],
  );

  return {
    ...state,
    linkCount: state.links.length,
    alertCount,
    announce,
    sendBroadcast,
    sendDirect,
    sendLocation,
    shareFile,
    sendSos,
    acknowledge,
    setCallsign,
    setPosition,
  };
}

export type MeshApi = ReturnType<typeof useMesh>;

export type BatterySnapshot = {
  /** 0..1, or null when the platform cannot report it. */
  level: number | null;
  state: 'unknown' | 'unplugged' | 'charging' | 'full';
};

const INITIAL_BATTERY: BatterySnapshot = { level: null, state: 'unknown' };

function batteryStateName(state: Battery.BatteryState): BatterySnapshot['state'] {
  switch (state) {
    case Battery.BatteryState.CHARGING:
      return 'charging';
    case Battery.BatteryState.FULL:
      return 'full';
    case Battery.BatteryState.UNPLUGGED:
      return 'unplugged';
    default:
      return 'unknown';
  }
}

/** Battery + fix age, the two numbers that decide what the user dares to do next. */
export function useDevices() {
  const [location, setLocation] = useState<LocationSnapshot>(INITIAL_LOCATION);
  const [battery, setBattery] = useState<BatterySnapshot>(INITIAL_BATTERY);
  const watcherRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const watcher = await watchLocation((snapshot) => {
        if (!cancelled) setLocation(snapshot);
      });
      watcherRef.current = watcher;
    })();
    return () => {
      cancelled = true;
      watcherRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [level, state] = await Promise.all([
        Battery.getBatteryLevelAsync().catch(() => -1),
        Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
      ]);
      if (cancelled) return;
      setBattery({
        level: level >= 0 ? level : null,
        state: batteryStateName(state),
      });
    })();

    const levelSubscription = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      if (!cancelled) setBattery((previous) => ({ ...previous, level: batteryLevel >= 0 ? batteryLevel : null }));
    });
    const stateSubscription = Battery.addBatteryStateListener(({ batteryState }) => {
      if (!cancelled) setBattery((previous) => ({ ...previous, state: batteryStateName(batteryState) }));
    });

    return () => {
      cancelled = true;
      levelSubscription.remove();
      stateSubscription.remove();
    };
  }, []);

  const refreshFix = useCallback(async () => {
    const fix = await currentFix();
    if (!fix) return;
    setLocation((previous) => ({
      point: fix.point,
      accuracyM: fix.accuracyM,
      updatedAt: fix.timestamp,
      status: 'live',
    }));
  }, []);

  return { location, battery, refreshFix };
}

export type DevicesApi = ReturnType<typeof useDevices>;
