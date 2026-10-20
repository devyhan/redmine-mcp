import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  accessTokenExpired,
  clearCache,
  clearSession,
  formatIdentityLine,
  readIdentity,
  readSession,
  writeIdentity,
  writeSession,
} from './token-cache.js';

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'redmine-mcp-cache-test-'));
}

describe('token-cache', () => {
  it('round-trips an OAuth session', async () => {
    const dir = await freshDir();
    try {
      assert.equal(await readSession(dir), null);
      await writeSession(dir, {
        redmineUrl: 'https://redmine.example.com',
        clientId: 'cid',
        kind: 'oauth',
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600_000,
        scopes: ['view_issues'],
        updatedAt: new Date().toISOString(),
      });
      const back = await readSession(dir);
      assert.equal(back?.accessToken, 'access');
      assert.equal(back?.refreshToken, 'refresh');
      // The blob on disk must not contain the token in cleartext.
      const raw = await readFile(path.join(dir, 'token-cache.enc'), 'utf8');
      assert.ok(!raw.includes('access'));
      const key = await readFile(path.join(dir, 'cache.key'));
      assert.equal(key.length, 32);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discards a corrupt cache to a clean re-login', async () => {
    const dir = await freshDir();
    try {
      await writeSession(dir, {
        redmineUrl: 'https://x.example',
        clientId: '',
        kind: 'apikey',
        scopes: [],
        apiKey: 'k',
        updatedAt: new Date().toISOString(),
      });
      await writeFile(path.join(dir, 'token-cache.enc'), Buffer.from('garbage'));
      assert.equal(await readSession(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps identity across session clears and formats the line', async () => {
    const dir = await freshDir();
    try {
      await writeIdentity(dir, {
        id: 7,
        login: 'jdoe',
        firstname: 'Jane',
        lastname: 'Doe',
        redmineUrl: 'https://redmine.example.com',
        capturedAt: new Date().toISOString(),
        source: 'oauth-login',
      });
      await clearSession(dir);
      const identity = await readIdentity(dir);
      assert.equal(identity?.login, 'jdoe');
      assert.equal(
        formatIdentityLine(identity!),
        '[Redmine session: jdoe (Jane Doe) @ https://redmine.example.com]',
      );
      await clearCache(dir);
      assert.equal(await readIdentity(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects expired access tokens with skew', () => {
    const base = {
      redmineUrl: 'https://x.example',
      clientId: 'c',
      kind: 'oauth' as const,
      accessToken: 'a',
      scopes: [] as string[],
      updatedAt: new Date().toISOString(),
    };
    assert.equal(accessTokenExpired({ ...base, expiresAt: Date.now() + 30_000 }), true);
    assert.equal(accessTokenExpired({ ...base, expiresAt: Date.now() + 300_000 }), false);
    assert.equal(accessTokenExpired({ ...base, accessToken: undefined }), true);
  });
});
