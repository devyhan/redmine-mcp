/**
 * Encrypted on-disk session storage.
 *
 * Layout inside `cacheDir`:
 * - `cache.key` — 32 random bytes, mode 0600. The key-encryption key.
 * - `token-cache.enc` — AES-256-GCM blob holding the OAuth tokens or the
 *   API-key binding, mode 0600.
 * - `identity-cache.enc` — AES-256-GCM blob holding the `IdentityRecord`,
 *   mode 0600. Survives token wipes; dies with key rotation.
 *
 * Writes are atomic (tmp + rename) and serialised per directory with a
 * promise mutex. A corrupt cache is discarded to a clean re-login, never
 * partially trusted.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { IdentityRecord } from '../contracts.js';
import { logger } from '../util/logger.js';

/** What the encrypted token blob holds. Exactly one credential kind is set. */
export interface StoredSession {
  redmineUrl: string;
  clientId: string;
  kind: 'oauth' | 'apikey';
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, when the server said so. */
  expiresAt?: number;
  scopes: string[];
  apiKey?: string;
  updatedAt: string;
}

const KEY_FILE = 'cache.key';
const TOKEN_FILE = 'token-cache.enc';
const IDENTITY_FILE = 'identity-cache.enc';

/** Per-directory write mutexes. */
const locks = new Map<string, Promise<void>>();

async function runExclusive<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(dir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(dir, previous.then(() => current));
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(dir) === current.then(() => undefined)) locks.delete(dir);
  }
}

async function writeSecret(file: string, data: Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

async function readKey(dir: string): Promise<Buffer> {
  const file = path.join(dir, KEY_FILE);
  try {
    const raw = await readFile(file);
    if (raw.length !== 32) throw new Error(`bad key length ${raw.length}`);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const key = randomBytes(32);
      await writeSecret(file, key);
      return key;
    }
    throw error;
  }
}

function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Reads the stored session, or null when none exists. Discards corruption. */
export async function readSession(dir: string): Promise<StoredSession | null> {
  const file = path.join(dir, TOKEN_FILE);
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const key = await readKey(dir);
    return JSON.parse(decrypt(key, blob)) as StoredSession;
  } catch (error) {
    logger.warn('Token cache is corrupt; discarding to a clean re-login.', {
      error: error instanceof Error ? error.message : String(error),
    });
    await unlink(file).catch(() => undefined);
    return null;
  }
}

/** Stores the session, creating the key on first use. */
export async function writeSession(dir: string, session: StoredSession): Promise<void> {
  await runExclusive(dir, async () => {
    const key = await readKey(dir);
    await writeSecret(path.join(dir, TOKEN_FILE), encrypt(key, JSON.stringify(session)));
  });
}

/** Removes tokens but keeps the identity snapshot and the key. */
export async function clearSession(dir: string): Promise<void> {
  await runExclusive(dir, async () => {
    await unlink(path.join(dir, TOKEN_FILE)).catch(() => undefined);
  });
}

/** Removes everything: tokens, identity, and the key itself. */
export async function clearCache(dir: string): Promise<void> {
  await runExclusive(dir, async () => {
    await Promise.all(
      [TOKEN_FILE, IDENTITY_FILE, KEY_FILE].map((name) => unlink(path.join(dir, name)).catch(() => undefined)),
    );
  });
}

/** Reads the login-time identity snapshot, or null when none exists. */
export async function readIdentity(dir: string): Promise<IdentityRecord | null> {
  const file = path.join(dir, IDENTITY_FILE);
  let blob: Buffer;
  try {
    blob = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const key = await readKey(dir);
    return JSON.parse(decrypt(key, blob)) as IdentityRecord;
  } catch {
    await unlink(file).catch(() => undefined);
    return null;
  }
}

/** Stores the login-time identity snapshot. */
export async function writeIdentity(dir: string, identity: IdentityRecord): Promise<void> {
  await runExclusive(dir, async () => {
    const key = await readKey(dir);
    await writeSecret(path.join(dir, IDENTITY_FILE), encrypt(key, JSON.stringify(identity)));
  });
}

/** Renders the snapshot as the one attribution line tools prepend. */
export function formatIdentityLine(identity: IdentityRecord): string {
  const name = [identity.firstname, identity.lastname].filter(Boolean).join(' ');
  const who = name !== '' ? `${identity.login} (${name})` : identity.login;
  return `[Redmine session: ${who} @ ${identity.redmineUrl}]`;
}

/** True when the stored access token is missing or within the expiry skew. */
export function accessTokenExpired(session: StoredSession, nowMs = Date.now()): boolean {
  if (session.kind !== 'oauth' || !session.accessToken) return true;
  if (session.expiresAt === undefined) return false;
  return nowMs >= session.expiresAt - 60_000;
}
