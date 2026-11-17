/**
 * Local persistence. Nothing ever leaves the device.
 *
 * SQLite because the mesh history, the peer table and the packing checklist all
 * need to survive an app kill in a place with no signal and no login. Keys are
 * stored in a small settings table; the identity secret is the only value written
 * once and never re-derived from the network.
 */

import * as SQLite from 'expo-sqlite';

import type { IdentitySecret } from '../core/mesh/crypto';
import type { InboxMessage, Peer, SosAlert } from '../core/mesh/engine';

const DATABASE_NAME = 'kindminds.db';

let database: Promise<SQLite.SQLiteDatabase> | null = null;

type SettingRow = { key: string; value: string };

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (!database) {
    database = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (instance) => {
      await instance.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS peers (
          peer_id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          received_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
          message_id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          received_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS checklist (
          item_id TEXT PRIMARY KEY NOT NULL,
          packed INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_received_at ON messages (received_at DESC);
      `);
      return instance;
    });
  }
  return database;
}

export async function getSetting(key: string): Promise<string | null> {
  const instance = await db();
  const row = await instance.getFirstAsync<SettingRow>(
    'SELECT key, value FROM settings WHERE key = ?',
    key,
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const instance = await db();
  await instance.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function loadIdentitySecret(): Promise<IdentitySecret | null> {
  const raw = await getSetting('mesh.identity');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IdentitySecret>;
    if (typeof parsed.signSecretKey !== 'string' || typeof parsed.boxSecretKey !== 'string') return null;
    return {
      signSecretKey: parsed.signSecretKey,
      boxSecretKey: parsed.boxSecretKey,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    };
  } catch {
    // A corrupt row must not brick the app: regenerate an identity instead.
    return null;
  }
}

export async function saveIdentitySecret(secret: IdentitySecret): Promise<void> {
  await setSetting('mesh.identity', JSON.stringify(secret));
}

export async function savePeers(peers: Peer[]): Promise<void> {
  const instance = await db();
  await instance.withTransactionAsync(async () => {
    for (const peer of peers) {
      await instance.runAsync(
        `INSERT INTO peers (peer_id, payload, last_seen) VALUES (?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET payload = excluded.payload, last_seen = excluded.last_seen`,
        peer.peerId,
        JSON.stringify({ ...peer, signingPublicKey: null, boxPublicKey: null }),
        peer.lastSeen,
      );
    }
  });
}

export async function loadPeers(): Promise<Peer[]> {
  const instance = await db();
  const rows = await instance.getAllAsync<{ payload: string }>(
    'SELECT payload FROM peers ORDER BY last_seen DESC LIMIT 64',
  );
  return rows.flatMap((row) => {
    try {
      const peer = JSON.parse(row.payload) as Peer;
      return typeof peer.peerId === 'string' ? [{ ...peer, signingPublicKey: null, boxPublicKey: null }] : [];
    } catch {
      return [];
    }
  });
}

export async function saveMessage(message: InboxMessage): Promise<void> {
  const instance = await db();
  await instance.runAsync(
    'INSERT OR REPLACE INTO messages (message_id, payload, received_at) VALUES (?, ?, ?)',
    message.messageId,
    JSON.stringify(message),
    message.receivedAt,
  );
}

export async function loadMessages(limit = 200): Promise<InboxMessage[]> {
  const instance = await db();
  const rows = await instance.getAllAsync<{ payload: string }>(
    'SELECT payload FROM messages ORDER BY received_at DESC LIMIT ?',
    limit,
  );
  return rows.flatMap((row) => {
    try {
      const message = JSON.parse(row.payload) as InboxMessage;
      if (typeof message.messageId !== 'string') return [];
      return [{
        ...message,
        room: typeof message.room === 'string' ? message.room : 'general',
        recipientId: message.recipientId ?? null,
        kind: message.kind ?? 'text',
      }];
    } catch {
      return [];
    }
  }).reverse();
}

export async function saveAlert(alert: SosAlert): Promise<void> {
  const instance = await db();
  await instance.runAsync(
    'INSERT OR REPLACE INTO alerts (message_id, payload, received_at) VALUES (?, ?, ?)',
    alert.messageId,
    JSON.stringify(alert),
    alert.receivedAt,
  );
}

export async function loadAlerts(limit = 50): Promise<SosAlert[]> {
  const instance = await db();
  const rows = await instance.getAllAsync<{ payload: string }>(
    'SELECT payload FROM alerts ORDER BY received_at DESC LIMIT ?',
    limit,
  );
  return rows.flatMap((row) => {
    try {
      const alert = JSON.parse(row.payload) as SosAlert;
      return typeof alert.messageId === 'string' ? [alert] : [];
    } catch {
      return [];
    }
  });
}

export async function loadChecklist(): Promise<Record<string, boolean>> {
  const instance = await db();
  const rows = await instance.getAllAsync<{ item_id: string; packed: number }>(
    'SELECT item_id, packed FROM checklist',
  );
  return Object.fromEntries(rows.map((row) => [row.item_id, row.packed === 1]));
}

export async function setChecklistItem(itemId: string, packed: boolean): Promise<void> {
  const instance = await db();
  await instance.runAsync(
    `INSERT INTO checklist (item_id, packed, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET packed = excluded.packed, updated_at = excluded.updated_at`,
    itemId,
    packed ? 1 : 0,
    Date.now(),
  );
}

/** Used by the settings screen's "erase everything" action. */
export async function eraseAllData(): Promise<void> {
  const instance = await db();
  await instance.execAsync(`
    DELETE FROM messages;
    DELETE FROM peers;
    DELETE FROM alerts;
    DELETE FROM checklist;
    DELETE FROM settings;
  `);
}
