/**
 * The generic group: sign-in from inside a conversation, session status, the
 * permission catalogue, and the `redmine_request` escape hatch.
 *
 * This module is appended unconditionally: it is not selectable with
 * `--groups`, and the escape hatch plus `redmine_list_permissions` are what a
 * caller needs when a domain group turns out to be switched off.
 */

import { z } from 'zod';

import type { AuthProvider, ToolDefinition, ToolDeps, ToolModule, ToolGroupMeta } from '../contracts.js';
import { InteractionRequiredError } from '../contracts.js';
import { credentialSource } from '../auth/index.js';
import type { CredentialSource } from '../auth/index.js';
import { GROUPS, GROUP_NAMES } from './groups.js';

export const GENERIC_GROUP: ToolGroupMeta = {
  name: 'generic',
  title: 'Session and generic access',
  description: 'Sign-in, session status, permissions, and raw Redmine requests.',
  readScopes: [],
  writeScopes: [],
  requiresAdmin: false,
};

/** In-flight background sign-ins, one per provider. Tokens never leave here. */
interface BackgroundLogin {
  scopes: string[];
  startedAt: string;
  promise: Promise<string>;
  settled: { state: 'signedIn' | 'failed'; detail: string } | null;
}

const backgroundLogins = new WeakMap<AuthProvider, BackgroundLogin>();

function startBackgroundLogin(auth: AuthProvider, scopes: string[]): BackgroundLogin {
  const existing = backgroundLogins.get(auth);
  if (existing && !existing.settled) return existing;
  const entry: BackgroundLogin = {
    scopes: [...scopes],
    startedAt: new Date().toISOString(),
    promise: Promise.resolve(''),
    settled: null,
  };
  entry.promise = auth
    .login(scopes, 'browser')
    .then((account) => {
      entry.settled = { state: 'signedIn', detail: `Signed in as ${account.login}.` };
      return entry.settled.detail;
    })
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      entry.settled = { state: 'failed', detail };
      return detail;
    });
  // The status tool observes the outcome; an unhandled rejection here would
  // crash the server while the user is still in the browser.
  entry.promise.catch(() => undefined);
  backgroundLogins.set(auth, entry);
  return entry;
}

const beginLoginInput = z.object({
  scopes: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Extra Redmine permission scopes to consent to, e.g. ["admin"]. Omit to sign in ' +
        'with the scopes this configuration needs. Re-running with only missing scopes ' +
        'prompts only for what was added.',
    ),
});

const redmineRequestInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Redmine-relative path starting with /, e.g. "/issues.json". Absolute URLs are refused.'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET').describe('HTTP method. Writes need --allow-generic-write.'),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters.'),
  body: z.unknown().optional().describe('JSON body for write methods.'),
});

export const genericModule: ToolModule = {
  group: GENERIC_GROUP,
  build({ redmine, config, auth, consentScopes }: ToolDeps): ToolDefinition[] {
    const tools: ToolDefinition[] = [
      {
        name: 'auth_begin_login',
        title: 'Begin browser sign-in',
        description:
          'Starts a Redmine OAuth2 sign-in in the system browser and returns immediately. ' +
          'Ask the user to finish there, then call auth_login_status. Never ask for ' +
          'credentials, an API key, or an authorization code in the conversation.',
        inputSchema: beginLoginInput,
        scopes: [],
        group: GENERIC_GROUP.name,
        handler: async (args) => {
          const { scopes } = beginLoginInput.parse(args);
          const account = await auth.getAccount().catch(() => null);
          if (account) {
            return {
              state: 'already_signed_in',
              account: account.login,
              hint: 'A session already exists. Pass scopes to consent to more, or logout first to switch users.',
            };
          }
          const wanted = scopes ?? consentScopes();
          const entry = startBackgroundLogin(auth, wanted);
          return {
            state: 'pending',
            startedAt: entry.startedAt,
            scopes: entry.scopes,
            hint: 'The browser holds the sign-in. Ask the user to finish there, then call auth_login_status.',
          };
        },
      },
      {
        name: 'auth_login_status',
        title: 'Check sign-in status',
        description:
          'Reports where the background browser sign-in has got to: pending, signed in, ' +
          'or failed with the fix. Never returns a token.',
        inputSchema: z.object({}),
        scopes: [],
        group: GENERIC_GROUP.name,
        handler: async () => {
          const account = await auth.getAccount().catch(() => null);
          if (account) return { state: 'signedIn', account: account.login };
          const entry = backgroundLogins.get(auth);
          if (!entry) return { state: 'none', hint: 'No sign-in is running. Call auth_begin_login first.' };
          if (!entry.settled) {
            return { state: 'pending', startedAt: entry.startedAt, hint: 'Still waiting on the browser. Ask the user to finish there.' };
          }
          return { state: entry.settled.state, detail: entry.settled.detail };
        },
      },
      {
        name: 'session_status',
        title: 'Session status',
        description:
          'Call once first. Reports the cached account, whether Redmine is reachable ' +
          'with a live GET /users/current.json, and the consent checklist for this configuration.',
        inputSchema: z.object({}),
        scopes: [],
        group: GENERIC_GROUP.name,
        handler: async () => {
          const account = await auth.getAccount().catch(() => null);
          const health = auth.sessionHealth
            ? await auth.sessionHealth().catch((error: unknown) => ({
                credentialUsable: false,
                note: error instanceof Error ? error.message : String(error),
              }))
            : { credentialUsable: false, note: 'not probed' };
          let reachable: { ok: boolean; detail: string };
          try {
            const res = await redmine.request({ path: '/users/current.json', scopes: [] });
            const user = (res.data as { user?: { login?: string } })?.user;
            reachable = { ok: true, detail: `GET /users/current.json answered HTTP ${res.status} (${user?.login ?? 'unknown'}).` };
          } catch (error) {
            reachable = {
              ok: false,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
          const source = await credentialSource(config).catch((): CredentialSource => 'none');
          return {
            redmineUrl: config.redmineUrl,
            account: account ? { login: account.login, id: account.id, admin: account.admin ?? false } : null,
            credential: source,
            session: health,
            reachable,
            groups: config.groups,
            consentChecklist: consentScopes(),
          };
        },
      },
      {
        name: 'redmine_list_permissions',
        title: 'List permissions',
        description:
          'Lists the tool groups, the Redmine permission scopes each needs, and which ' +
          'groups are enabled. The first call when something returns 403.',
        inputSchema: z.object({}),
        scopes: [],
        group: GENERIC_GROUP.name,
        handler: async () => ({
          redmineUrl: config.redmineUrl,
          enabledGroups: config.groups,
          droppedGroups: config.droppedGroups ?? [],
          groups: GROUP_NAMES.map((name) => {
            const group = GROUPS[name]!;
            return {
              name: group.name,
              title: group.title,
              description: group.description,
              readScopes: group.readScopes,
              writeScopes: group.writeScopes,
              requiresAdmin: group.requiresAdmin,
              enabled: config.groups.includes(name),
            };
          }),
        }),
      },
      {
        name: 'redmine_request',
        title: 'Raw Redmine request',
        description:
          'Escape hatch: any Redmine REST path with the signed-in credential. GET by ' +
          'default; write methods need --allow-generic-write. Prefer the typed tools: ' +
          'they page, project, and explain errors.',
        inputSchema: redmineRequestInput,
        write: true,
        scopes: [],
        group: GENERIC_GROUP.name,
        handler: async (args) => {
          const parsed = redmineRequestInput.parse(args);
          if (parsed.path.startsWith('http://') || parsed.path.startsWith('https://') || !parsed.path.startsWith('/')) {
            throw new InteractionRequiredError(
              `Refusing a non-relative Redmine path: ${parsed.path}. Pass a path starting with /.`,
            );
          }
          if (parsed.method !== 'GET' && !config.allowGenericWrite) {
            throw new InteractionRequiredError(
              'Generic writes are disabled. Restart with --allow-generic-write, or use the typed write tools.',
            );
          }
          // Token endpoints are never callable through the escape hatch: the
          // response would put secrets in the conversation.
          if (parsed.path.startsWith('/oauth/')) {
            throw new InteractionRequiredError('Refusing an OAuth endpoint through the escape hatch.');
          }
          const res = await redmine.request({
            path: parsed.path,
            method: parsed.method,
            query: parsed.query,
            body: parsed.body,
            scopes: [],
          });
          return { status: res.status, totalCount: res.totalCount, data: res.data };
        },
      },
    ];
    return tools;
  },
};
