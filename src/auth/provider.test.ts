import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { InteractionRequiredError } from '../contracts.js';
import { testConfig } from '../test-support.js';
import { credentialSource } from './index.js';
import { createAuthProvider } from './provider.js';
import { readSession, writeSession } from './token-cache.js';

async function freshDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'redmine-mcp-provider-test-'));
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

const CURRENT_USER = { user: { id: 7, login: 'jdoe', firstname: 'Jane', admin: false } };

interface RouteScript {
  authorize?: number | 'throw';
  current?: number;
}

/** Routes the provider's fetch calls: authorize probe + users/current only. */
function scriptedFetch(script: RouteScript): typeof fetch {
  return (async (url: URL) => {
    const href = String(url);
    if (href.includes('/oauth/authorize')) {
      if (script.authorize === 'throw') throw new Error('fetch failed');
      return new Response(null, { status: script.authorize ?? 400 });
    }
    if (href.includes('/users/current.json')) {
      const status = script.current ?? 200;
      return status === 200 ? jsonResponse(200, CURRENT_USER) : jsonResponse(status, {});
    }
    throw new Error(`unstubbed provider URL: ${href}`);
  }) as typeof fetch;
}

describe('provider API-key fallback', () => {
  it('uses a configured key directly with zero stored session', async () => {
    const dir = await freshDir();
    try {
      const auth = createAuthProvider({
        config: testConfig({ cacheDir: dir, apiKey: 'direct-key' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({}),
      });
      const credential = await auth.getCredential(['view_issues']);
      assert.deepEqual(credential, { scheme: 'apiKey', value: 'direct-key' });
      assert.equal(await readSession(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers the configured key over a stored OAuth session', async () => {
    const dir = await freshDir();
    try {
      await writeSession(dir, {
        redmineUrl: 'https://redmine.example.com',
        clientId: 'cid',
        kind: 'oauth',
        accessToken: 'stale-token',
        scopes: [],
        updatedAt: new Date().toISOString(),
      });
      const auth = createAuthProvider({
        config: testConfig({ cacheDir: dir, apiKey: 'direct-key' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({}),
      });
      const credential = await auth.getCredential([]);
      assert.equal(credential.value, 'direct-key');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('verifies a configured key on login without storing it', async () => {
    const dir = await freshDir();
    try {
      const auth = createAuthProvider({
        config: testConfig({ cacheDir: dir, apiKey: 'direct-key' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({}),
      });
      const account = await auth.login([]);
      assert.equal(account.login, 'jdoe');
      // Identity cached, key never written to disk.
      assert.equal(await readSession(dir), null);
      assert.equal((await auth.getAccount())?.login, 'jdoe');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails browser login fast when the provider route 404s', async () => {
    const dir = await freshDir();
    try {
      const auth = createAuthProvider({
        config: testConfig({ cacheDir: dir }),
        clientIdSource: { value: 'cid', origin: 'flag' },
        fetchImpl: scriptedFetch({ authorize: 404 }),
        openBrowser: async () => {
          throw new Error('browser must not open without a provider');
        },
      });
      await assert.rejects(
        auth.login(['view_issues'], 'browser'),
        (error: unknown) =>
          error instanceof InteractionRequiredError &&
          error.serverRefused &&
          /no OAuth provider/.test(error.message) &&
          /REDMINE_MCP_API_KEY/.test(error.message),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attempts the browser flow when the probe is inconclusive', async () => {
    const dir = await freshDir();
    try {
      const auth = createAuthProvider({
        // No client ID: reaching the client-ID gate proves the probe did not refuse.
        config: testConfig({ cacheDir: dir, clientId: '' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({ authorize: 'throw' }),
      });
      await assert.rejects(auth.login(['view_issues'], 'browser'), /No OAuth application is configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('probes a configured key in sessionHealth', async () => {
    const goodDir = await freshDir();
    const badDir = await freshDir();
    try {
      const good = createAuthProvider({
        config: testConfig({ cacheDir: goodDir, apiKey: 'direct-key' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({}),
      });
      assert.deepEqual(await good.sessionHealth!(), {
        credentialUsable: true,
        note: 'configured API key verified live',
      });
      const bad = createAuthProvider({
        config: testConfig({ cacheDir: badDir, apiKey: 'wrong-key' }),
        clientIdSource: { value: '', origin: 'unset' },
        fetchImpl: scriptedFetch({ current: 401 }),
      });
      const health = await bad.sessionHealth!();
      assert.equal(health.credentialUsable, false);
      assert.match(health.note ?? '', /refused/);
    } finally {
      await rm(goodDir, { recursive: true, force: true });
      await rm(badDir, { recursive: true, force: true });
    }
  });
});

describe('credentialSource', () => {
  it('labels env-key, stored-key, oauth, and none', async () => {
    const dir = await freshDir();
    try {
      const base = testConfig({ cacheDir: dir });
      assert.equal(await credentialSource(base), 'none');
      assert.equal(await credentialSource(testConfig({ cacheDir: dir, apiKey: 'k' })), 'env-key');

      await writeSession(dir, {
        redmineUrl: 'https://redmine.example.com',
        clientId: '',
        kind: 'apikey',
        scopes: [],
        apiKey: 'k',
        updatedAt: new Date().toISOString(),
      });
      assert.equal(await credentialSource(base), 'stored-key');

      await writeSession(dir, {
        redmineUrl: 'https://redmine.example.com',
        clientId: 'cid',
        kind: 'oauth',
        accessToken: 't',
        scopes: [],
        updatedAt: new Date().toISOString(),
      });
      assert.equal(await credentialSource(base), 'oauth');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
