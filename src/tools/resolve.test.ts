import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubRedmine } from '../test-support.js';
import { RedmineError } from '../contracts.js';
import { resolveAssignee } from './resolve.js';

const JANE = { id: 7, login: 'jdoe', firstname: 'Jane', lastname: 'Doe', mail: 'jane.doe@example.com' };
const JOHN = { id: 8, login: 'jsmith', firstname: 'John', lastname: 'Smith', mail: 'john.smith@example.com' };

describe('resolveAssignee', () => {
  it('passes numbers and numeric strings through without a Redmine call', async () => {
    const { client, seen } = stubRedmine({});
    assert.equal(await resolveAssignee(client, 7), 7);
    assert.equal(await resolveAssignee(client, '8'), 8);
    assert.equal(seen.length, 0);
  });

  it('passes "me" through only when the caller allows it', async () => {
    const { client, seen } = stubRedmine({});
    assert.equal(await resolveAssignee(client, 'me', { allowMe: true }), 'me');
    assert.equal(seen.length, 0);
    await assert.rejects(resolveAssignee(client, 'me'), (error: unknown) => {
      assert.ok(error instanceof RedmineError);
      assert.match(error.message, /only accepted by issues_list/);
      assert.match(error.hint ?? '', /users_get_current/);
      return true;
    });
  });

  it('prefers exact matches: login, then full name, then mail', async () => {
    // `jdoe` is a login-exact hit even though both fixtures contain "jdo".
    const { client } = stubRedmine({ '/users.json': { data: { users: [JANE, JOHN] } } });
    assert.equal(await resolveAssignee(client, 'jdoe'), 7);
    assert.equal(await resolveAssignee(client, 'Jane Doe'), 7);
    assert.equal(await resolveAssignee(client, 'JANE DOE'), 7);
    assert.equal(await resolveAssignee(client, 'john.smith@example.com'), 8);
  });

  it('accepts an unambiguous contains match', async () => {
    const { client, seen } = stubRedmine({ '/users.json': { data: { users: [JANE, JOHN] } } });
    assert.equal(await resolveAssignee(client, 'smith'), 8);
    assert.equal(seen[0]!.query?.['name'], 'smith');
  });

  it('rejects ambiguous names naming only login, name, and id', async () => {
    const { client } = stubRedmine({ '/users.json': { data: { users: [JANE, JOHN] } } });
    await assert.rejects(resolveAssignee(client, 'j'), (error: unknown) => {
      assert.ok(error instanceof RedmineError);
      assert.equal(error.status, 422);
      assert.match(error.message, /Ambiguous assignee "j"/);
      assert.match(error.hint ?? '', /jdoe \(Jane Doe\), id 7/);
      assert.match(error.hint ?? '', /jsmith \(John Smith\), id 8/);
      assert.match(error.hint ?? '', /numeric id/);
      return true;
    });
  });

  it('rejects unknown names with the fix, not a guess', async () => {
    const { client } = stubRedmine({ '/users.json': { data: { users: [JANE] } } });
    await assert.rejects(resolveAssignee(client, 'nobody here'), (error: unknown) => {
      assert.ok(error instanceof RedmineError);
      assert.equal(error.status, 404);
      assert.match(error.message, /Unknown assignee "nobody here"/);
      assert.match(error.hint ?? '', /numeric user id/);
      return true;
    });
  });

  it('falls back to project memberships when the user index refuses', async () => {
    const { client, seen } = stubRedmine({
      '/users.json': () => {
        throw new RedmineError({ message: 'Forbidden', status: 403, path: '/users.json' });
      },
      '/projects/demo/memberships.json': {
        data: { memberships: [{ id: 1, user: { id: 7, name: 'Jane Doe' } }] },
      },
    });
    assert.equal(await resolveAssignee(client, 'Jane Doe', { project: 'demo' }), 7);
    assert.ok(seen.some((req) => req.path === '/projects/demo/memberships.json'));
    await assert.rejects(resolveAssignee(client, 'nobody', { project: 'demo' }), /Unknown assignee/);
  });

  it('explains the admin-only index when no project scopes a fallback', async () => {
    const { client } = stubRedmine({
      '/users.json': () => {
        throw new RedmineError({ message: 'Forbidden', status: 403, path: '/users.json' });
      },
    });
    await assert.rejects(resolveAssignee(client, 'jane'), (error: unknown) => {
      assert.ok(error instanceof RedmineError);
      assert.equal(error.status, 403);
      assert.match(error.message, /admin-only/);
      assert.match(error.hint ?? '', /numeric user id/);
      return true;
    });
  });

  it('never leaks mail addresses or raw user objects in errors', async () => {
    const leak = /@example\.com|firstname|lastname|admin|hashed|api/i;
    const { client } = stubRedmine({ '/users.json': { data: { users: [JANE, JOHN] } } });
    for (const value of ['j', 'zzz-no-such-user', 'me']) {
      await assert.rejects(resolveAssignee(client, value), (error: unknown) => {
        assert.ok(error instanceof RedmineError);
        assert.doesNotMatch(error.message, leak);
        assert.doesNotMatch(error.hint ?? '', leak);
        assert.doesNotMatch(String(error.status), leak);
        return true;
      });
    }
    // Success carries the id alone.
    assert.equal(await resolveAssignee(client, 'jane.doe@example.com'), 7);
  });

  it('rejects empty assignees instead of querying', async () => {
    const { client, seen } = stubRedmine({});
    await assert.rejects(resolveAssignee(client, '   '), /must not be empty/);
    assert.equal(seen.length, 0);
  });
});
