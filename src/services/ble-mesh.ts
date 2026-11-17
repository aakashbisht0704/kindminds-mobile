/**
 * Bluetooth Low Energy transport for the mesh.
 *
 * Honest about what a JS-only BLE stack can do: `react-native-ble-plx` is a
 * *central* (client) implementation. A phone can scan, connect and write to
 * other phones, but it cannot advertise a service by itself, so a full mesh
 * needs a peripheral role from native code (Android `BluetoothGattServer`, iOS
 * `CBPeripheralManager`). This file therefore implements the complete central
 * path plus an explicit `peripheralAvailable` flag; screens surface that as
 * "scanning only" rather than pretending the radio works both ways.
 *
 * The transport is deliberately dumb: it moves opaque frames. All routing
 * decisions live in `MeshEngine`, which is why the protocol can be tested
 * without a radio at all.
 *
 * Three things here are load-bearing for a real two-phone link:
 *  - the ATT MTU is negotiated on connect, and `frameBudget()` tells the engine
 *    how many bytes fit in one write. A 372-byte frame written over the default
 *    23-byte MTU simply fails, which looks like "sent" to nobody.
 *  - a link is only counted when a write was accepted by that peer, and a phone
 *    reached over both the central and peripheral paths is counted once.
 *  - a failed write drops the link instead of leaving a dead entry that keeps
 *    swallowing frames.
 */

import { BleManager, type Device } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';

import { base64ToBytes, bytesToBase64 } from '../core/mesh/bytes';
import { notifyPeripheral, startPeripheral, type PeripheralHandle, type PeripheralPeer } from './ble-peripheral';

/** Random 128-bit UUIDs; BitChat's are public constants, ours are app-private. */
export const MESH_SERVICE_UUID = '7f3a6b10-9c4d-4e21-8f77-2a5b9e0c1d34';
export const MESH_FRAME_CHARACTERISTIC_UUID = '7f3a6b11-9c4d-4e21-8f77-2a5b9e0c1d34';
export const MESH_ANNOUNCE_CHARACTERISTIC_UUID = '7f3a6b12-9c4d-4e21-8f77-2a5b9e0c1d34';

/** Ask for the largest MTU Android reliably grants; 23 is the protocol floor. */
const REQUESTED_MTU = 512;
const DEFAULT_MTU = 23;
/** ATT header that rides along with every characteristic write. */
const ATT_OVERHEAD = 3;
/** The mesh frame header that rides along with every fragment. */
const FRAME_HEADER_BYTES = 13;
const MAX_FRAME_DATA_BYTES = 360;
/** 7 bytes of payload + 13 bytes of frame header fits an unnegotiated MTU. */
const MIN_FRAME_DATA_BYTES = 7;
const MAX_CONNECTIONS = 7; // Android's practical GATT ceiling.
const RECONNECT_COOLDOWN_MS = 8_000;
const LINK_STALE_MS = 120_000;
const PERIPHERAL_READY_TIMEOUT_MS = 6_000;

export type RadioState = 'off' | 'unauthorized' | 'unsupported' | 'scanning' | 'ready' | 'error';

export type BleLink = {
  deviceId: string;
  name: string;
  rssi: number | null;
  lastSeen: number;
  /** Which side of the link this phone holds. */
  role: 'central' | 'peripheral' | 'both';
};

export type MeshTransport = {
  /** Start scanning and piping frames; resolves once the radio is active. */
  start: (onFrame: (frame: Uint8Array) => void, onLinks?: (links: BleLink[]) => void) => Promise<RadioState>;
  stop: () => void;
  /** Best-effort write of one frame to every currently connected peer. */
  broadcast: (frame: Uint8Array) => Promise<number>;
  links: () => BleLink[];
  state: () => RadioState;
  /** Largest fragment this radio can carry in a single write. */
  frameBudget: () => number;
  /** Short human-readable reason for the last transport failure, if any. */
  lastError: () => string | null;
};

/** Android 12+ split the BLE permissions; older versions used location. */
async function ensureAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const apiLevel = typeof Platform.Version === 'number' ? Platform.Version : 31;
    const permissions =
      apiLevel >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const results = await PermissionsAndroid.requestMultiple(
      permissions.filter((permission): permission is NonNullable<typeof permission> => Boolean(permission)),
    );
    return Object.values(results).every((result) => result === PermissionsAndroid.RESULTS.GRANTED);
  } catch {
    return false;
  }
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

class BleMeshTransport implements MeshTransport {
  private readonly manager = new BleManager();
  private readonly connected = new Map<string, Device>();
  private readonly mtus = new Map<string, number>();
  /** Address -> last time the native GATT server reported it connected. */
  private readonly peripheralClients = new Map<string, number>();
  private readonly discovered = new Map<string, BleLink>();
  private readonly connecting = new Set<string>();
  private readonly cooldown = new Map<string, number>();
  private scanning = false;
  private radioState: RadioState = 'off';
  private onFrame: ((frame: Uint8Array) => void) | null = null;
  private onLinks: ((links: BleLink[]) => void) | null = null;
  private peripheral: PeripheralHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private error: string | null = null;

  state(): RadioState {
    return this.radioState;
  }

  lastError(): string | null {
    return this.error;
  }

  /** True when this device can act as a peripheral, i.e. others can find it. */
  get canAdvertise(): boolean {
    return this.radioState === 'ready';
  }

  links(): BleLink[] {
    const now = Date.now();
    const out = new Map<string, BleLink>();
    for (const [id, device] of this.connected) {
      const seen = this.discovered.get(id);
      out.set(id, {
        deviceId: id,
        name: seen?.name ?? device.localName ?? device.name ?? `Node ${id.slice(-4)}`,
        rssi: seen?.rssi ?? null,
        lastSeen: now,
        role: 'central',
      });
    }
    for (const [address, at] of this.peripheralClients) {
      if (now - at > LINK_STALE_MS) continue;
      const existing = out.get(address);
      if (existing) {
        existing.role = 'both';
        existing.lastSeen = Math.max(existing.lastSeen, at);
        continue;
      }
      out.set(address, {
        deviceId: address,
        name: `Node ${address.slice(-4)}`,
        rssi: null,
        lastSeen: at,
        role: 'peripheral',
      });
    }
    return [...out.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Data bytes that fit in one write on the narrowest live link. Sized for the
   * worst link on purpose: a frame that fits only the widest one fails on the
   * others, and a failed write silently loses a fragment.
   */
  frameBudget(): number {
    let mtu = Number.POSITIVE_INFINITY;
    for (const value of this.mtus.values()) mtu = Math.min(mtu, value);
    // With no link there is nothing to write; use the roomy default so queued
    // traffic is not shredded into twenty fragments before it is ever sent.
    if (!Number.isFinite(mtu)) return MAX_FRAME_DATA_BYTES;
    const usable = mtu - ATT_OVERHEAD - FRAME_HEADER_BYTES;
    return Math.max(MIN_FRAME_DATA_BYTES, Math.min(MAX_FRAME_DATA_BYTES, usable));
  }

  async start(
    onFrame: (frame: Uint8Array) => void,
    onLinks?: (links: BleLink[]) => void,
  ): Promise<RadioState> {
    this.onFrame = onFrame;
    this.onLinks = onLinks ?? null;
    this.error = null;
    const permitted = await ensureAndroidPermissions();
    if (!permitted) {
      this.radioState = 'unauthorized';
      this.error = 'Bluetooth permission was refused.';
      return this.radioState;
    }

    try {
      const poweredOn = await this.manager.state();
      if (poweredOn !== 'PoweredOn') {
        // Wait once for the user to switch Bluetooth on, then give up honestly.
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            subscription.remove();
            resolve();
          }, 8_000);
          const subscription = this.manager.onStateChange((state) => {
            if (state === 'PoweredOn') {
              clearTimeout(timeout);
              subscription.remove();
              resolve();
            }
          }, true);
        });
        const state = await this.manager.state();
        if (state !== 'PoweredOn') {
          this.radioState = state === 'Unauthorized' ? 'unauthorized' : 'off';
          this.error = state === 'Unauthorized' ? 'Bluetooth permission is missing.' : 'Bluetooth is off.';
          return this.radioState;
        }
      }
    } catch (error) {
      this.radioState = 'unsupported';
      this.error = shortError(error);
      return this.radioState;
    }

    // Start the peripheral role first. If the device cannot advertise, the
    // central path still works and the UI honestly says "scanning".
    const peripheral = startPeripheral(MESH_SERVICE_UUID, onFrame, (peer) => this.notePeripheralPeer(peer));
    this.peripheral = peripheral;
    const peripheralReady = peripheral
      ? await Promise.race([
          peripheral.ready,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PERIPHERAL_READY_TIMEOUT_MS)),
        ])
      : false;
    if (!peripheralReady) {
      this.error = 'This phone could not advertise, so others cannot find it.';
    }

    // `startDeviceScan` resolves a plain promise (it is not a Subscription), so
    // the scan is stopped through the manager rather than through a handle.
    if (this.scanning) void this.manager.stopDeviceScan().catch(() => {});
    this.scanning = true;
    void this.manager
      .startDeviceScan(
        [MESH_SERVICE_UUID],
        { allowDuplicates: true },
        (error, device) => {
          if (error) {
            this.error = shortError(error);
            return;
          }
          if (!device?.id) return;
          this.discovered.set(device.id, {
            deviceId: device.id,
            name: device.localName ?? device.name ?? `Node ${device.id.slice(-4)}`,
            rssi: device.rssi ?? null,
            lastSeen: Date.now(),
            role: 'central',
          });
          void this.connectAndSubscribe(device);
        },
      )
      .catch((error: unknown) => {
        // A scan that cannot start is reported through `radioState`, not a throw.
        this.scanning = false;
        this.error = shortError(error);
      });
    this.radioState = peripheralReady ? 'ready' : 'scanning';
    return this.radioState;
  }

  stop(): void {
    this.peripheral?.stop();
    this.peripheral = null;
    if (this.scanning) {
      void this.manager.stopDeviceScan().catch(() => {});
      this.scanning = false;
    }
    for (const device of this.connected.values()) {
      void device.cancelConnection().catch(() => {});
    }
    this.connected.clear();
    this.mtus.clear();
    this.peripheralClients.clear();
    this.cooldown.clear();
    this.discovered.clear();
    this.onLinks = null;
    this.radioState = 'off';
  }

  /**
   * Connect once per device and subscribe to the frame characteristic. Failures
   * are swallowed: in a crowd of broken phones, a failed GATT handshake is
   * expected, not exceptional.
   */
  private async connectAndSubscribe(device: Device): Promise<void> {
    if (this.connected.has(device.id) || this.connecting.has(device.id)) return;
    if (this.connected.size >= MAX_CONNECTIONS) return;
    const lastAttempt = this.cooldown.get(device.id) ?? 0;
    if (Date.now() - lastAttempt < RECONNECT_COOLDOWN_MS) return;

    this.connecting.add(device.id);
    try {
      // Without an MTU request Android keeps the 23-byte default and every
      // frame of our 372-byte wire format is rejected by the stack.
      const linked = await device.connect({ requestMTU: REQUESTED_MTU });
      await linked.discoverAllServicesAndCharacteristics();
      this.connected.set(device.id, linked);
      this.mtus.set(device.id, linked.mtu && linked.mtu > 0 ? linked.mtu : DEFAULT_MTU);
      linked.onDisconnected(() => this.dropLink(device.id, 'peer disconnected'));
      try {
        linked.monitorCharacteristicForService(
          MESH_SERVICE_UUID,
          MESH_FRAME_CHARACTERISTIC_UUID,
          (error, characteristic) => {
            if (error || !characteristic?.value) {
              if (error) this.error = shortError(error);
              return;
            }
            const frame = decodeBase64Frame(characteristic.value);
            if (frame) this.onFrame?.(frame);
          },
        );
      } catch (error) {
        // The write half of the link still works; notifications are a bonus.
        this.error = shortError(error);
      }
      this.notifyLinks();
    } catch (error) {
      this.cooldown.set(device.id, Date.now());
      this.error = shortError(error);
    } finally {
      this.connecting.delete(device.id);
    }
  }

  private dropLink(deviceId: string, reason: string): void {
    if (this.connected.delete(deviceId) || this.mtus.delete(deviceId)) {
      this.error = reason;
      this.cooldown.set(deviceId, Date.now());
      this.notifyLinks();
    }
  }

  private notePeripheralPeer(peer: PeripheralPeer): void {
    if (!peer.deviceId) return;
    if (peer.connected) {
      this.peripheralClients.set(peer.deviceId, Date.now());
      this.notifyLinks();
    } else if (this.peripheralClients.delete(peer.deviceId)) {
      this.notifyLinks();
    }
  }

  private notifyLinks(): void {
    // Never re-enter the send path from inside a write: link callbacks kick off
    // an announcement, and an announcement writes to the same GATT links.
    setTimeout(() => this.onLinks?.(this.links()), 0);
  }

  /** Writes one frame to every connected peer; returns how many peers took it. */
  async broadcast(frame: Uint8Array): Promise<number> {
    // Android rejects overlapping characteristic writes with GATT_BUSY, and a
    // relay plus a user message can easily overlap. Serialise them.
    const run = this.writeChain.then(() => this.writeFrame(frame));
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeFrame(frame: Uint8Array): Promise<number> {
    if (frame.length === 0) return 0;
    const value = bytesToBase64(frame);
    const centralIds = [...this.connected.keys()];
    if (centralIds.length === 0 && this.peripheralClients.size === 0) return 0;

    const results = await Promise.all(
      centralIds.map(async (deviceId) => {
        const device = this.connected.get(deviceId);
        if (!device) return null;
        try {
          await device.writeCharacteristicWithResponseForService(
            MESH_SERVICE_UUID,
            MESH_FRAME_CHARACTERISTIC_UUID,
            value,
          );
          return deviceId;
        } catch (error) {
          this.error = shortError(error);
          this.dropLink(deviceId, 'write failed, link dropped');
          void device.cancelConnection().catch(() => {});
          return null;
        }
      }),
    );

    const reached = new Set(results.filter((id): id is string => Boolean(id)));
    let notified = 0;
    try {
      notified = await notifyPeripheral(frame);
    } catch (error) {
      this.error = shortError(error);
    }
    // The native side only reports a count, so attribute it to the clients we
    // know about and skip the ones that already accepted the central write.
    let budget = notified;
    for (const [address, at] of this.peripheralClients) {
      if (budget <= 0) break;
      if (Date.now() - at > LINK_STALE_MS) continue;
      if (reached.has(address)) continue;
      reached.add(address);
      budget -= 1;
    }
    return reached.size;
  }
}

function decodeBase64Frame(value: string): Uint8Array | null {
  try {
    // ble-plx returns base64; reuse the same decoder the protocol uses instead
    // of the runtime's `atob`, which Hermes does not always provide.
    const bytes = base64ToBytes(value);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

export const bleMeshTransport = new BleMeshTransport();

/**
 * In-process loopback used by the UI demo and by tests. It lets the whole app be
 * exercised without two physical phones, and doubles as a fallback so the mesh
 * screen is never dead on a simulator.
 */
export class LoopbackTransport implements MeshTransport {
  private listeners = new Set<(frame: Uint8Array) => void>();
  private radioState: RadioState = 'off';

  state(): RadioState {
    return this.radioState;
  }

  links(): BleLink[] {
    return [];
  }

  frameBudget(): number {
    return MAX_FRAME_DATA_BYTES;
  }

  lastError(): string | null {
    return null;
  }

  async start(
    onFrame: (frame: Uint8Array) => void,
    onLinks?: (links: BleLink[]) => void,
  ): Promise<RadioState> {
    this.listeners.add(onFrame);
    this.radioState = 'ready';
    onLinks?.([]);
    return this.radioState;
  }

  stop(): void {
    this.listeners.clear();
    this.radioState = 'off';
  }

  async broadcast(frame: Uint8Array): Promise<number> {
    let delivered = 0;
    for (const listener of this.listeners) {
      listener(frame);
      delivered += 1;
    }
    return delivered;
  }
}
