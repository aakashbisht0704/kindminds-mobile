/**
 * Native Android peripheral bridge.
 *
 * The JS BLE library is central-only. This wrapper talks to the small Kotlin
 * module that advertises our service and runs a GATT server, so a phone can be
 * discovered and can receive frames without first connecting to someone else.
 */

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import { base64ToBytes, bytesToBase64 } from '../core/mesh/bytes';

type MeshPeripheralNative = {
  startAdvertising: (serviceUuid: string, localName: string) => Promise<boolean>;
  stopAdvertising: () => Promise<boolean>;
  notifyFrame: (base64: string) => Promise<number>;
};

const native = (NativeModules.MeshPeripheral ?? null) as MeshPeripheralNative | null;
const emitter = native && Platform.OS === 'android' ? new NativeEventEmitter(native as never) : null;

export const peripheralSupported = Boolean(native && emitter);

export type PeripheralPeer = { deviceId: string; connected: boolean };

export type PeripheralHandle = {
  ready: Promise<boolean>;
  stop: () => void;
};

export function startPeripheral(
  serviceUuid: string,
  onFrame: (frame: Uint8Array) => void,
  onPeer?: (peer: PeripheralPeer) => void,
): PeripheralHandle | null {
  if (!native || !emitter) return null;

  const frameSubscription = emitter.addListener('MeshPeripheralFrame', (base64: string) => {
    try {
      onFrame(base64ToBytes(base64));
    } catch {
      // A malformed native frame is ignored; the protocol layer would reject it.
    }
  });
  const peerSubscription = onPeer
    ? emitter.addListener('MeshPeripheralPeer', (peer: PeripheralPeer) => onPeer(peer))
    : null;

  const ready = native
    .startAdvertising(serviceUuid, 'KindMinds')
    .then(() => true)
    .catch(() => false);

  return {
    ready,
    stop: () => {
      frameSubscription.remove();
      peerSubscription?.remove();
      void native.stopAdvertising().catch(() => {});
    },
  };
}

/** Notify every peer connected to our GATT server. Returns the accepted count. */
export async function notifyPeripheral(frame: Uint8Array): Promise<number> {
  if (!native) return 0;
  try {
    return await native.notifyFrame(bytesToBase64(frame));
  } catch {
    return 0;
  }
}
