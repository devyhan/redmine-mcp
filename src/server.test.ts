import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { InteractionRequiredError, type ToolDefinition } from './contracts.js';
import { scopeReadingOnlyAuth } from './auth/index.js';
import { stubAuth, stubRedmine, testConfig } from './test-support.js';
import {
  AGENT_START_PROMPT,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  collectTools,
  createServerFactory,
  exposedToolNames,
  formatToolResult,
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

  it('suppresses admin-only tools without --org-mode', () => {
    const names = catalogueNames(['users']);
    assert.ok(names.includes('users_my_access'));
    assert.ok(!names.includes('users_list'));
    const org = catalogueNames(['users'], { orgMode: true });
    assert.ok(org.includes('users_list'));
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

describe('structured results', () => {
  it('returns structuredContent only when the tool declares an outputSchema', async () => {
    const config = testConfig({ groups: ['issues'] });
    const base: ToolDefinition = {
      name: 'issues_list',
      title: 't',
      description: 'd',
      inputSchema: z.object({}),
      scopes: [],
      group: 'issues',
      handler: async () => ({}),
    };
    const value = { total_count: 1, issues: [{ id: 1, subject: 'Hi' }] };
    const withSchema = await formatToolResult({ ...base, outputSchema: z.object({}) }, value, config);
    assert.deepEqual(withSchema.structuredContent, value);
    const without = await formatToolResult({ ...base }, value, config);
    assert.equal('structuredContent' in without, false);
  });

  it('appends resource links while keeping the text intact', async () => {
    const config = testConfig({ groups: ['issues'] });
    const def: ToolDefinition = {
      name: 'issues_list',
      title: 't',
      description: 'd',
      inputSchema: z.object({}),
      scopes: [],
      group: 'issues',
      handler: async () => ({}),
    };
    const value = { total_count: 1, issues: [{ id: 1, subject: 'Hi' }] };
    const result = await formatToolResult({ ...def }, value, config);
    assert.equal(result.content[0]!.type, 'text');
    assert.match(result.content[0]!.text, /"total_count": 1/);
    assert.equal(result.content.length, 2);
    assert.deepEqual(result.content[1], {
      type: 'resource_link',
      uri: 'https://redmine.example.com/issues/1',
      name: '#1 Hi',
      mimeType: 'text/html',
    });
  });

  it('registers outputSchema through to the SDK tool', () => {
    const config = testConfig({ groups: ['issues', 'projects', 'users'] });
    const { client } = stubRedmine({});
    const auth = stubAuth();
    const tools = collectTools({ redmine: client, config, auth, consentScopes: () => [] });
    const server = createServerFactory({ config, redmine: client, auth, tools })();
    const registered = (server as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })
      ._registeredTools;
    for (const name of ['issues_list', 'issues_get', 'projects_list', 'users_my_access']) {
      assert.notEqual(registered[name]!.outputSchema, undefined, name);
    }
    assert.equal(registered['issues_delete']!.outputSchema, undefined);
  });
});
