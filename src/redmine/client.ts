/**
 * Redmine REST client: host pinning, credential injection, retry with
 * backoff, and `offset`/`limit` paging.
 *
 * Every request carries `.json`, sets `Content-Type: application/json` on
 * writes (Redmine requires it), and pins the response host to the configured
 * server so a redirect can never leak the credential elsewhere.
 */

import type {
  AuthProvider,
  HttpMethod,
  RedmineClient,
  RedmineRequestOptions,
  RedmineResponse,
  ServerConfig,
} from '../contracts.js';
import { InteractionRequiredError, RedmineError } from '../contracts.js';
import { isNetworkFailure } from '../auth/provider.js';
import { logger } from '../util/logger.js';

/** Redmine's page ceiling: `limit` above 100 is silently clamped. */
export const MAX_LIMIT = 100;

/** Statuses worth one retry with backoff (idempotent reads only). */
const RETRYABLE = new Set([429, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RedmineClientDeps {
  auth: AuthProvider;
  config: ServerConfig;
  fetchImpl?: typeof fetch;
}

export function createRedmineClient(deps: RedmineClientDeps): RedmineClient {
  const { auth, config } = deps;
  const fetchFn = deps.fetchImpl ?? fetch;
  const base = new URL(config.redmineUrl);

  function urlFor(path: string, query?: Record<string, string | number | boolean | undefined>): URL {
    if (!path.startsWith('/')) throw new RedmineError({ message: `Redmine path must start with /: ${path}`, status: 0, path });
    const url = new URL(path, base);
    if (url.host !== base.host || url.protocol !== base.protocol) {
      throw new RedmineError({ message: `Refusing to leave the Redmine host: ${path}`, status: 0, path });
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  function hintFor(status: number, path: string): string | undefined {
    if (status === 401) return 'The credential was refused. Sign in again (OAuth) or check the API key and that REST API access is enabled for the account.';
    if (status === 403) return 'Redmine refused the call: the account lacks the permission, or the OAuth application was not granted its scope. An admin can widen the application scopes.';
    if (status === 404) return `Nothing at ${path}: the id may be wrong, or the object may be invisible to this account.`;
    if (status === 422) return 'Redmine rejected the attributes. Read the errors array: it names the failing field.';
    return undefined;
  }

  async function once<T>(
    method: HttpMethod,
    url: URL,
    path: string,
    credential: { scheme: 'bearer' | 'apiKey'; value: string },
    body: unknown,
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; data: T; retryAfterMs: number }> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json',
        ...(credential.scheme === 'bearer'
          ? { Authorization: `Bearer ${credential.value}` }
          : { 'X-Redmine-API-Key': credential.value }),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
      redirect: 'manual',
    };
    if (config.verbose) logger.info('Redmine request.', { method, url: url.toString() });
    const res = await fetchFn(url, init);
    if (res.status >= 300 && res.status < 400) {
      throw new RedmineError({
        message: `Refusing to follow a redirect off the Redmine host (${res.status} for ${path}).`,
        status: res.status,
        path,
      });
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000;
    if (res.status === 204) return { status: 204, data: undefined as T, retryAfterMs };
    const text = await res.text();
    let data: T;
    try {
      data = (text === '' ? undefined : JSON.parse(text)) as T;
    } catch {
      throw new RedmineError({ message: `Redmine answered HTTP ${res.status} with a non-JSON body.`, status: res.status, path });
    }
    return { status: res.status, data, retryAfterMs };
  }

  async function requestPage<T>(opts: RedmineRequestOptions, offset: number): Promise<RedmineResponse<T>> {
    const method = opts.method ?? 'GET';
    const credential = await auth.getCredential(opts.scopes);
    const url = urlFor(opts.path, opts.query);
    if ((method === 'GET' || opts.maxPages !== undefined) && !url.searchParams.has('offset') && offset > 0) {
      url.searchParams.set('offset', String(offset));
    }
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let outcome: { status: number; data: T; retryAfterMs: number };
      try {
        outcome = await once<T>(method, url, opts.path, credential, opts.body, opts.headers, opts.signal);
      } catch (error) {
        if (error instanceof RedmineError || error instanceof InteractionRequiredError) throw error;
        if (error instanceof Error && isNetworkFailure(error)) {
          throw new InteractionRequiredError(
            `The request never reached Redmine (${error.message}). Check the connection and retry the call.`,
            [],
            false,
            true,
            false,
            opts.scopes,
          );
        }
        throw error;
      }
      if (outcome.status >= 200 && outcome.status < 300) {
        const total = (outcome.data as { total_count?: unknown } | null)?.total_count;
        return {
          status: outcome.status,
          data: outcome.data,
          ...(typeof total === 'number' ? { totalCount: total } : {}),
        };
      }
      if (method === 'GET' && RETRYABLE.has(outcome.status) && attempt < 3) {
        await sleep(outcome.retryAfterMs);
        continue;
      }
      const errors = (outcome.data as { errors?: unknown } | null)?.errors;
      const detail = Array.isArray(errors) ? errors.map(String).join('; ') : undefined;
      throw new RedmineError({
        message: detail ?? `Redmine answered HTTP ${outcome.status} for ${opts.path}.`,
        status: outcome.status,
        path: opts.path,
        hint: hintFor(outcome.status, opts.path),
      });
    }
  }

  return {
    async request<T = unknown>(opts: RedmineRequestOptions): Promise<RedmineResponse<T>> {
      const pages = Math.max(1, opts.maxPages ?? 1);
      const first = await requestPage<T>(opts, 0);
      if (pages === 1) return first;
      // Paging merges the collection key across pages; anything else passes through.
      const merged = mergePages<T>(first.data);
      if (!merged) return first;
      const limit = readLimit(opts.query);
      let offset = limit;
      for (let page = 1; page < pages; page += 1) {
        const next = await requestPage<T>(opts, offset);
        const items = collectionOf(next.data, merged.key);
        if (items.length === 0) break;
        merged.items.push(...items);
        offset += limit;
        if (first.totalCount !== undefined && offset >= first.totalCount) break;
      }
      return { status: first.status, data: merged.data, totalCount: first.totalCount };
    },

    async requestRaw(opts): Promise<{ status: number; bytes: Uint8Array; contentType: string }> {
      const method = opts.method ?? 'GET';
      const credential = await auth.getCredential(opts.scopes);
      const url = urlFor(opts.path, opts.query);
      if (config.verbose) logger.info('Redmine raw request.', { method, url: url.toString() });
      let res: Response;
      try {
        res = await fetchFn(url, {
          method,
          headers: {
            Accept: '*/*',
            ...(credential.scheme === 'bearer'
              ? { Authorization: `Bearer ${credential.value}` }
              : { 'X-Redmine-API-Key': credential.value }),
            ...(opts.contentType ? { 'Content-Type': opts.contentType } : {}),
            ...opts.headers,
          },
          ...(opts.body ? { body: Buffer.from(opts.body) } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          redirect: 'manual',
        });
      } catch (error) {
        if (error instanceof Error && isNetworkFailure(error)) {
          throw new InteractionRequiredError(
            `The request never reached Redmine (${error.message}). Check the connection and retry the call.`,
            [],
            false,
            true,
            false,
            opts.scopes,
          );
        }
        throw error;
      }
      if (res.status >= 300 && res.status < 400) {
        throw new RedmineError({
          message: `Refusing to follow a redirect off the Redmine host (${res.status} for ${opts.path}).`,
          status: res.status,
          path: opts.path,
        });
      }
      if (res.status < 200 || res.status >= 300) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new RedmineError({
          message: detail || `Redmine answered HTTP ${res.status} for ${opts.path}.`,
          status: res.status,
          path: opts.path,
          hint: hintFor(res.status, opts.path),
        });
      }
      const buffer = await res.arrayBuffer();
      return { status: res.status, bytes: new Uint8Array(buffer), contentType: res.headers.get('content-type') ?? '' };
    },
  };
}

function readLimit(query: Record<string, string | number | boolean | undefined> | undefined): number {
  const raw = query?.['limit'];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : 25;
}

function collectionOf(data: unknown, key: string): unknown[] {
  if (typeof data !== 'object' || data === null) return [];
  const items = (data as Record<string, unknown>)[key];
  return Array.isArray(items) ? items : [];
}

function mergePages<T>(data: T): { key: string; items: unknown[]; data: T } | null {
  if (typeof data !== 'object' || data === null) return null;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(value) && key !== 'errors') {
      const items = [...value];
      return { key, items, data: { ...(data as Record<string, unknown>), [key]: items } as T };
    }
  }
  return null;
}
