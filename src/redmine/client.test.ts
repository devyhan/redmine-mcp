import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InteractionRequiredError, RedmineError } from '../contracts.js';
import { stubAuth, testConfig } from '../test-support.js';
import { createRedmineClient } from './client.js';

function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

describe('redmine client', () => {
  it('injects the bearer credential and parses JSON', async () => {
    const seen: Record<string, string> = {};
    const fetchImpl = (async (url: URL, init?: RequestInit) => {
      Object.assign(seen, (init?.headers ?? {}) as Record<string, string>);
      assert.ok(String(url).startsWith('https://redmine.example.com/issues.json'));
      return jsonResponse(200, { issues: [{ id: 1 }], total_count: 1 });
    }) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    const res = await client.request<{ issues: unknown[] }>({ path: '/issues.json', scopes: ['view_issues'] });
    assert.equal(res.status, 200);
    assert.equal(res.totalCount, 1);
    assert.equal(seen['Authorization'], 'Bearer test-token');
  });

  it('sends API keys as X-Redmine-API-Key', async () => {
    let header = '';
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      header = ((init?.headers ?? {}) as Record<string, string>)['X-Redmine-API-Key'] ?? '';
      return jsonResponse(200, {});
    }) as typeof fetch;
    const auth = stubAuth({ getCredential: async () => ({ scheme: 'apiKey', value: 'key123' }) });
    const client = createRedmineClient({ auth, config: testConfig(), fetchImpl });
    await client.request({ path: '/users/current.json', scopes: [] });
    assert.equal(header, 'key123');
  });

  it('maps failures to RedmineError with hints', async () => {
    const fetchImpl = (async () => jsonResponse(422, { errors: ['Subject cannot be blank'] })) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    await assert.rejects(
      client.request({ path: '/issues.json', method: 'POST', body: {}, scopes: [] }),
      (error: unknown) =>
        error instanceof RedmineError && error.status === 422 && /Subject/.test(error.message) && !!error.hint,
    );
  });

  it('refuses to leave the Redmine host', async () => {
    const fetchImpl = (async () => jsonResponse(200, {})) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    await assert.rejects(client.request({ path: 'https://evil.example/x.json', scopes: [] }), RedmineError);
  });

  it('refuses to follow redirects', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    await assert.rejects(client.request({ path: '/issues.json', scopes: [] }), RedmineError);
  });

  it('retries idempotent reads on 503, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2 ? jsonResponse(503, {}) : jsonResponse(200, { issues: [] });
    }) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    const res = await client.request({ path: '/issues.json', scopes: [] });
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });

  it('merges offset pages into one collection', async () => {
    const fetchImpl = (async (url: URL) => {
      const u = new URL(String(url));
      const offset = Number(u.searchParams.get('offset') ?? '0');
      const issues = offset === 0 ? [{ id: 1 }] : [{ id: 2 }];
      return jsonResponse(200, { issues, total_count: 2, offset, limit: 1 });
    }) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    const res = await client.request<{ issues: { id: number }[] }>({
      path: '/issues.json',
      query: { limit: 1 },
      maxPages: 3,
      scopes: [],
    });
    assert.deepEqual(
      res.data.issues.map((issue) => issue.id),
      [1, 2],
    );
  });

  it('turns transport failures into network InteractionRequiredError', async () => {
    const failure = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
    const fetchImpl = (async () => {
      throw failure;
    }) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    await assert.rejects(
      client.request({ path: '/issues.json', scopes: [] }),
      (error: unknown) => error instanceof InteractionRequiredError && error.networkFailure,
    );
  });

  it('requestRaw round-trips bytes for uploads', async () => {
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'text/plain');
      return new Response(JSON.stringify({ upload: { token: 'tok' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createRedmineClient({ auth: stubAuth(), config: testConfig(), fetchImpl });
    const res = await client.requestRaw({
      path: '/uploads.json',
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
      contentType: 'text/plain',
      scopes: [],
    });
    assert.equal(res.status, 201);
    assert.match(Buffer.from(res.bytes).toString('utf8'), /"token":"tok"/);
  });
});
