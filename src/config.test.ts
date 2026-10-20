import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, parseConfig } from './config.js';

const URL = ['--redmine-url', 'https://redmine.example.com'];

describe('parseConfig', () => {
  it('serves by default with the personal preset groups', () => {
    const parsed = parseConfig([...URL]);
    assert.equal(parsed.command.kind, 'serve');
    assert.deepEqual(parsed.config.groups, ['issues', 'projects', 'users', 'time', 'wiki', 'files', 'search', 'queries']);
    assert.equal(parsed.config.redmineUrl, 'https://redmine.example.com');
  });

  it('strips trailing slashes from the Redmine URL', () => {
    const parsed = parseConfig(['--redmine-url', 'https://redmine.example.com///']);
    assert.equal(parsed.config.redmineUrl, 'https://redmine.example.com');
  });

  it('requires the Redmine URL', () => {
    assert.throws(() => parseConfig([]), ConfigError);
  });

  it('rejects unknown options and commands', () => {
    assert.throws(() => parseConfig([...URL, '--frobnicate']), ConfigError);
    assert.throws(() => parseConfig([...URL, 'frobnicate']), ConfigError);
  });

  it('rejects unknown groups and presets', () => {
    assert.throws(() => parseConfig([...URL, '--groups', 'issues,nope']), ConfigError);
    assert.throws(() => parseConfig([...URL, '--preset', 'nope']), ConfigError);
  });

  it('drops admin groups without --org-mode', () => {
    const parsed = parseConfig([...URL, '--preset', 'all']);
    assert.ok(!parsed.config.groups.includes('admin'));
    assert.deepEqual(parsed.config.droppedGroups, ['admin']);
    const org = parseConfig([...URL, '--preset', 'all', '--org-mode']);
    assert.ok(org.config.groups.includes('admin'));
  });

  it('parses login scopes, --full, and --api-key', () => {
    const scoped = parseConfig([...URL, 'login', '--scopes', 'view_issues, admin']);
    assert.deepEqual(scoped.command, { kind: 'login', scopes: ['view_issues', 'admin'], full: undefined, apiKey: undefined });
    const full = parseConfig([...URL, 'login', '--full']);
    assert.equal((full.command as { kind: string; full?: boolean }).full, true);
    const key = parseConfig([...URL, 'login', '--api-key', 'abc']);
    assert.equal((key.command as { kind: string; apiKey?: string }).apiKey, 'abc');
  });

  it('validates auth flow, output, port, and budgets', () => {
    assert.throws(() => parseConfig([...URL, '--auth-flow', 'oauth']), ConfigError);
    assert.throws(() => parseConfig([...URL, '--output', 'yaml']), ConfigError);
    assert.throws(() => parseConfig([...URL, '--auth-port', '80']), ConfigError);
    assert.throws(() => parseConfig([...URL, '--max-output-chars', '0']), ConfigError);
    const parsed = parseConfig([...URL, '--auth-flow', 'browser', '--auth-port', '18080', '--read-only', '--discovery']);
    assert.equal(parsed.config.authFlow, 'browser');
    assert.equal(parsed.config.authPort, 18080);
    assert.equal(parsed.config.readOnly, true);
    assert.equal(parsed.config.discovery, true);
  });

  it('answers help and version without a Redmine URL', () => {
    const help = parseConfig(['--help']);
    assert.equal(help.command.kind, 'help');
    const version = parseConfig(['--version']);
    assert.equal(version.command.kind, 'version');
  });

  it('resolves the API key flag over env and reports its source', () => {
    const previous = process.env['REDMINE_MCP_API_KEY'];
    try {
      delete process.env['REDMINE_MCP_API_KEY'];
      const unset = parseConfig([...URL]);
      assert.equal(unset.config.apiKey, '');
      assert.equal(unset.apiKeySource.origin, 'unset');

      process.env['REDMINE_MCP_API_KEY'] = 'env-key';
      const fromEnv = parseConfig([...URL]);
      assert.equal(fromEnv.config.apiKey, 'env-key');
      assert.equal(fromEnv.apiKeySource.origin, 'env');

      const fromFlag = parseConfig([...URL, '--api-key', 'flag-key']);
      assert.equal(fromFlag.config.apiKey, 'flag-key');
      assert.equal(fromFlag.apiKeySource.origin, 'flag');
    } finally {
      if (previous === undefined) delete process.env['REDMINE_MCP_API_KEY'];
      else process.env['REDMINE_MCP_API_KEY'] = previous;
    }
  });

  it('stores on login only an explicitly passed key, never the env key', () => {
    const previous = process.env['REDMINE_MCP_API_KEY'];
    try {
      process.env['REDMINE_MCP_API_KEY'] = 'env-key';
      // Env key configures the credential but must not be written to disk by login.
      const login = parseConfig([...URL, 'login']);
      assert.equal((login.command as { kind: string; apiKey?: string }).apiKey, undefined);
      assert.equal(login.config.apiKey, 'env-key');
      const explicit = parseConfig([...URL, 'login', '--api-key', 'flag-key']);
      assert.equal((explicit.command as { kind: string; apiKey?: string }).apiKey, 'flag-key');
    } finally {
      if (previous === undefined) delete process.env['REDMINE_MCP_API_KEY'];
      else process.env['REDMINE_MCP_API_KEY'] = previous;
    }
  });
});
