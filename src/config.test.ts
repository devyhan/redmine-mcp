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
});
