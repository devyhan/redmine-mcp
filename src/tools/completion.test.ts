import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { stubAuth, stubRedmine, testConfig } from '../test-support.js';
import { RedmineError } from '../contracts.js';
import {
  createIssueCompleters,
  fieldCompleter,
  isCompletable,
  shapeField,
  withCompleter,
} from './completion.js';
import { issuesModule } from './issues.js';

function buildIssueTools(paths: Record<string, unknown>) {
  const config = testConfig({ groups: ['issues'] });
  const { client, seen } = stubRedmine(paths as never);
  const tools = issuesModule.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
  return { tools, seen };
}

describe('completer metadata', () => {
  it('stamps the SDK symbol and reads through one optional layer', async () => {
    const inner = withCompleter(z.string(), async () => ['a']);
    assert.equal(isCompletable(inner), true);
    assert.deepEqual(await fieldCompleter(inner)!(''), ['a']);
    const outer = withCompleter(z.string(), async () => ['b']).optional();
    assert.equal(isCompletable(outer), true);
    assert.deepEqual(await fieldCompleter(outer)!(''), ['b']);
    assert.equal(isCompletable(z.string()), false);
    assert.equal(fieldCompleter(undefined), undefined);
  });

  it('matches the SDK isCompletable shape', async () => {
    const { isCompletable: sdkIsCompletable } = await import('@modelcontextprotocol/server');
    assert.equal(sdkIsCompletable(withCompleter(z.string(), async () => [])), true);
    assert.equal(sdkIsCompletable(z.string()), false);
  });
});

describe('issue completers', () => {
  it('completes project identifiers by name or slug substring', async () => {
    const { client } = stubRedmine({
      '/projects.json': {
        data: {
          projects: [
            { id: 1, identifier: 'demo', name: 'Demo project' },
            { id: 2, identifier: 'infra', name: 'Infrastructure' },
          ],
        },
      },
    });
    const { completeProject } = createIssueCompleters({ redmine: client });
    assert.deepEqual(await completeProject('infra'), ['infra']);
    assert.deepEqual(await completeProject('demo'), ['demo']);
    assert.deepEqual(await completeProject(''), ['demo', 'infra']);
    assert.deepEqual(await completeProject('zzz'), []);
  });

  it('caches list responses briefly', async () => {
    let now = 1_000;
    const { client, seen } = stubRedmine({ '/trackers.json': { data: { trackers: [{ id: 1, name: 'Bug' }] } } });
    const { completeTracker } = createIssueCompleters({ redmine: client, ttlMs: 60_000, now: () => now });
    assert.deepEqual(await completeTracker('bug'), ['1']);
    assert.deepEqual(await completeTracker('bug'), ['1']);
    assert.equal(seen.length, 1);
    now += 60_001;
    assert.deepEqual(await completeTracker('bug'), ['1']);
    assert.equal(seen.length, 2);
  });

  it('completes trackers and statuses as numeric-id strings', async () => {
    const { client } = stubRedmine({
      '/trackers.json': { data: { trackers: [{ id: 1, name: 'Bug' }, { id: 2, name: 'Feature' }] } },
      '/issue_statuses.json': { data: { issue_statuses: [{ id: 1, name: 'New' }, { id: 5, name: 'Closed' }] } },
    });
    const { completeTracker, completeStatus } = createIssueCompleters({ redmine: client });
    assert.deepEqual(await completeTracker('fea'), ['2']);
    assert.deepEqual(await completeTracker('1'), ['1']);
    assert.deepEqual(await completeStatus('closed'), ['5']);
    assert.deepEqual(await completeStatus(''), ['1', '5']);
  });

  it('completes assignees from user search plus me', async () => {
    const { client } = stubRedmine({
      '/users.json': { data: { users: [{ id: 7, login: 'jdoe', firstname: 'Jane', lastname: 'Doe' }] } },
    });
    const { completeAssignee } = createIssueCompleters({ redmine: client });
    assert.deepEqual(await completeAssignee('jdoe'), ['7']);
    assert.deepEqual(await completeAssignee(''), ['me', '7']);
    assert.deepEqual(await completeAssignee('me'), ['me']);
  });

  it('falls back to project memberships when user search is forbidden', async () => {
    const { client, seen } = stubRedmine({
      '/users.json': () => {
        throw new RedmineError({ message: 'Forbidden', status: 403, path: '/users.json' });
      },
      '/projects/demo/memberships.json': {
        data: { memberships: [{ id: 1, user: { id: 7, name: 'Jane Doe' } }] },
      },
    });
    const { completeAssignee } = createIssueCompleters({ redmine: client });
    const values = await completeAssignee('jane', { arguments: { project_id: 'demo' } });
    assert.deepEqual(values, ['7']);
    assert.ok(seen.some((req) => req.path === '/projects/demo/memberships.json'));
  });

  it('returns empty lists, never errors, on failure', async () => {
    const { client } = stubRedmine({
      '/projects.json': () => {
        throw new RedmineError({ message: 'boom', status: 500, path: '/projects.json' });
      },
      '/trackers.json': () => {
        throw new Error('network down');
      },
      '/issue_statuses.json': () => {
        throw new Error('network down');
      },
      '/users.json': () => {
        throw new Error('network down');
      },
    });
    const completers = createIssueCompleters({ redmine: client });
    assert.deepEqual(await completers.completeProject('x'), []);
    assert.deepEqual(await completers.completeTracker('x'), []);
    assert.deepEqual(await completers.completeStatus('x'), []);
    assert.deepEqual(await completers.completeAssignee('zzz', { arguments: { project_id: 'demo' } }), []);
  });
});

describe('issue tool wiring', () => {
  it('registers completers on project, tracker, status, and assignee args', async () => {
    const { tools, seen } = buildIssueTools({
      '/projects.json': { data: { projects: [{ id: 1, identifier: 'demo', name: 'Demo' }] } },
      '/trackers.json': { data: { trackers: [{ id: 1, name: 'Bug' }] } },
      '/issue_statuses.json': { data: { issue_statuses: [{ id: 1, name: 'New' }] } },
      '/users.json': { data: { users: [{ id: 7, login: 'jdoe' }] } },
    });
    const list = tools.find((tool) => tool.name === 'issues_list')!;
    for (const arg of ['project_id', 'tracker_id', 'status_id', 'assigned_to_id']) {
      assert.equal(isCompletable(shapeField(list.inputSchema, arg)), true, arg);
    }
    assert.equal(isCompletable(shapeField(list.inputSchema, 'subject')), false);
    const create = tools.find((tool) => tool.name === 'issues_create')!;
    assert.equal(isCompletable(shapeField(create.inputSchema, 'project_id')), true);
    const update = tools.find((tool) => tool.name === 'issues_update')!;
    assert.equal(isCompletable(shapeField(update.inputSchema, 'status_id')), true);
    assert.equal(isCompletable(shapeField(update.inputSchema, 'assigned_to_id')), true);

    // The registered callbacks answer from Redmine through the tool's client.
    const projectValues = await fieldCompleter(shapeField(list.inputSchema, 'project_id'))!('dem');
    assert.deepEqual(projectValues, ['demo']);
    assert.equal(seen[0]!.path, '/projects.json');
  });

  it('builds independent completer sets per build', async () => {
    const first = buildIssueTools({ '/projects.json': { data: { projects: [{ id: 1, identifier: 'one', name: 'One' }] } } });
    const second = buildIssueTools({ '/projects.json': { data: { projects: [{ id: 2, identifier: 'two', name: 'Two' }] } } });
    const completeFirst = fieldCompleter(
      shapeField(first.tools.find((tool) => tool.name === 'issues_list')!.inputSchema, 'project_id'),
    )!;
    const completeSecond = fieldCompleter(
      shapeField(second.tools.find((tool) => tool.name === 'issues_list')!.inputSchema, 'project_id'),
    )!;
    assert.deepEqual(await completeFirst(''), ['one']);
    assert.deepEqual(await completeSecond(''), ['two']);
  });
});
