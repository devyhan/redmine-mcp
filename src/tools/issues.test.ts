import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubAuth, stubRedmine, testConfig } from '../test-support.js';
import { RedmineError } from '../contracts.js';
import { GROUPS } from './groups.js';
import { issuesModule } from './issues.js';
import { usersModule } from './users.js';
import { buildDiscoveryTools } from './discovery.js';

describe('issues tools', () => {
  it('lists with filters and returns total_count', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client, seen } = stubRedmine({
      '/issues.json': { data: { issues: [{ id: 1 }], total_count: 42 }, totalCount: 42 },
    });
    const [list] = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const result = (await list!.handler({ project_id: 'demo', status_id: 'open', limit: 10 })) as {
      total_count?: number;
      issues: unknown[];
    };
    assert.equal(result.total_count, 42);
    assert.equal(result.issues.length, 1);
    assert.equal(seen[0]!.query?.['project_id'], 'demo');
    assert.equal(seen[0]!.query?.['status_id'], 'open');
  });

  it('creates under the issue envelope', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client, seen } = stubRedmine({
      '/issues.json': { status: 201, data: { issue: { id: 9 } } },
    });
    const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const create = tools.find((tool) => tool.name === 'issues_create')!;
    const result = (await create.handler({ project_id: 1, subject: 'hi' })) as { id: number };
    assert.equal(result.id, 9);
    assert.equal(seen[0]!.method, 'POST');
    assert.deepEqual(seen[0]!.body, { issue: { project_id: 1, subject: 'hi' } });
  });

  it('resolves assignee names to ids before the call', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client, seen } = stubRedmine({
      '/users.json': { data: { users: [{ id: 7, login: 'jdoe', firstname: 'Jane', lastname: 'Doe' }] } },
      '/issues.json': { status: 201, data: { issue: { id: 9 } } },
    });
    const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const create = tools.find((tool) => tool.name === 'issues_create')!;
    await create.handler({ project_id: 1, subject: 'hi', assigned_to_id: 'jdoe' });
    assert.deepEqual(seen[1]!.body, { issue: { project_id: 1, subject: 'hi', assigned_to_id: 7 } });
  });

  it('passes assignee ids and "me" through without resolving', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client, seen } = stubRedmine({
      '/issues.json': { data: { issues: [], total_count: 0 }, totalCount: 0 },
    });
    const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const list = tools.find((tool) => tool.name === 'issues_list')!;
    await list.handler({ assigned_to_id: 'me' });
    await list.handler({ assigned_to_id: 7 });
    assert.deepEqual(
      seen.map((req) => req.query?.['assigned_to_id']),
      ['me', 7],
    );
  });

  it('belongs to the issues group catalogue', () => {
    assert.equal(issuesModule.group, GROUPS['issues']);
  });

  it('validates list and get results against their output schemas', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client } = stubRedmine({
      '/issues.json': {
        data: { issues: [{ id: 1, subject: 'Hi', custom_fields: [{ id: 2, value: 'x' }] }], total_count: 1 },
        totalCount: 1,
      },
      '/issues/1.json': { data: { issue: { id: 1, subject: 'Hi', custom_fields: [{ id: 2, value: 'x' }] } } },
    });
    const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const list = tools.find((tool) => tool.name === 'issues_list')!;
    assert.ok(list.outputSchema !== undefined);
    const listed = await list.handler({});
    assert.deepEqual(list.outputSchema.parse(listed), listed);
    const get = tools.find((tool) => tool.name === 'issues_get')!;
    assert.ok(get.outputSchema !== undefined);
    const one = await get.handler({ id: 1 });
    assert.deepEqual(get.outputSchema.parse(one), one);
  });

  it('explains 403 on get as per-object visibility, not a malformed call', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client } = stubRedmine({
      '/issues/1.json': () => {
        throw new RedmineError({ message: 'Forbidden', status: 403, path: '/issues/1.json' });
      },
    });
    const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const get = tools.find((tool) => tool.name === 'issues_get')!;
    await assert.rejects(get.handler({ id: 1 }), (error: unknown) => {
      assert.ok(error instanceof RedmineError);
      assert.equal(error.status, 403);
      assert.match(error.hint ?? '', /users_my_access/);
      assert.match(error.hint ?? '', /Retrying the id cannot help/);
      return true;
    });
  });
});

describe('discovery tools', () => {
  it('finds tools by keyword and dispatches call_tool', async () => {
    const config = testConfig({ groups: ['issues'] });
    const { client } = stubRedmine({ '/issues.json': { data: { issues: [], total_count: 0 }, totalCount: 0 } });
    const catalogue = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const [discover, call] = buildDiscoveryTools(catalogue, config);
    const found = (await discover!.handler({ query: 'create issue' })) as { matches: { name: string }[] };
    assert.ok(found.matches.some((match) => match.name === 'issues_create'));
    const called = (await call!.handler({ name: 'issues_list', arguments: {} })) as { total_count?: number };
    assert.equal(called.total_count, 0);
  });

  it('explains suppressed writes under --read-only instead of hiding them', async () => {
    const config = testConfig({ groups: ['issues'], readOnly: true });
    const { client } = stubRedmine({});
    const catalogue = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const [, call] = buildDiscoveryTools(catalogue, config);
    await assert.rejects(call!.handler({ name: 'issues_delete', arguments: { id: 1 } }), /--read-only/);
    await assert.rejects(call!.handler({ name: 'nope', arguments: {} }), /Unknown tool/);
  });

  it('refuses admin-only tools without --org-mode instead of calling them', async () => {
    const config = testConfig({ groups: ['users'] });
    const { client } = stubRedmine({});
    const catalogue = usersModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
    const [discover, call] = buildDiscoveryTools(catalogue, config);
    const found = (await discover!.handler({ query: 'list users' })) as { matches: { name: string }[] };
    assert.ok(!found.matches.some((match) => match.name === 'users_list'));
    await assert.rejects(call!.handler({ name: 'users_list', arguments: {} }), /--org-mode/);
  });
});
