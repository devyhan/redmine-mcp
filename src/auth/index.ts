/**
 * Auth assembly: the provider factory plus the small helpers the CLI and the
 * sign-in tools share.
 */

import type { AccountInfo, AuthProvider, ServerConfig } from '../contracts.js';
import { InteractionRequiredError } from '../contracts.js';
import type { ClientIdSource } from '../config.js';
import { createAuthProvider } from './provider.js';
import type { ProviderDeps } from './provider.js';
import { clearCache as clearCacheDir, readSession } from './token-cache.js';
import type { StoredSession } from './token-cache.js';

export interface AuthFactoryDeps {
  config: ServerConfig;
  clientIdSource: ClientIdSource;
  overrides?: Partial<Pick<ProviderDeps, 'preflight' | 'openBrowser' | 'fetchImpl' | 'loopback'>>;
}

export function createAuthProviderFromConfig(deps: AuthFactoryDeps): AuthProvider {
  return createAuthProvider({
    config: deps.config,
    clientIdSource: deps.clientIdSource,
    ...deps.overrides,
  });
}

/** Files the session may occupy. Exported so `status` can report them. */
export function cachePaths(cacheDir: string): string[] {
  return [`${cacheDir}/token-cache.enc`, `${cacheDir}/identity-cache.enc`, `${cacheDir}/cache.key`];
}

/** Removes every cached secret. */
export async function clearCache(cacheDir: string): Promise<void> {
  await clearCacheDir(cacheDir);
}

/** One line naming the signed-in account for `status` output. */
export function describeAccount(account: AccountInfo): string {
  const name = [account.firstname, account.lastname].filter(Boolean).join(' ');
  return name !== '' ? `${account.login} (${name})` : account.login;
}

/**
 * Which credential the server would use right now. Origin only, never secret
 * material: safe to print in `status` and `session_status`.
 *
 * - `env-key` — `--api-key` / `REDMINE_MCP_API_KEY`, used directly.
 * - `stored-key` — `login --api-key` binding in the cache.
 * - `oauth` — cached OAuth session.
 * - `none` — nothing configured and nothing stored.
 */
export type CredentialSource = 'env-key' | 'stored-key' | 'oauth' | 'none';

export async function credentialSource(config: ServerConfig): Promise<CredentialSource> {
  if (config.apiKey.trim() !== '') return 'env-key';
  let session: StoredSession | null;
  try {
    session = await readSession(config.cacheDir);
  } catch {
    return 'none';
  }
  if (session === null || session.redmineUrl !== config.redmineUrl) return 'none';
  return session.kind === 'apikey' ? 'stored-key' : 'oauth';
}

/**
 * A provider that only reads scopes: the CLI paths that build the catalogue
 * merely to enumerate its scopes pass this so forgetting the real provider
 * throws loudly instead of removing the sign-in tools silently.
 */
export function scopeReadingOnlyAuth(): AuthProvider {
  const refuse = (): never => {
    throw new InteractionRequiredError('This command inspects configuration only and never signs in.');
  };
  return {
    getCredential: async () => refuse(),
    getAccount: async () => null,
    login: async () => refuse(),
    logout: async () => undefined,
    loginWithApiKey: async () => refuse(),
  };
}
