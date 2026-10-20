import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubAuth, stubRedmine, testConfig } from '../test-support.js';
import { GROUPS } from './groups.js';
import { issuesModule } from './issues.js';
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

  it('belongs to the issues group catalogue', () => {
    assert.equal(issuesModule.group, GROUPS['issues']);
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
});
