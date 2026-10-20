import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubAuth, stubRedmine, testConfig } from '../test-support.js';
import { genericModule } from './generic.js';
import { GROUP_NAMES, PRESETS, consentScopesFor, loginScopesFor, resolveGroupsDetailed } from './groups.js';

describe('groups catalogue', () => {
  it('covers every domain group exactly once', () => {
    assert.deepEqual(GROUP_NAMES, [
      'issues',
      'projects',
      'users',
      'time',
      'wiki',
      'files',
      'search',
      'queries',
      'admin',
    ]);
  });

  it('resolves presets and drops admin without org mode', () => {
    assert.deepEqual(resolveGroupsDetailed(undefined, undefined, false).groups, PRESETS['personal']!.groups);
    const all = resolveGroupsDetailed(undefined, 'all', true);
    assert.deepEqual(all.groups, GROUP_NAMES);
    assert.deepEqual(all.droppedGroups, []);
    const dropped = resolveGroupsDetailed(undefined, 'all', false);
    assert.deepEqual(dropped.droppedGroups, ['admin']);
  });

  it('builds consent from tools plus groups', () => {
    const config = testConfig({ groups: ['issues'] });
    const tools = [
      { scopes: ['view_issues', 'extra_scope'], write: false },
      { scopes: ['delete_issues'], write: true },
    ] as unknown as Parameters<typeof consentScopesFor>[1];
    assert.ok(consentScopesFor(config, tools).includes('extra_scope'));
    const readOnly = testConfig({ groups: ['issues'], readOnly: true });
    assert.ok(!consentScopesFor(readOnly, tools).includes('delete_issues'));
    assert.deepEqual(loginScopesFor(config, ['admin']).filter((s) => s === 'admin'), ['admin']);
  });
});

describe('generic tools', () => {
  function build(auth = stubAuth()) {
    const config = testConfig({ groups: ['issues'] });
    const { client } = stubRedmine({ '/users/current.json': { data: { user: { login: 'jdoe' } } } });
    return {
      config,
      tools: genericModule.build({ redmine: client, config, auth, consentScopes: () => ['view_issues'] }),
    };
  }

  it('auth_begin_login returns immediately and status polls the background attempt', async () => {
    let release!: (account: { login: string; id: number }) => void;
    const gate = new Promise<{ login: string; id: number }>((resolve) => {
      release = resolve;
    });
    const auth = stubAuth({ login: () => gate as Promise<never> });
    const { tools } = build(auth);
    const begin = tools.find((tool) => tool.name === 'auth_begin_login')!;
    const status = tools.find((tool) => tool.name === 'auth_login_status')!;
    const pending = (await begin.handler({})) as { state: string };
    assert.equal(pending.state, 'pending');
    const polling = (await status.handler({})) as { state: string };
    assert.equal(polling.state, 'pending');
    release({ login: 'jdoe', id: 1 });
    await gate;
    const done = (await status.handler({})) as { state: string };
    assert.equal(done.state, 'signedIn');
  });

  it('session_status reports account, reachability, and checklist', async () => {
    const auth = stubAuth({
      getAccount: async () => ({ login: 'jdoe', id: 1 }),
      sessionHealth: async () => ({ credentialUsable: true, note: 'fresh' }),
    } as Partial<Parameters<typeof stubAuth>[0]> as never);
    const { tools } = build(auth);
    const status = tools.find((tool) => tool.name === 'session_status')!;
    const result = (await status.handler({})) as {
      account: { login: string };
      reachable: { ok: boolean };
      consentChecklist: string[];
    };
    assert.equal(result.account.login, 'jdoe');
    assert.equal(result.reachable.ok, true);
    assert.deepEqual(result.consentChecklist, ['view_issues']);
  });

  it('redmine_request pins paths and gates writes', async () => {
    const { tools } = build();
    const raw = tools.find((tool) => tool.name === 'redmine_request')!;
    await assert.rejects(raw.handler({ path: 'https://evil.example/x', method: 'GET' }), /non-relative/);
    await assert.rejects(raw.handler({ path: '/issues.json', method: 'DELETE' }), /--allow-generic-write/);
    await assert.rejects(raw.handler({ path: '/oauth/token', method: 'GET' }), /OAuth/);
  });

  it('redmine_list_permissions names per-tool admin flags', async () => {
    const { tools } = build();
    const list = tools.find((tool) => tool.name === 'redmine_list_permissions')!;
    const result = (await list.handler({})) as {
      groups: { name: string; adminOnlyTools: string[] }[];
    };
    const users = result.groups.find((group) => group.name === 'users')!;
    assert.deepEqual(users.adminOnlyTools, ['users_list']);
    const issues = result.groups.find((group) => group.name === 'issues')!;
    assert.deepEqual(issues.adminOnlyTools, []);
  });
});
