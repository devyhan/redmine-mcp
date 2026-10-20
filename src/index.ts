#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * Two very different jobs live here. `serve` speaks MCP over stdio, where
 * stdout carries JSON-RPC framing and a stray `console.log` corrupts the
 * session. Every other subcommand is an ordinary CLI run by a human, where
 * stdout is the answer. `out()` is only ever called on the CLI paths.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import type { AuthProvider, RedmineClient, ServerConfig, ToolDefinition } from './contracts.js';
import {
  cachePaths,
  clearCache,
  createAuthProviderFromConfig,
  describeAccount,
  scopeReadingOnlyAuth,
} from './auth/index.js';
import type { ClientIdSource, ParsedConfig } from './config.js';
import {
  ConfigError,
  clientIdGuidance,
  isClientIdUnset,
  packageName,
  packageVersion,
  parseConfig,
  redmineBaseUrl,
} from './config.js';
import { createRedmineClient } from './redmine/client.js';
import { collectTools, createServerFactory, exposedToolNames } from './server.js';
import { GROUPS, GROUP_NAMES, consentScopesFor, loginScopesFor, scopesForGroups } from './tools/groups.js';
import { createLogger, logger, setLogger } from './util/logger.js';

/** CLI-only. Never reachable from `serve`. */
function out(text: string): void {
  process.stdout.write(text);
}

function err(text: string): void {
  try {
    process.stderr.write(text);
  } catch {
    // A closed stderr must not turn a clean shutdown into a crash.
  }
}

/**
 * A client that refuses to talk.
 *
 * `collectTools` only closes over the client — no module calls it while
 * building definitions — so the commands that merely enumerate tools can skip
 * constructing auth entirely, and therefore work before sign-in.
 */
function inertRedmineClient(): RedmineClient {
  const refuse = (): never => {
    throw new Error('This command inspects configuration only and makes no Redmine calls.');
  };
  return { request: refuse, requestRaw: refuse };
}

interface Session {
  auth: AuthProvider;
  redmine: RedmineClient;
  tools: ToolDefinition[];
}

function buildSession(config: ServerConfig, clientIdSource: ClientIdSource): Session {
  const auth = createAuthProviderFromConfig({ config, clientIdSource });
  const redmine = createRedmineClient({ auth, config });

  // The consent set is computed FROM the catalogue, and the catalogue is what
  // these deps are being passed to build. The closure reads a list filled in on
  // the next line, so by the time any handler calls it the answer is complete.
  let tools: ToolDefinition[] = [];
  tools = collectTools({ redmine, config, auth, consentScopes: () => consentScopesFor(config, tools) });
  return { auth, redmine, tools };
}

/**
 * The full consent set a configuration may need.
 *
 * Under `--read-only` the write tools are suppressed, so their scopes are left
 * out rather than consented to for nothing. A bare sign-in asks for less than
 * this; this is what `login --full` asks for and what `status` reports.
 */
function fullConsentScopes(config: ServerConfig): string[] {
  const tools = collectTools({
    redmine: inertRedmineClient(),
    config,
    auth: scopeReadingOnlyAuth(),
    consentScopes: () => [],
  });
  return consentScopesFor(config, tools);
}

async function runServe(config: ServerConfig, clientIdSource: ClientIdSource): Promise<void> {
  setLogger(createLogger(config.verbose ? 'debug' : 'info'));
  const { auth, redmine, tools } = buildSession(config, clientIdSource);
  const factory = createServerFactory({ config, redmine, auth, tools });
  logger.info('Serving Redmine MCP over stdio.', {
    redmineUrl: redmineBaseUrl(config),
    tools: exposedToolNames(tools, config).length,
  });
  await serveStdio(factory);
}

async function runLogin(
  config: ServerConfig,
  clientIdSource: ClientIdSource,
  scopes: string[] | undefined,
  full: boolean | undefined,
  apiKey: string | undefined,
): Promise<void> {
  const { auth } = buildSession(config, clientIdSource);
  if (apiKey !== undefined) {
    const account = await auth.loginWithApiKey(apiKey);
    out(`Signed in as ${describeAccount(account)} (API key).\n`);
    return;
  }
  if (isClientIdUnset(config.clientId)) {
    err(`No OAuth application is configured. ${clientIdGuidance()}\n`);
    process.exitCode = 1;
    return;
  }
  const wanted = scopes ?? (full ? fullConsentScopes(config) : loginScopesFor(config));
  out(`Opening the browser to sign in to ${redmineBaseUrl(config)} …\n`);
  const account = await auth.login(wanted);
  out(`Signed in as ${describeAccount(account)}.\n`);
}

async function runLogout(config: ServerConfig, clientIdSource: ClientIdSource): Promise<void> {
  const { auth } = buildSession(config, clientIdSource);
  await auth.logout();
  await clearCache(config.cacheDir);
  out('Signed out. Cached session cleared.\n');
}

async function runStatus(config: ServerConfig, clientIdSource: ClientIdSource): Promise<void> {
  const { auth, redmine } = buildSession(config, clientIdSource);
  const lines: string[] = [`${packageName()} ${packageVersion()}`, `Redmine: ${redmineBaseUrl(config)}`];
  const account = await auth.getAccount().catch(() => null);
  lines.push(account ? `Account: ${describeAccount(account)}` : 'Account: not signed in');
  if (auth.sessionHealth) {
    const health = await auth.sessionHealth();
    lines.push(`Session: ${health.credentialUsable ? 'usable' : 'not usable'}${health.note ? ` (${health.note})` : ''}`);
  }
  try {
    const res = await redmine.request<{ user?: { login?: string } }>({ path: '/users/current.json', scopes: [] });
    lines.push(`Reachable: yes (HTTP ${res.status}, ${(res.data.user?.login ?? 'unknown')})`);
  } catch (error) {
    lines.push(`Reachable: no (${error instanceof Error ? error.message : String(error)})`);
  }
  lines.push(`Groups: ${config.groups.join(', ') || '(none)'}`);
  if (config.droppedGroups?.length) {
    lines.push(`Dropped (need --org-mode): ${config.droppedGroups.join(', ')}`);
  }
  lines.push(`Consent checklist: ${fullConsentScopes(config).join(' ') || '(none)'}`);
  lines.push(`Cache: ${cachePaths(config.cacheDir).join(', ')}`);
  out(`${lines.join('\n')}\n`);
}

function runPermissions(config: ServerConfig): void {
  const lines: string[] = [`Tool groups for ${redmineBaseUrl(config)}:`];
  for (const name of GROUP_NAMES) {
    const group = GROUPS[name]!;
    const enabled = config.groups.includes(name) ? 'enabled' : 'off';
    const needs = [
      ...group.readScopes.map((scope) => scope),
      ...(config.readOnly ? [] : group.writeScopes.map((scope) => `${scope} (write)`)),
    ].join(', ');
    lines.push(`  ${name} [${enabled}]${group.requiresAdmin ? ' (needs admin)' : ''}: ${needs || '(no scopes)'}`);
  }
  lines.push(`Group scopes in this config: ${scopesForGroups(config).join(' ') || '(none)'}`);
  out(`${lines.join('\n')}\n`);
}

async function main(argv: string[]): Promise<void> {
  let parsed: ParsedConfig;
  try {
    parsed = parseConfig(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const { command, config, clientIdSource } = parsed;
  try {
    switch (command.kind) {
      case 'serve':
        await runServe(config, clientIdSource);
        break;
      case 'login':
        await runLogin(config, clientIdSource, command.scopes, command.full, command.apiKey);
        break;
      case 'logout':
        await runLogout(config, clientIdSource);
        break;
      case 'status':
        await runStatus(config, clientIdSource);
        break;
      case 'permissions':
        runPermissions(config);
        break;
      case 'help':
        out(`${command.text}\n`);
        break;
      case 'version':
        out(`${packageVersion()}\n`);
        break;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      err(`${error.message}\n`);
    } else {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
