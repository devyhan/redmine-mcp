import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { testConfig } from '../test-support.js';
import { MAX_RESOURCE_LINKS, resourceLinksFor } from './links.js';

const config = testConfig({ redmineUrl: 'https://redmine.example.com' });

describe('resource links', () => {
  it('links every issue in an issues_list page', () => {
    const links = resourceLinksFor(
      'issues_list',
      { total_count: 2, issues: [{ id: 1, subject: 'First' }, { id: 2, subject: 'Second' }] },
      config,
    );
    assert.deepEqual(links, [
      { type: 'resource_link', uri: 'https://redmine.example.com/issues/1', name: '#1 First', mimeType: 'text/html' },
      { type: 'resource_link', uri: 'https://redmine.example.com/issues/2', name: '#2 Second', mimeType: 'text/html' },
    ]);
  });

  it('links a single issue result and falls back without a subject', () => {
    const get = resourceLinksFor('issues_get', { id: 7, subject: 'Bug' }, config);
    assert.equal(get.length, 1);
    assert.equal(get[0]!.uri, 'https://redmine.example.com/issues/7');
    assert.equal(get[0]!.name, '#7 Bug');
    const bare = resourceLinksFor('issues_create', { id: 9 }, config);
    assert.equal(bare[0]!.name, '#9');
  });

  it('links issue acks by their updated/deleted id', () => {
    assert.deepEqual(resourceLinksFor('issues_update', { updated: 3 }, config), [
      { type: 'resource_link', uri: 'https://redmine.example.com/issues/3', name: '#3', mimeType: 'text/html' },
    ]);
    assert.equal(resourceLinksFor('issues_delete', { deleted: 4 }, config)[0]!.uri, 'https://redmine.example.com/issues/4');
  });

  it('prefers the project identifier in project links', () => {
    const links = resourceLinksFor(
      'projects_list',
      { total_count: 2, projects: [{ id: 10, identifier: 'demo', name: 'Demo' }, { id: 11, name: 'No slug' }] },
      config,
    );
    assert.equal(links[0]!.uri, 'https://redmine.example.com/projects/demo');
    assert.equal(links[0]!.name, 'Demo');
    assert.equal(links[1]!.uri, 'https://redmine.example.com/projects/11');
    const single = resourceLinksFor('projects_get', { id: 10, identifier: 'demo', name: 'Demo' }, config);
    assert.equal(single.length, 1);
    const ack = resourceLinksFor('projects_update', { updated: 'demo' }, config);
    assert.equal(ack[0]!.uri, 'https://redmine.example.com/projects/demo');
  });

  it('links users and the projects in users_my_access', () => {
    const one = resourceLinksFor('users_get', { id: 5, login: 'jdoe' }, config);
    assert.deepEqual(one, [
      { type: 'resource_link', uri: 'https://redmine.example.com/users/5', name: 'jdoe', mimeType: 'text/html' },
    ]);
    const list = resourceLinksFor('users_list', { users: [{ id: 5, login: 'jdoe' }] }, config);
    assert.equal(list.length, 1);
    const access = resourceLinksFor(
      'users_my_access',
      { login: 'jdoe', admin: false, groups: [], projects: [{ id: 10, name: 'Demo', roles: ['Developer'] }] },
      config,
    );
    assert.equal(access[0]!.uri, 'https://redmine.example.com/projects/10');
  });

  it('returns nothing for unrelated tools and unshaped values', () => {
    assert.deepEqual(resourceLinksFor('time_list_entries', { total_count: 0 }, config), []);
    assert.deepEqual(resourceLinksFor('issues_list', { total_count: 0 }, config), []);
    assert.deepEqual(resourceLinksFor('issues_get', null, config), []);
    assert.deepEqual(resourceLinksFor('issues_list', { issues: [{ subject: 'no id' }, null] }, config), []);
  });

  it('caps links on large pages', () => {
    const issues = Array.from({ length: MAX_RESOURCE_LINKS + 10 }, (_, i) => ({ id: i + 1, subject: `s${i}` }));
    assert.equal(resourceLinksFor('issues_list', { issues }, config).length, MAX_RESOURCE_LINKS);
  });

  it('tolerates a trailing slash on the base URL', () => {
    const slashed = testConfig({ redmineUrl: 'https://redmine.example.com/' });
    const [link] = resourceLinksFor('issues_get', { id: 1 }, slashed);
    assert.equal(link!.uri, 'https://redmine.example.com/issues/1');
  });
});
