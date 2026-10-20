#!/usr/bin/env node
/**
 * Offline stdio smoke: initialize → tools/list → session_status against a
 * stub URL. Asserts the handshake, the tool count, and stdout purity
 * (every stdout line must be JSON-RPC; logs go to stderr).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'dist', 'index.js');

const MESSAGES = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_status', arguments: {} } },
];

const child = spawn(process.execPath, [ENTRY, '--redmine-url', 'https://redmine.example.com', '--cache-dir', `${HERE}/../.smoke-cache`], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const fail = (message) => {
  console.error(`smoke failed: ${message}\nstderr:\n${stderr}`);
  child.kill();
  process.exit(1);
};

child.on('error', (error) => fail(`spawn: ${error.message}`));
setTimeout(() => fail('timed out waiting for responses'), 20000).unref?.();

for (const message of MESSAGES) child.stdin.write(`${JSON.stringify(message)}\n`);

// Hold stdin open so async handlers finish, then close and await exit.
setTimeout(() => child.stdin.end(), 3000);

child.on('close', (code) => {
  if (code !== 0) fail(`exit code ${code}`);
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 3) fail(`expected >=3 stdout lines, got ${lines.length}`);
  let init;
  let list;
  let status;
  try {
    init = JSON.parse(lines[0]);
    list = JSON.parse(lines[1]);
    status = JSON.parse(lines[2]);
  } catch {
    fail('a stdout line is not JSON (stdout purity violated)');
  }
  if (init.result?.serverInfo?.name !== 'redmine-mcp') fail('bad serverInfo');
  const tools = list.result?.tools ?? [];
  if (tools.length < 30) fail(`expected >=30 tools, got ${tools.length}`);
  for (const name of ['session_status', 'auth_begin_login', 'auth_login_status', 'issues_list']) {
    if (!tools.some((tool) => tool.name === name)) fail(`missing tool ${name}`);
  }
  const text = status.result?.content?.[0]?.text ?? '';
  if (!text.includes('redmine.example.com') || !text.includes('consentChecklist')) fail('bad session_status payload');
  console.log(`smoke ok: ${tools.length} tools, stdout pure (${lines.length} lines), session_status rendered`);
});
