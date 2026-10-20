#!/usr/bin/env node
/**
 * Live contract probe: checks the Redmine this server is configured against
 * for the OAuth endpoints, scopes surface, and REST paths the tools depend
 * on. Read-only: the only writes are none.
 *
 * Needs REDMINE_MCP_URL plus REDMINE_MCP_API_KEY (or a cached OAuth session
 * via --cache-dir). Skips with exit 0 when no URL is configured so plain CI
 * stays offline.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'dist', 'index.js');

const base = process.env['REDMINE_MCP_URL'];
if (!base) {
  console.log('contract: REDMINE_MCP_URL unset, skipping live probe');
  process.exit(0);
}
const apiKey = process.env['REDMINE_MCP_API_KEY'] ?? '';

const headers = { Accept: 'application/json', ...(apiKey ? { 'X-Redmine-API-Key': apiKey } : {}) };
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`contract ok: ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`contract FAIL: ${name}: ${error.message}`);
  }
}

const get = async (urlPath) => {
  const res = await fetch(`${base}${urlPath}`, { headers });
  return res;
};

await check('OAuth authorize endpoint exists', async () => {
  const res = await get('/oauth/authorize?client_id=contract&redirect_uri=http://127.0.0.1:1/callback&response_type=code');
  // 302 to login, 400/401 for the bogus client, or 200: all prove the route.
  if (res.status === 404) throw new Error('route missing (pre-6.1 or provider disabled)');
});

await check('OAuth token endpoint exists', async () => {
  const res = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=authorization_code&code=x' });
  if (res.status === 404) throw new Error('route missing');
});

for (const urlPath of ['/users/current.json', '/issues.json?limit=1', '/projects.json?limit=1', '/time_entries.json?limit=1', '/queries.json?limit=1', '/search.json?q=contract&limit=1', '/trackers.json', '/issue_statuses.json', '/roles.json', '/groups.json', '/custom_fields.json', '/news.json?limit=1', '/enumerations/issue_priorities.json', '/enumerations/time_entry_activities.json']) {
  await check(`GET ${urlPath}`, async () => {
    const res = await get(urlPath);
    if (res.status === 404) throw new Error('route missing');
    if (res.status === 401 || res.status === 403) throw new Error(`refused (${res.status}); check key/scopes`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

await check('permission catalogue matches server groups', async () => {
  const out = spawnSync(process.execPath, [ENTRY, '--redmine-url', base, 'permissions'], { encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr.trim());
  for (const scope of ['view_issues', 'view_project', 'view_users', 'view_time_entries']) {
    if (!out.stdout.includes(scope)) throw new Error(`missing scope ${scope}`);
  }
});

if (failures.length > 0) {
  console.error(`contract: ${failures.length} failing probe(s)`);
  process.exit(1);
}
console.log('contract: all probes passed');
