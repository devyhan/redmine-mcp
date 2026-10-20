/**
 * OAuth2 + API-key authentication against Redmine.
 *
 * Redmine 6.1+ ships a Doorkeeper OAuth2 provider: authorization-code grants
 * only, refresh tokens on, scopes are Redmine permission names plus `admin`.
 * This provider signs in through it with PKCE (RFC 7636) on a loopback
 * redirect, sending the confidential client's secret alongside the PKCE
 * verifier so the exchange works whether or not the server enforces PKCE.
 *
 * Pre-6.1 servers (or any server whose admin never enabled the provider) use
 * the API-key binding instead: the key is verified once against
 * `GET /users/current.json` and stored encrypted like a token.
 *
 * The data path (`getCredential`) is silent/refresh-only and never opens a
 * browser; every failure that needs a person becomes an
 * `InteractionRequiredError` with the flag that names the fix.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';

import type {
  AccountInfo,
  AuthFlow,
  AuthProvider,
  IdentityRecord,
  ServerConfig,
  SessionHealth,
} from '../contracts.js';
import { InteractionRequiredError } from '../contracts.js';
import type { ClientIdSource } from '../config.js';
import { apiKeySetupGuidance, clientIdGuidance, isApiKeyUnset, isClientIdUnset } from '../config.js';
import { logger } from '../util/logger.js';
import type { PreflightChecks } from './preflight.js';
import { defaultPreflight } from './preflight.js';
import {
  accessTokenExpired,
  clearSession,
  readIdentity,
  readSession,
  writeIdentity,
  writeSession,
} from './token-cache.js';
import type { StoredSession } from './token-cache.js';

/** How long the loopback listener waits for the browser to come back. */
export const LOOPBACK_TIMEOUT_MS = 5 * 60_000;

const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Redmine MCP signed in</title>
<style>body{font-family:system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#1a1a1a}</style>
</head><body><h1>Signed in to Redmine</h1>
<p>You can close this tab and return to your assistant.</p></body></html>`;

const ERROR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Redmine MCP sign-in failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em;color:#1a1a1a}</style>
</head><body><h1>Sign-in failed</h1>
<p>The sign-in did not complete. Return to your assistant for what to do next.</p></body></html>`;

export interface ProviderDeps {
  config: ServerConfig;
  clientIdSource: ClientIdSource;
  preflight?: PreflightChecks;
  /** Injected so tests never spawn a real browser. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Injected so tests never bind a real port. */
  loopback?: (onCode: (params: URLSearchParams) => void) => Promise<{ redirectUri: string; wait: Promise<URLSearchParams> }>;
}

/** Opens the system browser detached, keeping MCP stdio clean. http(s) only. */
export async function openBrowser(url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** True for transport failures that never reached Redmine. */
export function isNetworkFailure(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code ?? '';
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    /fetch failed/i.test(error.message)
  );
}

export function networkFailureMessage(scopes: readonly string[], detail: string): string {
  void scopes;
  return `The request never reached Redmine (${detail}). Check the connection and retry the call; signing in changes nothing while the route is down.`;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Binds 127.0.0.1 and resolves with the redirect URI plus the code waiter. */
function bindLoopback(
  port: number,
  timeoutMs: number,
): Promise<{ redirectUri: string; wait: Promise<URLSearchParams> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params = url.searchParams;
      const ok = params.has('code') && !params.has('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ok ? SUCCESS_PAGE : ERROR_PAGE);
      cleanup();
      settle(params);
    });
    let waiter!: (params: URLSearchParams) => void;
    const wait = new Promise<URLSearchParams>((resolveWait) => {
      waiter = resolveWait;
    });
    const settle = (params: URLSearchParams): void => waiter(params);
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new InteractionRequiredError(
          'The browser sign-in timed out waiting for the loopback redirect. ' +
            'A firewall, VPN, or another process on the port is the usual cause; ' +
            'free the loopback port and try again, or use `login --api-key`.',
          [],
          false,
          false,
          true,
        ),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      server.close();
    };
    server.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new InteractionRequiredError(
          `The browser sign-in could not listen on the loopback redirect (${error.code ?? error.message}). ` +
            'Free the port and try again, or use `login --api-key`.',
          [],
          false,
          false,
          true,
        ),
      );
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ redirectUri: `http://127.0.0.1:${bound}/callback`, wait });
    });
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

interface CurrentUserResponse {
  user: {
    id: number;
    login: string;
    firstname?: string;
    lastname?: string;
    mail?: string;
    admin?: boolean;
  };
}

export function createAuthProvider(deps: ProviderDeps): AuthProvider {
  const { config } = deps;
  const preflight = deps.preflight ?? defaultPreflight(config.redmineUrl);
  const open = deps.openBrowser ?? openBrowser;
  const fetchFn = deps.fetchImpl ?? fetch;
  const loopback = deps.loopback ?? ((() => bindLoopback(config.authPort, LOOPBACK_TIMEOUT_MS)) as ProviderDeps['loopback']);

  const tokenUrl = `${config.redmineUrl}/oauth/token`;
  const authorizeUrl = `${config.redmineUrl}/oauth/authorize`;

  /**
   * Whether the server serves an OAuth provider. `GET /oauth/authorize` with
   * bogus parameters answers 400/302/200 when the Doorkeeper routes exist and
   * 404 when they don't (pre-6.1 or provider disabled). Network failures mean
   * "unknown", never "absent": a wrong `false` here would talk the user out
   * of a sign-in that would have worked. Cached per provider instance.
   */
  let oauthProbe: boolean | null | undefined;
  async function hasOAuthProvider(): Promise<boolean | null> {
    if (oauthProbe !== undefined) return oauthProbe;
    const probe = new URL(authorizeUrl);
    probe.searchParams.set('client_id', 'redmine-mcp-probe');
    probe.searchParams.set('redirect_uri', 'http://127.0.0.1:1/callback');
    probe.searchParams.set('response_type', 'code');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchFn(probe, { method: 'GET', signal: controller.signal, redirect: 'manual' });
      oauthProbe = res.status !== 404;
    } catch {
      oauthProbe = null;
    } finally {
      clearTimeout(timer);
    }
    return oauthProbe;
  }

  function noProviderError(scopes: readonly string[]): InteractionRequiredError {
    return new InteractionRequiredError(
      'This Redmine serves no OAuth provider (pre-6.1, or the provider is disabled), so the browser ' +
        `sign-in cannot work here. ${apiKeySetupGuidance()}`,
      [],
      true,
      false,
      false,
      scopes,
    );
  }

  async function postToken(body: Record<string, string>): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(body).toString(),
      });
    } catch (error) {
      throw new InteractionRequiredError(
        networkFailureMessage([], error instanceof Error ? error.message : String(error)),
        [],
        false,
        true,
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new InteractionRequiredError(
        `Redmine refused the OAuth token request (HTTP ${res.status}): ${detail || res.statusText}. ` +
          'The application registration or secret may be wrong; check --client-id/--client-secret and try again.',
      );
    }
    return (await res.json()) as TokenResponse;
  }

  async function fetchCurrentUser(credential: { scheme: 'bearer' | 'apiKey'; value: string }): Promise<AccountInfo> {
    const headers: Record<string, string> =
      credential.scheme === 'bearer'
        ? { Authorization: `Bearer ${credential.value}` }
        : { 'X-Redmine-API-Key': credential.value };
    let res: Response;
    try {
      res = await fetchFn(`${config.redmineUrl}/users/current.json`, { headers });
    } catch (error) {
      throw new InteractionRequiredError(
        networkFailureMessage([], error instanceof Error ? error.message : String(error)),
        [],
        false,
        true,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new InteractionRequiredError(
        `Redmine refused the stored credential (HTTP ${res.status}). Sign in again to replace it.`,
      );
    }
    if (!res.ok) {
      throw new InteractionRequiredError(
        `Redmine answered HTTP ${res.status} for /users/current.json. Sign in again; if it persists, the server may have REST disabled.`,
        [],
        true,
      );
    }
    const payload = (await res.json()) as CurrentUserResponse;
    return {
      id: payload.user.id,
      login: payload.user.login,
      firstname: payload.user.firstname,
      lastname: payload.user.lastname,
      mail: payload.user.mail,
      admin: payload.user.admin,
    };
  }

  async function storeIdentity(account: AccountInfo, source: IdentityRecord['source']): Promise<void> {
    await writeIdentity(config.cacheDir, {
      id: account.id,
      login: account.login,
      firstname: account.firstname,
      lastname: account.lastname,
      mail: account.mail,
      admin: account.admin,
      redmineUrl: config.redmineUrl,
      capturedAt: new Date().toISOString(),
      source,
    });
  }

  async function refresh(session: StoredSession): Promise<StoredSession> {
    if (!session.refreshToken) {
      throw new InteractionRequiredError('The stored session has no refresh token. Sign in again.');
    }
    const tokens = await postToken({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
      client_id: config.clientId,
      ...(config.clientSecret !== '' ? { client_secret: config.clientSecret } : {}),
    });
    const next: StoredSession = {
      redmineUrl: config.redmineUrl,
      clientId: config.clientId,
      kind: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      scopes: session.scopes,
      updatedAt: new Date().toISOString(),
    };
    await writeSession(config.cacheDir, next);
    return next;
  }

  async function loginByBrowser(scopes: string[]): Promise<AccountInfo> {
    // Fail fast before touching a browser: against a provider-less server the
    // authorize page would 404 after the user already switched windows.
    const provider = await hasOAuthProvider();
    if (provider === false) throw noProviderError(scopes);
    if (provider === null) {
      logger.warn('OAuth provider probe failed; attempting the browser flow anyway.', {
        reason: 'reachability unknown',
      });
    }
    if (isClientIdUnset(config.clientId)) {
      throw new InteractionRequiredError(`No OAuth application is configured. ${clientIdGuidance()}`);
    }
    const browser = await preflight.canOpenBrowser();
    if (browser.verdict === 'impossible') {
      throw new InteractionRequiredError(
        `The browser flow cannot work here: ${browser.reason}. Use \`login --api-key\` instead.`,
      );
    }
    const loop = await preflight.canBindLoopback(config.authPort);
    if (loop.verdict === 'impossible') {
      throw new InteractionRequiredError(
        `The browser flow cannot listen for the redirect: ${loop.reason}. ` +
          'Free the loopback port, or use `login --api-key`.',
        [],
        false,
        false,
        true,
      );
    }
    const reachability = await preflight.canReachRedmine();
    if (reachability.verdict !== 'possible') logger.warn('Redmine reachability is uncertain.', { reason: reachability.reason });

    const { redirectUri, wait } = await loopback!(() => undefined);
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString('base64url');
    const authorize = new URL(authorizeUrl);
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('scope', scopes.join(' '));
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    const opened = await open(authorize.toString());
    if (!opened) {
      throw new InteractionRequiredError(
        `No browser could be opened. Sign in from a terminal with an API key instead: \`login --api-key\`. ` +
          `Or open this URL by hand: ${authorize.toString()}`,
      );
    }
    logger.info('Browser sign-in opened; waiting for the loopback redirect.', { redirectUri });
    const params = await wait;
    if (params.get('state') !== state) {
      throw new InteractionRequiredError('The sign-in redirect carried the wrong state. Try signing in again.');
    }
    const error = params.get('error');
    if (error) {
      throw new InteractionRequiredError(
        `Redmine refused the authorization: ${error} ${params.get('error_description') ?? ''}`.trim(),
        [],
        true,
        false,
        false,
        scopes,
      );
    }
    const code = params.get('code');
    if (!code) throw new InteractionRequiredError('The sign-in redirect carried no code. Try signing in again.');
    const tokens = await postToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      ...(config.clientSecret !== '' ? { client_secret: config.clientSecret } : {}),
      code_verifier: verifier,
    });
    const session: StoredSession = {
      redmineUrl: config.redmineUrl,
      clientId: config.clientId,
      kind: 'oauth',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      scopes,
      updatedAt: new Date().toISOString(),
    };
    await writeSession(config.cacheDir, session);
    const account = await fetchCurrentUser({ scheme: 'bearer', value: tokens.access_token });
    await storeIdentity(account, 'oauth-login');
    return account;
  }

  return {
    async getCredential(scopes: string[]): Promise<{ scheme: 'bearer' | 'apiKey'; value: string }> {
      // Explicit configuration wins over cache: a flag/env key works with
      // zero login steps and is never written to disk.
      if (!isApiKeyUnset(config.apiKey)) {
        logger.debug('Using the configured API key.', {});
        return { scheme: 'apiKey', value: config.apiKey.trim() };
      }
      const session = await readSession(config.cacheDir);
      if (session === null || session.redmineUrl !== config.redmineUrl) {
        throw new InteractionRequiredError(
          `Not signed in. Sign in first, then retry the call. ${apiKeySetupGuidance()}`,
          [],
          false,
          false,
          false,
          scopes,
        );
      }
      if (session.kind === 'apikey') {
        if (!session.apiKey) throw new InteractionRequiredError('The stored API-key session is empty. Sign in again.');
        return { scheme: 'apiKey', value: session.apiKey };
      }
      let current = session;
      if (accessTokenExpired(current)) current = await refresh(current);
      if (!current.accessToken) throw new InteractionRequiredError('The stored session has no access token. Sign in again.');
      return { scheme: 'bearer', value: current.accessToken };
    },

    async getAccount(): Promise<AccountInfo | null> {
      const identity = await readIdentity(config.cacheDir);
      if (identity !== null && identity.redmineUrl === config.redmineUrl) {
        return {
          id: identity.id,
          login: identity.login,
          firstname: identity.firstname,
          lastname: identity.lastname,
          mail: identity.mail,
          admin: identity.admin,
        };
      }
      // A configured key carries no snapshot yet: resolve it live once and
      // cache the identity (never the key) for status and attribution.
      if (isApiKeyUnset(config.apiKey)) return null;
      try {
        const account = await fetchCurrentUser({ scheme: 'apiKey', value: config.apiKey.trim() });
        await storeIdentity(account, 'users-current');
        return account;
      } catch {
        return null;
      }
    },

    async login(scopes: string[], flow?: AuthFlow): Promise<AccountInfo> {
      // A configured key needs verifying, not replacing: confirm it live and
      // cache the identity. The key itself is never written to disk.
      if (!isApiKeyUnset(config.apiKey)) {
        const account = await fetchCurrentUser({ scheme: 'apiKey', value: config.apiKey.trim() });
        await storeIdentity(account, 'users-current');
        logger.info('API key verified.', { login: account.login });
        return account;
      }
      const chosen = flow ?? config.authFlow;
      if (chosen === 'apikey') {
        throw new InteractionRequiredError(
          `API-key sign-in needs the key itself. ${apiKeySetupGuidance()}`,
        );
      }
      if (chosen === 'browser') return loginByBrowser(scopes);
      try {
        return await loginByBrowser(scopes);
      } catch (error) {
        if (error instanceof InteractionRequiredError && !error.serverRefused && (error.loopbackTimeout || /browser/i.test(error.message))) {
          throw new InteractionRequiredError(
            `${error.message} Fallback: ${apiKeySetupGuidance()}`,
            error.missingScopes,
            error.serverRefused,
            error.networkFailure,
            error.loopbackTimeout,
            scopes,
          );
        }
        throw error;
      }
    },

    async loginWithApiKey(apiKey: string): Promise<AccountInfo> {
      const key = apiKey.trim();
      if (key === '') throw new InteractionRequiredError('The API key is empty.');
      const account = await fetchCurrentUser({ scheme: 'apiKey', value: key });
      await writeSession(config.cacheDir, {
        redmineUrl: config.redmineUrl,
        clientId: '',
        kind: 'apikey',
        scopes: [],
        apiKey: key,
        updatedAt: new Date().toISOString(),
      });
      await storeIdentity(account, 'users-current');
      return account;
    },

    async logout(): Promise<void> {
      await clearSession(config.cacheDir);
    },

    async sessionHealth(scopes: string[] = []): Promise<SessionHealth> {
      // A configured key is unverified by definition (the user may have
      // pasted it wrong), so it is probed live and fails fast with the fix.
      if (!isApiKeyUnset(config.apiKey)) {
        try {
          await fetchCurrentUser({ scheme: 'apiKey', value: config.apiKey.trim() });
          return { credentialUsable: true, note: 'configured API key verified live' };
        } catch (error) {
          return {
            credentialUsable: false,
            note: `configured API key refused: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
          };
        }
      }
      const session = await readSession(config.cacheDir);
      if (session === null || session.redmineUrl !== config.redmineUrl) {
        return { credentialUsable: false, note: 'no session is stored' };
      }
      if (session.kind === 'apikey') {
        return session.apiKey
          ? { credentialUsable: true, note: 'API-key session (not probed)' }
          : { credentialUsable: false, note: 'API-key session is empty' };
      }
      if (!accessTokenExpired(session)) return { credentialUsable: true, note: 'access token is fresh' };
      if (!session.refreshToken) return { credentialUsable: false, note: 'access token expired and no refresh token is stored' };
      try {
        await refresh(session);
        return { credentialUsable: true, note: 'access token was refreshed silently' };
      } catch (error) {
        return {
          credentialUsable: false,
          note: `refresh failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
        };
      }
    },
  };
}
