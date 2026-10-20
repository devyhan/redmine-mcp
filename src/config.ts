/**
 * Command-line and environment parsing for the Redmine MCP server.
 *
 * Every option has a long flag and a `REDMINE_MCP_*` environment fallback;
 * flags win. Anything unrecognised is a hard error, so a typo can never
 * silently downgrade the server's capabilities.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AuthFlow, OutputFormat, ServerConfig } from './contracts.js';
import { GROUP_NAMES, PRESET_NAMES, resolveGroupsDetailed } from './tools/groups.js';
import { defaultCacheDir } from './util/paths.js';

/** What the process should do once configuration is resolved. */
export type Command =
  | { kind: 'serve' }
  | { kind: 'login'; scopes?: string[]; full?: boolean; apiKey?: string }
  | { kind: 'logout' }
  | { kind: 'status' }
  | { kind: 'permissions' }
  | { kind: 'help'; text: string }
  | { kind: 'version' };

/** Cap on serialised tool output when `--max-output-chars` is not given. */
export const DEFAULT_MAX_OUTPUT_CHARS = 60_000;

/** Every accepted `--auth-flow` value, in help-text order. */
export const AUTH_FLOWS: AuthFlow[] = ['auto', 'browser', 'apikey'];

/** Sign-in flow used when `--auth-flow` is not given. */
export const DEFAULT_AUTH_FLOW: AuthFlow = 'auto';

/** Loopback port for the browser redirect when `--auth-port` is not given. */
export const DEFAULT_AUTH_PORT = 0;

/** Every accepted `--output` value, in help-text order. */
export const OUTPUT_FORMATS: OutputFormat[] = ['json', 'toon'];

/** Tool result format used when `--output` is not given. */
export const DEFAULT_OUTPUT: OutputFormat = 'json';

const AUTH_FLOW_HELP: Record<AuthFlow, string> = {
  auto: 'Try browser, fall back to API-key guidance when impossible.',
  browser: 'OAuth2 authorization code + PKCE (RFC 7636) on a loopback redirect; opens a browser.',
  apikey: 'Verify and store a Redmine API key; works on every Redmine with REST enabled.',
};

const LOWEST_UNPRIVILEGED_PORT = 1024;
const HIGHEST_PORT = 65_535;

/** Raised for any bad flag, value, group, or preset. Callers print and exit. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Where the client ID came from, so sign-in can name the application. */
export type ClientIdSource = { value: string; origin: 'flag' | 'env' | 'unset' };

export interface ParsedConfig {
  command: Command;
  config: ServerConfig;
  clientIdSource: ClientIdSource;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** `REDMINE_MCP_URL` is the one value with no default: the server to talk to. */
function resolveRedmineUrl(flag: string | undefined): string {
  const raw = flag ?? env('REDMINE_MCP_URL');
  if (raw === undefined) {
    throw new ConfigError('Set the Redmine server with --redmine-url or REDMINE_MCP_URL.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`Not a URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`Redmine URL must be http(s): ${raw}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function resolveClientId(flag: string | undefined): ClientIdSource {
  if (flag !== undefined && flag.trim() !== '') return { value: flag.trim(), origin: 'flag' };
  const fromEnv = env('REDMINE_MCP_CLIENT_ID');
  if (fromEnv !== undefined) return { value: fromEnv.trim(), origin: 'env' };
  return { value: '', origin: 'unset' };
}

/** True while no OAuth application is configured, so browser sign-in cannot run. */
export function isClientIdUnset(clientId: string): boolean {
  return clientId.trim() === '';
}

export function clientIdGuidance(): string {
  return (
    'Register an OAuth2 application in Redmine (Administration → OAuth2 Applications) with ' +
    'redirect URI http://127.0.0.1:<port>/callback, then pass --client-id/--client-secret ' +
    '(or REDMINE_MCP_CLIENT_ID/REDMINE_MCP_CLIENT_SECRET). ' +
    'Pre-6.1 servers have no OAuth provider: use `login --api-key` instead.'
  );
}

/** Base URL for Redmine calls, derived from the resolved config. */
export function redmineBaseUrl(config: ServerConfig): string {
  return config.redmineUrl;
}

function packageJson(): { name: string; version: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.resolve(here, '..', 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === 'string' ? parsed.name : 'redmine-mcp',
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
  };
}

export function packageName(): string {
  return packageJson().name;
}

export function packageVersion(): string {
  return packageJson().version;
}

function helpText(): string {
  return [
    'redmine-mcp — Redmine over the Model Context Protocol',
    '',
    'Usage: redmine-mcp <command> [options]',
    '',
    'Commands:',
    '  serve                  Speak MCP over stdio (default when omitted)',
    '  login [--scopes a,b]   Sign in in the browser (or --api-key KEY)',
    '  login --full           Sign in asking for every scope this config may need',
    '  logout                 Clear the cached session',
    '  status                 Show session, reachability, and consent checklist',
    '  permissions            List tool groups and the scopes they need',
    '',
    'Options (flag wins over REDMINE_MCP_* env):',
    '  --redmine-url URL      Redmine base URL (required)',
    '  --client-id ID         OAuth2 application ID registered in Redmine',
    '  --client-secret S      OAuth2 application secret',
    '  --groups a,b           Tool groups (default: personal preset)',
    `                         Known: ${GROUP_NAMES.join(', ')}`,
    '  --preset NAME          Group preset (default: personal)',
    `                         Known: ${PRESET_NAMES.join(', ')}`,
    '  --read-only            Suppress every write tool',
    '  --discovery            Expose discover_tools/call_tool instead of every tool',
    '  --org-mode             Enable groups needing Redmine admin rights',
    `  --max-output-chars N   Output budget (default ${DEFAULT_MAX_OUTPUT_CHARS})`,
    `  --output FMT           Tool result format: ${OUTPUT_FORMATS.join(', ')} (default ${DEFAULT_OUTPUT})`,
    '  --verbose              Log Redmine requests to stderr',
    '  --cache-dir DIR        Token cache directory (default OS config dir)',
    `  --auth-flow FLOW       Sign-in flow: ${AUTH_FLOWS.join(', ')} (default ${DEFAULT_AUTH_FLOW})`,
    ...AUTH_FLOWS.map((flow) => `    ${flow.padEnd(8)} ${AUTH_FLOW_HELP[flow]}`),
    `  --auth-port PORT       Fixed loopback port, or 0 for OS-assigned (default ${DEFAULT_AUTH_PORT})`,
    '  --allow-generic-write  Expose the redmine_request write escape hatch',
    '  -h, --help             Show this text',
    '  -v, --version          Show the version',
  ].join('\n');
}

interface RawOptions {
  redmineUrl?: string;
  clientId?: string;
  clientSecret?: string;
  groups?: string[];
  preset?: string;
  readOnly: boolean;
  discovery: boolean;
  orgMode: boolean;
  maxOutputChars: number;
  output: OutputFormat;
  verbose: boolean;
  cacheDir: string;
  authFlow: AuthFlow;
  authPort: number;
  allowGenericWrite: boolean;
  loginScopes?: string[];
  loginFull: boolean;
  loginApiKey?: string;
}

function parsePort(raw: string, flag: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > HIGHEST_PORT) {
    throw new ConfigError(`${flag} must be a port 0..${HIGHEST_PORT}: ${raw}`);
  }
  if (port !== 0 && port < LOWEST_UNPRIVILEGED_PORT) {
    throw new ConfigError(`${flag} must be 0 or >= ${LOWEST_UNPRIVILEGED_PORT}: ${raw}`);
  }
  return port;
}

function parseAuthFlow(raw: string): AuthFlow {
  if (!(AUTH_FLOWS as string[]).includes(raw)) {
    throw new ConfigError(`--auth-flow must be ${AUTH_FLOWS.join(', ')}: ${raw}`);
  }
  return raw as AuthFlow;
}

function parseOutput(raw: string): OutputFormat {
  if (!(OUTPUT_FORMATS as string[]).includes(raw)) {
    throw new ConfigError(`--output must be ${OUTPUT_FORMATS.join(', ')}: ${raw}`);
  }
  return raw as OutputFormat;
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Parses argv (without node/script). Exported so tests can drive it. */
export function parseConfig(argv: string[]): ParsedConfig {
  const opts: RawOptions = {
    readOnly: false,
    discovery: false,
    orgMode: false,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    output: DEFAULT_OUTPUT,
    verbose: false,
    cacheDir: defaultCacheDir(),
    authFlow: DEFAULT_AUTH_FLOW,
    authPort: DEFAULT_AUTH_PORT,
    allowGenericWrite: false,
    loginFull: false,
  };
  let command: string | undefined;

  const takeValue = (args: string[], i: number, flag: string): string => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new ConfigError(`${flag} needs a value.`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') return finishHelp(opts);
    if (arg === '-v' || arg === '--version') {
      return { command: { kind: 'version' }, config: buildConfig(opts, true), clientIdSource: clientIdOf(opts) };
    }
    if (!arg.startsWith('-') && command === undefined) {
      command = arg;
      continue;
    }
    switch (arg) {
      case '--redmine-url':
        opts.redmineUrl = takeValue(argv, i++, arg);
        break;
      case '--client-id':
        opts.clientId = takeValue(argv, i++, arg);
        break;
      case '--client-secret':
        opts.clientSecret = takeValue(argv, i++, arg);
        break;
      case '--groups':
        opts.groups = splitList(takeValue(argv, i++, arg));
        break;
      case '--preset':
        opts.preset = takeValue(argv, i++, arg);
        break;
      case '--read-only':
        opts.readOnly = true;
        break;
      case '--discovery':
        opts.discovery = true;
        break;
      case '--org-mode':
        opts.orgMode = true;
        break;
      case '--max-output-chars': {
        const raw = takeValue(argv, i++, arg);
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`--max-output-chars must be a positive integer: ${raw}`);
        opts.maxOutputChars = n;
        break;
      }
      case '--output':
        opts.output = parseOutput(takeValue(argv, i++, arg));
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--cache-dir':
        opts.cacheDir = takeValue(argv, i++, arg);
        break;
      case '--auth-flow':
        opts.authFlow = parseAuthFlow(takeValue(argv, i++, arg));
        break;
      case '--auth-port':
        opts.authPort = parsePort(takeValue(argv, i++, arg), arg);
        break;
      case '--allow-generic-write':
        opts.allowGenericWrite = true;
        break;
      case '--scopes':
        opts.loginScopes = splitList(takeValue(argv, i++, arg));
        break;
      case '--full':
        opts.loginFull = true;
        break;
      case '--api-key':
        opts.loginApiKey = takeValue(argv, i++, arg);
        break;
      default:
        throw new ConfigError(`Unknown option: ${arg}`);
    }
  }

  // Env fallbacks for the plain-value options flags did not set.
  const envOr = (flag: string | undefined, name: string): string | undefined => flag ?? env(name);
  opts.redmineUrl = envOr(opts.redmineUrl, 'REDMINE_MCP_URL');
  opts.clientSecret = envOr(opts.clientSecret, 'REDMINE_MCP_CLIENT_SECRET');
  opts.cacheDir = env('REDMINE_MCP_CACHE_DIR') !== undefined && opts.cacheDir === defaultCacheDir()
    ? env('REDMINE_MCP_CACHE_DIR')!
    : opts.cacheDir;
  if (env('REDMINE_MCP_VERBOSE') === '1') opts.verbose = true;
  if (env('REDMINE_MCP_READ_ONLY') === '1') opts.readOnly = true;

  const kind = command ?? 'serve';
  if (!['serve', 'login', 'logout', 'status', 'permissions'].includes(kind)) {
    throw new ConfigError(`Unknown command: ${kind}`);
  }

  const config = buildConfig(opts);
  const clientIdSource = clientIdOf(opts);
  if (kind === 'login') {
    return {
      command: { kind, scopes: opts.loginScopes, full: opts.loginFull || undefined, apiKey: opts.loginApiKey },
      config,
      clientIdSource,
    };
  }
  return { command: { kind } as Command, config, clientIdSource };
}

function finishHelp(opts: RawOptions): ParsedConfig {
  return { command: { kind: 'help', text: helpText() }, config: buildConfig(opts, true), clientIdSource: clientIdOf(opts) };
}

function clientIdOf(opts: RawOptions): ClientIdSource {
  return resolveClientId(opts.clientId);
}

function buildConfig(opts: RawOptions, lenient = false): ServerConfig {
  let groups: string[];
  let droppedGroups: string[] | undefined;
  try {
    const resolved = resolveGroupsDetailed(opts.groups, opts.preset, opts.orgMode);
    groups = resolved.groups;
    droppedGroups = resolved.droppedGroups.length > 0 ? resolved.droppedGroups : undefined;
  } catch (error) {
    if (!lenient) throw error instanceof Error ? new ConfigError(error.message) : error;
    groups = [];
  }
  let redmineUrl = '';
  if (!lenient) {
    redmineUrl = resolveRedmineUrl(opts.redmineUrl);
  } else if (opts.redmineUrl !== undefined) {
    try {
      redmineUrl = resolveRedmineUrl(opts.redmineUrl);
    } catch {
      redmineUrl = '';
    }
  }
  return {
    redmineUrl,
    clientId: resolveClientId(opts.clientId).value,
    clientSecret: opts.clientSecret ?? '',
    groups,
    ...(droppedGroups === undefined ? {} : { droppedGroups }),
    readOnly: opts.readOnly,
    discovery: opts.discovery,
    orgMode: opts.orgMode,
    maxOutputChars: opts.maxOutputChars,
    output: opts.output,
    verbose: opts.verbose,
    cacheDir: opts.cacheDir,
    authFlow: opts.authFlow,
    authPort: opts.authPort,
    allowGenericWrite: opts.allowGenericWrite,
  };
}
