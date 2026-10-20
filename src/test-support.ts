/**
 * Shared test doubles. Imported only from `*.test.ts` files.
 */

import type {
  AuthProvider,
  RedmineClient,
  RedmineRequestOptions,
  RedmineResponse,
  ServerConfig,
} from './contracts.js';

/** Minimal valid config; tests override what they need. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    redmineUrl: 'https://redmine.example.com',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    groups: ['issues', 'projects', 'users', 'time', 'wiki', 'files', 'search', 'queries'],
    readOnly: false,
    discovery: false,
    orgMode: false,
    maxOutputChars: 60_000,
    output: 'json',
    verbose: false,
    apiKey: '',
    cacheDir: '/tmp/redmine-mcp-test-cache',
    authFlow: 'auto',
    authPort: 0,
    allowGenericWrite: false,
    ...overrides,
  };
}

/** Auth double with a scripted credential. */
export function stubAuth(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    getCredential: async () => ({ scheme: 'bearer' as const, value: 'test-token' }),
    getAccount: async () => null,
    login: async () => {
      throw new Error('unexpected login');
    },
    logout: async () => undefined,
    loginWithApiKey: async () => {
      throw new Error('unexpected loginWithApiKey');
    },
    ...overrides,
  };
}

/** Records requests and answers from a script. */
export interface ScriptedResponse {
  status?: number;
  data?: unknown;
  totalCount?: number;
}

export function stubRedmine(script: Record<string, ScriptedResponse | ((opts: RedmineRequestOptions) => ScriptedResponse)>): {
  client: RedmineClient;
  seen: RedmineRequestOptions[];
} {
  const seen: RedmineRequestOptions[] = [];
  const request = async <T>(opts: RedmineRequestOptions): Promise<RedmineResponse<T>> => {
    seen.push(opts);
    const entry = script[opts.path];
    if (entry === undefined) throw new Error(`unstubbed Redmine path: ${opts.method ?? 'GET'} ${opts.path}`);
    const resolved = typeof entry === 'function' ? entry(opts) : entry;
    return {
      status: resolved.status ?? 200,
      data: (resolved.data ?? {}) as T,
      ...(resolved.totalCount !== undefined ? { totalCount: resolved.totalCount } : {}),
    };
  };
  return {
    client: {
      request,
      requestRaw: async () => {
        throw new Error('unstubbed requestRaw');
      },
    },
    seen,
  };
}
