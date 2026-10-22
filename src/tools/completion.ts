/**
 * Argument completers for the issue tools: project identifiers, trackers,
 * statuses, and assignees.
 *
 * Each completer queries a Redmine list endpoint, filters client-side, caches
 * briefly, and returns `[]` on any failure — never an error. The callbacks
 * attach to tool input schemas via {@link withCompleter}, which stamps the
 * same `Symbol.for('mcp.completable')` metadata the MCP SDK's own
 * `completable()` helper writes (same key, same non-enumerable value shape),
 * keeping tool modules free of an SDK runtime dependency.
 *
 * Wire status (verified against @modelcontextprotocol/server 2.3.1, which
 * speaks spec versions 2024-10-07 through 2025-11-25): `completion/complete`
 * routes only for prompt (`ref/prompt`) and resource-template (`ref/resource`)
 * refs — no tool ref exists in the spec — so these tool-argument completers
 * are inert on the wire today. Two things light them up: the spec gaining a
 * tool-argument ref, and the SDK routing it. Meanwhile the same callbacks are
 * live on the `triage_issue` prompt (`src/prompts.ts`), and the tool stamps
 * stay in the SDK's own shape so they activate with no code change if routing
 * ever arrives. They are also directly unit-testable as pure callbacks.
 */

import type { RedmineClient } from '../contracts.js';

/** The context object the SDK passes alongside the partial value. */
export interface CompletionContext {
  arguments?: Record<string, string> | undefined;
}

/** Suggests values for one argument; failures must resolve to `[]`. */
export type CompleteCallback = (value: string, context?: CompletionContext) => Promise<string[]> | string[];

/** The exact symbol the SDK's `completable()` helper writes. */
const COMPLETABLE = Symbol.for('mcp.completable');

/** Stamps `complete` onto `schema` exactly like the SDK helper does. */
export function withCompleter<T>(schema: T, complete: CompleteCallback): T {
  Object.defineProperty(schema, COMPLETABLE, {
    value: { complete },
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return schema;
}

/** Reads the completer stamped directly on `schema`, if any. */
function directCompleter(schema: unknown): CompleteCallback | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const entry = (schema as Record<symbol, { complete?: CompleteCallback } | undefined>)[COMPLETABLE];
  return entry?.complete;
}

/** Unwraps one Zod optional layer (v4 `def`, v3 `_def` fallback). */
function unwrapOptional(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const v4 = (schema as { def?: { type?: string; innerType?: unknown } }).def;
  if (v4?.type === 'optional') return v4.innerType;
  return (schema as { _def?: { innerType?: unknown } })._def?.innerType;
}

/**
 * Reads the completer for a schema field, looking through one optional
 * wrapper so both `withCompleter(s, cb).optional()` and
 * `withCompleter(s.optional(), cb)` shapes resolve.
 */
export function fieldCompleter(field: unknown): CompleteCallback | undefined {
  return directCompleter(field) ?? directCompleter(unwrapOptional(field));
}

/** True when {@link fieldCompleter} would find a callback. */
export function isCompletable(field: unknown): boolean {
  return fieldCompleter(field) !== undefined;
}

/** Reads one zod object's field by name (v4 `shape`, v3 fallback). */
export function shapeField(schema: unknown, name: string): unknown {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const shape = (schema as { shape?: unknown }).shape;
  if (typeof shape === 'object' && shape !== null) return (shape as Record<string, unknown>)[name];
  const v4 = (schema as { def?: { shape?: unknown } }).def?.shape;
  if (typeof v4 === 'object' && v4 !== null) return (v4 as Record<string, unknown>)[name];
  return undefined;
}

export interface CompleterDeps {
  redmine: RedmineClient;
  /** Cache lifetime in ms. Brief by default; completions must stay fresh. */
  ttlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface IssueCompleters {
  completeProject: CompleteCallback;
  completeTracker: CompleteCallback;
  completeStatus: CompleteCallback;
  completeAssignee: CompleteCallback;
}

/** Protocol ceiling: at most 100 completion values per response. */
const MAX_VALUES = 100;

interface CachedEntry {
  id: string;
  label: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Builds the four issue-argument completers over one short-lived cache.
 * One set per tool-module build, so nothing leaks across connections.
 */
export function createIssueCompleters(deps: CompleterDeps): IssueCompleters {
  const ttlMs = deps.ttlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { expires: number; entries: CachedEntry[] }>();

  async function cached(key: string, load: () => Promise<CachedEntry[]>): Promise<CachedEntry[]> {
    const hit = cache.get(key);
    if (hit !== undefined && hit.expires > now()) return hit.entries;
    const entries = await load();
    cache.set(key, { expires: now() + ttlMs, entries });
    return entries;
  }

  function match(entries: CachedEntry[], value: string): string[] {
    const needle = value.trim().toLowerCase();
    const matched =
      needle === ''
        ? entries
        : entries.filter((entry) => entry.label.toLowerCase().includes(needle) || entry.id.toLowerCase().startsWith(needle));
    return [...new Set(matched.map((entry) => entry.id))].slice(0, MAX_VALUES);
  }

  async function projects(): Promise<CachedEntry[]> {
    return cached('projects', async () => {
      const res = await deps.redmine.request<{ projects: unknown[] }>({
        path: '/projects.json',
        query: { limit: 100 },
        scopes: ['view_project'],
      });
      return res.data.projects.filter(isRecord).flatMap((project) => {
        const identifier = nonEmpty(project['identifier']) ?? (typeof project['id'] === 'number' ? String(project['id']) : undefined);
        if (identifier === undefined) return [];
        const name = nonEmpty(project['name']) ?? '';
        return [{ id: identifier, label: `${name} ${identifier}`.trim() }];
      });
    });
  }

  async function enums(path: string): Promise<CachedEntry[]> {
    return cached(path, async () => {
      // Trackers and statuses need only authentication server-side; the scope
      // labels the issue-tool context. `getCredential` never enforces them.
      const res = await deps.redmine.request<Record<string, unknown>>({ path, scopes: ['view_issues'] });
      const key = Object.keys(res.data).find((k) => Array.isArray(res.data[k]));
      const items = key === undefined ? [] : (res.data[key] as unknown[]);
      return items.filter(isRecord).flatMap((item) => {
        if (typeof item['id'] !== 'number') return [];
        return [{ id: String(item['id']), label: nonEmpty(item['name']) ?? String(item['id']) }];
      });
    });
  }

  async function userSearch(name: string): Promise<CachedEntry[]> {
    return cached(`users:${name}`, async () => {
      const res = await deps.redmine.request<{ users: unknown[] }>({
        path: '/users.json',
        query: name === '' ? { limit: 100 } : { name, limit: 100 },
        scopes: ['view_users'],
      });
      return res.data.users.filter(isRecord).flatMap((user) => {
        if (typeof user['id'] !== 'number') return [];
        const login = nonEmpty(user['login']) ?? '';
        const full = `${nonEmpty(user['firstname']) ?? ''} ${nonEmpty(user['lastname']) ?? ''}`.trim();
        return [{ id: String(user['id']), label: `${login} ${full}`.trim() || String(user['id']) }];
      });
    });
  }

  async function memberships(project: string): Promise<CachedEntry[]> {
    return cached(`memberships:${project}`, async () => {
      const res = await deps.redmine.request<{ memberships: unknown[] }>({
        path: `/projects/${project}/memberships.json`,
        query: { limit: 100 },
        scopes: ['view_project'],
      });
      return res.data.memberships.filter(isRecord).flatMap((membership) => {
        const user = membership['user'];
        if (!isRecord(user) || typeof user['id'] !== 'number') return [];
        return [{ id: String(user['id']), label: nonEmpty(user['name']) ?? String(user['id']) }];
      });
    });
  }

  return {
    completeProject: async (value) => {
      try {
        return match(await projects(), value);
      } catch {
        return [];
      }
    },
    completeTracker: async (value) => {
      try {
        return match(await enums('/trackers.json'), value);
      } catch {
        return [];
      }
    },
    completeStatus: async (value) => {
      try {
        return match(await enums('/issue_statuses.json'), value);
      } catch {
        return [];
      }
    },
    completeAssignee: async (value, context) => {
      try {
        const out: string[] = [];
        if ('me'.startsWith(value.trim().toLowerCase()) || value.trim() === '') out.push('me');
        // `/users.json` is admin-only: non-admins fail here and fall through
        // to the project memberships below. Any failure still yields `[]`.
        try {
          out.push(...match(await userSearch(value.trim()), value));
        } catch {
          // Memberships (when a project is in context) are the fallback.
        }
        const project = context?.arguments?.['project_id'] ?? context?.arguments?.['project'];
        if (project !== undefined && project !== '') {
          try {
            out.push(...match(await memberships(project), value));
          } catch {
            // Membership failures never fail the completion.
          }
        }
        return [...new Set(out)].slice(0, MAX_VALUES);
      } catch {
        return [];
      }
    },
  };
}
