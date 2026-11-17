/**
 * GPS with an honest degraded mode.
 *
 * In a disaster the position is used for two things: placing the user on an
 * offline map, and putting coordinates into an SOS. A stale or wildly inaccurate
 * fix is worse than none, so every fix carries its accuracy and the UI is
 * required to display it. Positions are smoothed (see `smoothFix`) because
 * handset GPS wanders badly under rubble and tree cover.
 */

import * as Location from 'expo-location';

import { smoothFix, type Fix, type LatLon } from '../core/geo';

export type LocationSnapshot = {
  point: LatLon | null;
  accuracyM: number | null;
  updatedAt: number | null;
  /** 'denied' and 'unavailable' must be surfaced, never silently swallowed. */
  status: 'idle' | 'waiting' | 'live' | 'denied' | 'unavailable';
};

export const INITIAL_LOCATION: LocationSnapshot = {
  point: null,
  accuracyM: null,
  updatedAt: null,
  status: 'idle',
};

/** Offline-first: ask for accuracy, not a network-assisted position. */
const WATCH_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.High,
  timeInterval: 15_000,
  distanceInterval: 15,
};

export async function requestLocationPermission(timeoutMs = 6_000): Promise<boolean> {
  try {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.granted) return true;
    const request = Location.requestForegroundPermissionsAsync();
    // The watcher uses a short timeout so a stuck prompt cannot block boot.
    // Onboarding can wait longer because the user is actively reading it.
    const requested =
      timeoutMs > 0
        ? await Promise.race([
            request,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ])
        : await request;
    return requested?.granted ?? false;
  } catch {
    return false;
  }
}

/** One-shot fix, used by the SOS composer to stamp a position at send time. */
/** A cached fix that never opens a system settings screen. */
export async function lastKnownFix(maxAgeMs = 24 * 60 * 60 * 1000): Promise<Fix | null> {
  try {
    const position = await Location.getLastKnownPositionAsync({ maxAge: maxAgeMs });
    if (!position) return null;
    return {
      point: { lat: position.coords.latitude, lon: position.coords.longitude },
      accuracyM: position.coords.accuracy ?? null,
      timestamp: position.timestamp,
    };
  } catch {
    return null;
  }
}

export async function hasLocationPermission(): Promise<boolean> {
  try {
    const permission = await Location.getForegroundPermissionsAsync();
    return permission.granted;
  } catch {
    return false;
  }
}

export async function currentFix(timeoutMs = 8_000): Promise<Fix | null> {
  try {
    const enabled = await Location.hasServicesEnabledAsync();
    if (!enabled) return null;
    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!position) return null;
    return {
      point: { lat: position.coords.latitude, lon: position.coords.longitude },
      accuracyM: position.coords.accuracy ?? null,
      timestamp: position.timestamp,
    };
  } catch {
    return null;
  }
}

/**
 * A real fix for the first map download.
 *
 * A cached position is only accepted when it is recent and accurate; otherwise
 * onboarding refuses to build a map around a place the user may no longer be in.
 */
export async function locateForMap(
  fixTimeoutMs = 25_000,
  permissionTimeoutMs = 30_000,
): Promise<Fix | null> {
  const granted = await requestLocationPermission(permissionTimeoutMs);
  if (!granted) return null;
  const enabled = await Location.hasServicesEnabledAsync().catch(() => true);
  if (!enabled) return null;
  const fresh = await currentFix(fixTimeoutMs);
  if (fresh) return fresh;
  const cached = await lastKnownFix(2 * 60 * 1000);
  if (!cached) return null;
  const age = Date.now() - cached.timestamp;
  if (age > 2 * 60 * 1000) return null;
  if (cached.accuracyM !== null && cached.accuracyM > 250) return null;
  return cached;
}

export type LocationWatcher = { stop: () => void };

/**
 * Stream smoothed fixes into `onUpdate`. Returns a watcher that stops the
 * subscription; the caller owns lifecycle so the GPS radio is never left on.
 */
export async function watchLocation(
  onUpdate: (snapshot: LocationSnapshot) => void,
): Promise<LocationWatcher> {
  const granted = await requestLocationPermission();
  if (!granted) {
    onUpdate({ ...INITIAL_LOCATION, status: 'denied' });
    return { stop: () => {} };
  }

  let smoothed: LatLon | null = null;
  onUpdate({ ...INITIAL_LOCATION, status: 'waiting' });

  const subscription = await Location.watchPositionAsync(WATCH_OPTIONS, (position) => {
    const fix: Fix = {
      point: { lat: position.coords.latitude, lon: position.coords.longitude },
      accuracyM: position.coords.accuracy ?? null,
      timestamp: position.timestamp,
    };
    smoothed = smoothFix(smoothed, fix);
    onUpdate({
      point: smoothed,
      accuracyM: fix.accuracyM,
      updatedAt: fix.timestamp,
      status: 'live',
    });
  });

  return { stop: () => subscription.remove() };
}

type RelativeFormatter = { format: (value: number, unit: 'second' | 'minute' | 'hour') => string };

/**
 * Hermes ships without Intl.RelativeTimeFormat (verified on device: the
 * constructor is `undefined`), and touching it at module scope crashes the
 * bundle on import. Probe for it once, lazily, and fall back to plain English.
 */
let ageFormat: RelativeFormatter | null | undefined;

function getAgeFormat(): RelativeFormatter | null {
  if (ageFormat !== undefined) return ageFormat;
  const RelativeTimeFormat = (Intl as unknown as { RelativeTimeFormat?: new (locale: string, options: { numeric: 'auto' }) => RelativeFormatter })
    .RelativeTimeFormat;
  ageFormat = typeof RelativeTimeFormat === 'function' ? new RelativeTimeFormat('en', { numeric: 'auto' }) : null;
  return ageFormat;
}

function pluralize(count: number, unit: string): string {
  const abs = Math.abs(count);
  return `${abs} ${unit}${abs === 1 ? '' : 's'} ago`;
}

/** "12 seconds ago" for the fix age, so a frozen GPS is visible as frozen. */
export function describeFixAge(updatedAt: number | null, now = Date.now()): string {
  if (updatedAt === null) return 'no fix yet';
  const seconds = Math.round((now - updatedAt) / 1000);
  const unit: 'second' | 'minute' | 'hour' =
    Math.abs(seconds) < 60 ? 'second' : Math.abs(seconds) < 3600 ? 'minute' : 'hour';
  const value = unit === 'second' ? seconds : unit === 'minute' ? Math.round(seconds / 60) : Math.round(seconds / 3600);

  const formatter = getAgeFormat();
  if (formatter) return formatter.format(-value, unit);
  return pluralize(value, unit);
}
