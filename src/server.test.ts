import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InteractionRequiredError } from './contracts.js';
import { scopeReadingOnlyAuth } from './auth/index.js';
import { stubAuth, stubRedmine, testConfig } from './test-support.js';
import {
  AGENT_START_PROMPT,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  collectTools,
  exposedToolNames,
  signInMessage,
} from './server.js';

function catalogueNames(groups: string[], overrides = {}) {
  const config = testConfig({ groups, ...overrides });
  const { client } = stubRedmine({});
  const tools = collectTools({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] });
  return exposedToolNames(tools, config);
}

describe('server assembly', () => {
  it('pins the server name and instructions', () => {
    assert.equal(SERVER_NAME, 'redmine-mcp');
    assert.equal(
      SERVER_INSTRUCTIONS,
      'Call session_status once first. Sign in via auth_begin_login and auth_login_status; ' +
        'never ask for credentials. Orient via discover_tools. On errors read Hint/Blocked-by ' +
        'lines; re-login adds only missing scopes.',
    );
    assert.equal(AGENT_START_PROMPT.name, 'agent_start');
  });

  it('collects domain tools plus the generic module', () => {
    const names = catalogueNames(['issues']);
    assert.ok(names.includes('issues_list'));
    assert.ok(names.includes('issues_create'));
    assert.ok(names.includes('session_status'));
    assert.ok(names.includes('auth_begin_login'));
    assert.ok(names.includes('redmine_request'));
    assert.ok(!names.includes('projects_list'));
  });

  it('suppresses writes under --read-only', () => {
    const names = catalogueNames(['issues'], { readOnly: true });
    assert.ok(names.includes('issues_list'));
    assert.ok(!names.includes('issues_create'));
    assert.ok(!names.includes('issues_delete'));
    assert.ok(!names.includes('redmine_request'));
  });

  it('collapses to the discovery pair plus session tools under --discovery', () => {
    const names = catalogueNames(['issues', 'projects'], { discovery: true });
    assert.deepEqual(names, [
      'discover_tools',
      'call_tool',
      'auth_begin_login',
      'auth_login_status',
      'session_status',
      'redmine_list_permissions',
    ]);
  });

  it('names the fix per InteractionRequiredError flag', () => {
    assert.match(signInMessage(new InteractionRequiredError('x', [], true)), /server configuration/);
    assert.match(signInMessage(new InteractionRequiredError('x', ['admin'])), /missing application scopes/);
    assert.match(signInMessage(new InteractionRequiredError('x', [], false, true)), /network failure/);
    assert.match(signInMessage(new InteractionRequiredError('x', [], false, false, true)), /loopback/);
    assert.match(signInMessage(new InteractionRequiredError('plain')), /auth_begin_login/);
  });

  it('refuses auth on the scope-reading provider', async () => {
    const auth = scopeReadingOnlyAuth();
    await assert.rejects(auth.getCredential([]), InteractionRequiredError);
    assert.equal(await auth.getAccount(), null);
  });
});
