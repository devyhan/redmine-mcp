/**
 * Assembly: turns the tool modules into a registered MCP server.
 *
 * `serveStdio` calls the factory once per connection, so the factory
 * registers everything every time and closes over nothing mutable.
 */

import { McpServer } from '@modelcontextprotocol/server';

import type {
  AuthProvider,
  RedmineClient,
  ServerConfig,
  ToolDefinition,
  ToolDeps,
} from './contracts.js';
import { RedmineError, InteractionRequiredError } from './contracts.js';
import { isNetworkFailure, networkFailureMessage } from './auth/provider.js';
import { formatIdentityLine, readIdentity } from './auth/token-cache.js';
import { packageVersion } from './config.js';
import { TRIAGE_PROMPT, createTriagePromptArgs, triagePrompt } from './prompts.js';
import { GROUP_NAMES } from './tools/groups.js';
import { buildDiscoveryTools } from './tools/discovery.js';
import { genericModule } from './tools/generic.js';
import { DOMAIN_MODULES } from './tools/modules.js';
import { logger } from './util/logger.js';
import { resourceLinksFor, type ResourceLinkBlock } from './util/links.js';
import { serializeResult } from './util/truncate.js';

/** The server name reported in `initialize`. Clients key their config off it. */
export const SERVER_NAME = 'redmine-mcp';

/**
 * Tools always exposed in discovery mode alongside the discovery pair.
 *
 * `redmine_list_permissions` is here so a caller can see what is switched on when
 * something returns 403. The sign-in pair is here for a blunter reason: a user
 * with no session cannot use `call_tool` to reach a tool they cannot discover.
 * `session_status` is the first call an agent makes — cached account plus live
 * reachability in one probe, before any discovery lookup.
 */
const ALWAYS_EXPOSED = new Set([
  'redmine_list_permissions',
  'auth_begin_login',
  'auth_login_status',
  'session_status',
]);

/**
 * What `initialize` tells every client, before any tool runs.
 *
 * One paragraph, not a manual: the sign-in pair and `session_status` are always
 * exposed, so these lines can name them unconditionally. Kept as an export so a
 * test can pin the exact wording — this is the first thing a new agent reads.
 */
export const SERVER_INSTRUCTIONS =
  'Call session_status once first. Sign in via auth_begin_login and auth_login_status; ' +
  'never ask for credentials. Orient via discover_tools. On errors read Hint/Blocked-by ' +
  'lines; re-login adds only missing scopes.';

/** The one prompt this server offers: orients a new agent session. */
export const AGENT_START_PROMPT = {
  name: 'agent_start',
  title: 'Agent start',
  description:
    'Orients a new agent session: check session_status, sign in if needed via auth_begin_login ' +
    'plus auth_login_status, orient via discover_tools, and follow Hint and Blocked-by lines on errors.',
} as const;

/**
 * The `agent_start` prompt body: the instructions above, expanded into steps.
 *
 * A function of nothing, exported so a test can assert on the text. The
 * registerPrompt callback below returns it unchanged.
 */
export function agentStartPrompt(): {
  messages: [{ role: 'user'; content: { type: 'text'; text: string } }];
} {
  const text = [
    'You are starting a new session with the Redmine MCP server: issue tracking, projects, ' +
      'users, time tracking, wiki, files, search, and saved queries over the Redmine REST API.',
    '1. Call session_status once first. It reports the cached account plus whether Redmine ' +
      'is reachable with a live GET /users/current.json.',
    '2. If no session is signed in, call auth_begin_login — it opens the system browser ' +
      'and returns immediately — ask the user to finish there, then call auth_login_status ' +
      'to confirm. Never ask for credentials, an API key, or an authorization code in the conversation.',
    '3. Orient via discover_tools (under --discovery, invoke what it names through call_tool).',
    '4. On errors, read the Hint and Blocked-by lines: they name the fix. Re-running login ' +
      'with only the missing scopes prompts only for what was added.',
  ].join('\n');
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * Tools whose effect a user cannot undo from inside this server: a deleted
 * issue is gone. `destructiveHint` is what a client uses to decide whether to
 * ask before running one.
 */
const DESTRUCTIVE = /(?:^|_)(?:delete)(?:_|$)/;

/**
 * `redmine_request` carries no verb in its name, and with --allow-generic-write it
 * can issue DELETE against anything the credential reaches. `call_tool` carries no
 * verb either and dispatches to any tool in the catalogue, deleting issues and
 * time entries among them. Both are the most dangerous tools here, so they are
 * named rather than pattern-matched.
 */
const ALWAYS_DESTRUCTIVE = new Set(['redmine_request', 'call_tool']);

/** Writes that land on the same state however many times they run. */
const IDEMPOTENT_WRITE = /(?:^|_)(?:update|save|set|add_member)(?:_|$)/;

/**
 * Assembles the enabled modules' definitions in catalogue order.
 *
 * The generic module is appended unconditionally: it is not selectable with
 * `--groups`, and the escape hatch plus `redmine_list_permissions` are what a
 * caller needs when a domain group turns out to be switched off.
 */
export function collectTools(deps: ToolDeps): ToolDefinition[] {
  const enabled = new Set(deps.config.groups);
  const tools: ToolDefinition[] = [];

  for (const name of GROUP_NAMES) {
    if (!enabled.has(name)) continue;
    const module = DOMAIN_MODULES[name];
    if (module === undefined) {
      logger.warn('No tool module implements this group; skipping.', { group: name });
      continue;
    }
    tools.push(...module.build(deps));
  }

  tools.push(...genericModule.build(deps));
  return tools;
}

/**
 * What a client is actually offered, which is not the same as what the catalogue
 * holds. Extracted so a test can assert on it.
 */
export function exposedTools(
  tools: readonly ToolDefinition[],
  config: ServerConfig,
): ToolDefinition[] {
  const available = tools.filter(
    (tool) =>
      (config.readOnly ? tool.write !== true : true) && (config.orgMode ? true : tool.requiresAdmin !== true),
  );

  // Discovery gets the unfiltered catalogue on purpose: it applies --read-only
  // itself, and knowing a suppressed tool exists is how `call_tool` can explain
  // why it will not run rather than claiming the name is unknown.
  return config.discovery
    ? [
        ...buildDiscoveryTools([...tools], config),
        ...available.filter((tool) => ALWAYS_EXPOSED.has(tool.name)),
      ]
    : available;
}

/** The same, by name. */
export function exposedToolNames(
  tools: readonly ToolDefinition[],
  config: ServerConfig,
): string[] {
  return exposedTools(tools, config).map((tool) => tool.name);
}

/** Renders a Redmine failure as text the model can act on without a stack trace. */
function describeRedmineError(error: RedmineError): string {
  const lines = [`Redmine returned ${error.status} for ${error.path}.`, error.message];
  if (error.hint !== undefined) lines.push(`Hint: ${error.hint}`);
  return lines.join('\n');
}

/** Exported for the test suite; the tool wrapper below is the only other caller. */
export function signInMessage(error: InteractionRequiredError): string {
  // A server-side refusal is not a sign-in problem: signing in again fails
  // identically until the admin enables REST or the OAuth provider.
  if (error.serverRefused) {
    return [
      'Blocked by a server configuration problem — not by a missing sign-in.',
      'Redmine itself refused the OAuth flow. The usual causes: the server is older than 6.1 ' +
        '(no OAuth provider — set REDMINE_MCP_API_KEY or pass --api-key and retry immediately, ' +
        'no login step needed), REST API disabled (Administration → Settings → API), or the ' +
        'OAuth application registration is wrong. Tell the user to check those on the server, ' +
        'then retry the call before signing in again.',
      `Detail: ${error.message}`,
    ].join('\n');
  }

  // Missing scopes are not a missing sign-in either: the session is fine, the
  // application just was not granted what this call asked for.
  if (error.missingScopes.length > 0) {
    const list = error.missingScopes.join(', ');
    return [
      'Blocked by missing application scopes — not by a missing sign-in.',
      `This call needs ${list}, which the Redmine OAuth application was not granted. ` +
        'A Redmine admin widens the application scopes (Administration → OAuth2 Applications), ' +
        'then re-run login for just those scopes. Signing in again without that changes nothing.',
      `Detail: ${error.message}`,
    ].join('\n');
  }

  // The request never reached Redmine, so nothing about the session mattered.
  if (error.networkFailure) {
    return [
      'Blocked by a network failure — not by a missing sign-in.',
      'The request never reached Redmine (DNS, proxy, TLS, or offline), so nothing ' +
        'about the session mattered. Tell the user to check the connection and retry the call; ' +
        'signing in will not change the outcome while the route is down.',
      `Detail: ${error.message}`,
    ].join('\n');
  }

  // The browser flow's loopback redirect could not be served in time.
  if (error.loopbackTimeout) {
    return [
      'Blocked by a loopback redirect timeout — not by a missing sign-in.',
      'The browser flow could not serve its loopback redirect in time (a firewall, a VPN, or ' +
        'another process on the port). Retrying the same browser sign-in times out the same way: ' +
        'free the loopback port first, or from a terminal `redmine-mcp login --api-key` ' +
        'sidesteps the listener entirely.',
      `Detail: ${error.message}`,
    ].join('\n');
  }

  return [
    'Not signed in to Redmine, or the stored session can no longer be refreshed.',
    'Call `auth_begin_login` to sign the user in from here. It opens the system browser for an ' +
      'OAuth 2.0 authorization-code + PKCE sign-in and returns immediately; ask the user to ' +
      'finish in that browser, then call `auth_login_status`. Never ask for their credentials, ' +
      'API key, or an authorization code in the conversation.',
    'A terminal still works if they prefer it: `redmine-mcp login`.',
    `Detail: ${error.message}`,
  ].join('\n');
}

interface FactoryDeps {
  config: ServerConfig;
  redmine: RedmineClient;
  auth: AuthProvider;
  tools: ToolDefinition[];
}

/**
 * Builds the factory handed to `serveStdio`.
 *
 * `auth` is held rather than used: it is what makes the closure a complete
 * description of the session, and callers already have it to hand.
 */
export function createServerFactory(deps: FactoryDeps): () => McpServer {
  const { config, tools, redmine } = deps;

  const exposed = exposedTools(tools, config);

  return function factory(): McpServer {
    const server = new McpServer(
      { name: SERVER_NAME, version: packageVersion() },
      { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.registerPrompt(
      AGENT_START_PROMPT.name,
      { title: AGENT_START_PROMPT.title, description: AGENT_START_PROMPT.description },
      () => agentStartPrompt(),
    );

    // Built inside the factory, not beside it: the args schema carries a
    // completer set bound to this connection's client and cache.
    server.registerPrompt(
      TRIAGE_PROMPT.name,
      {
        title: TRIAGE_PROMPT.title,
        description: TRIAGE_PROMPT.description,
        argsSchema: createTriagePromptArgs(redmine),
      },
      (args) => triagePrompt(args),
    );

    for (const def of exposed) {
      const write = def.write === true;
      server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema: def.inputSchema,
          ...(def.outputSchema !== undefined ? { outputSchema: def.outputSchema } : {}),
          annotations: {
            readOnlyHint: !write,
            destructiveHint: write && (DESTRUCTIVE.test(def.name) || ALWAYS_DESTRUCTIVE.has(def.name)),
            idempotentHint: !write || IDEMPOTENT_WRITE.test(def.name),
          },
        },
        async (args: unknown) => {
          try {
            const value = await def.handler((args ?? {}) as Record<string, unknown>);
            // Fresh literal: the SDK callback type carries an index signature
            // a named interface cannot satisfy.
            const formatted = await formatToolResult(def, value, config);
            return {
              content: formatted.content,
              ...(formatted.structuredContent !== undefined
                ? { structuredContent: formatted.structuredContent }
                : {}),
            };
          } catch (error) {
            return {
              content: [{ type: 'text' as const, text: toolErrorText(def.name, error) }],
              isError: true,
            };
          }
        },
      );
    }

    logger.debug('Registered tools for a new connection.', {
      count: exposed.length,
      discovery: config.discovery,
      readOnly: config.readOnly,
    });

    return server;
  };
}

/** One text block plus zero or more `resource_link` blocks. */
export interface FormattedToolResult {
  content: [{ type: 'text'; text: string }, ...ResourceLinkBlock[]];
  structuredContent?: unknown;
}

/**
 * Formats a handler return value for the wire: serialized (and possibly
 * identity-attributed) text first, `resource_link` blocks appended, and the
 * raw value as `structuredContent` when the tool declares an `outputSchema`
 * (the SDK validates it and advertises the schema on `tools/list`).
 * Extracted so tests can assert the shape without MCP plumbing.
 */
export async function formatToolResult(
  def: ToolDefinition,
  value: unknown,
  config: ServerConfig,
): Promise<FormattedToolResult> {
  const { text } = serializeResult(value, config.maxOutputChars, config.output);
  const attributed = await maybePrependIdentity(def, config.cacheDir, text);
  const content: FormattedToolResult['content'] = [
    { type: 'text', text: attributed },
    ...resourceLinksFor(def.name, value, config),
  ];
  return def.outputSchema === undefined ? { content } : { content, structuredContent: value };
}

/**
 * The identity attribution hook: tools that opt in via `includeIdentity` get
 * the login-time snapshot rendered as one line above their serialized output.
 * Opt-in only, offline (a disk read, never a Redmine call), and silent when
 * no snapshot exists. Runs after serialization so the output budget still
 * applies to the payload itself.
 */
async function maybePrependIdentity(
  def: ToolDefinition,
  cacheDir: string,
  text: string,
): Promise<string> {
  if (def.includeIdentity !== true) return text;
  let snapshot: Awaited<ReturnType<typeof readIdentity>>;
  try {
    snapshot = await readIdentity(cacheDir);
  } catch {
    return text;
  }
  if (snapshot === null) return text;
  return `${formatIdentityLine(snapshot)}\n${text}`;
}

/**
 * A stack trace tells the model nothing it can use and can carry a path or a
 * token fragment, so it goes to stderr and only the message goes on the wire.
 */
function toolErrorText(name: string, error: unknown): string {
  if (error instanceof RedmineError) return describeRedmineError(error);
  if (error instanceof InteractionRequiredError) return signInMessage(error);

  if (error instanceof Error && isNetworkFailure(error)) {
    logger.error('Tool failed.', { tool: name, stack: error.stack ?? error.message });
    return signInMessage(
      new InteractionRequiredError(networkFailureMessage([], error.message), [], false, true),
    );
  }

  if (error instanceof Error) {
    logger.error('Tool failed.', { tool: name, stack: error.stack ?? error.message });
    return `${name} failed: ${error.message}`;
  }

  logger.error('Tool failed with a non-Error value.', { tool: name, value: String(error) });
  return `${name} failed: ${String(error)}`;
}
