/**
 * Display-name resolution for user arguments on the issue tools.
 *
 * Redmine itself only accepts numeric user ids (and the literal `me` on list
 * filters) for assignee fields, so a display name or login is resolved to an
 * id here, before the call, via the user search both the tools and the
 * completers use: `GET /users.json?name=` for admins, project memberships
 * otherwise. Ranking is exact-match-first so it never depends on how Redmine
 * tokenizes the `name` filter server-side (case-insensitive LIKE-contains):
 * login exact, then `firstname lastname` exact, then mail exact, then an
 * unambiguous contains match. Anything else is a precise error, never a guess.
 *
 * Privacy rule: resolution returns only the numeric id. Errors name
 * candidates by login, display name, and id — never mail addresses, never raw
 * user objects. Matching may compare against a mail the caller already typed,
 * but no other account's mail may appear on the wire or in an error.
 */

import { RedmineError, type RedmineClient } from '../contracts.js';

export interface ResolveAssigneeOptions {
  /**
   * Accept the literal `me` and pass it through. Only list filters take it;
   * create/update need a numeric id, so it stays rejected there with a hint.
   */
  allowMe?: boolean;
  /**
   * Project id or identifier scoping the non-admin fallback: when the user
   * index refuses (it is admin-only), memberships of this project are searched
   * instead. Omit when the calling tool has no project argument.
   */
  project?: number | string;
}

/** The only user fields resolution reads; only id/login/name ever surface. */
interface Candidate {
  id: number;
  login: string;
  name: string;
  mail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function fold(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function candidateLine(candidate: Candidate): string {
  const name = candidate.name === '' ? candidate.login : `${candidate.login} (${candidate.name})`;
  return `- ${name}, id ${candidate.id}`;
}

function unknownAssigneeError(value: string, searched: string): RedmineError {
  return new RedmineError({
    message: `Unknown assignee "${value}": no Redmine user matches.`,
    status: 404,
    path: '/users.json',
    hint:
      `Check the spelling, or pass the numeric user id instead (users_get_current reports your own). ` +
      `On issues_list the literal "me" filters to your own issues. Searched ${searched}.`,
  });
}

function ambiguousAssigneeError(value: string, candidates: Candidate[]): RedmineError {
  const lines = candidates.map(candidateLine).join('\n');
  return new RedmineError({
    message: `Ambiguous assignee "${value}": ${candidates.length} Redmine users match.`,
    status: 422,
    path: '/users.json',
    hint: `Re-run with one numeric id. Candidates:\n${lines}`,
  });
}

/**
 * Ranks `candidates` against `value`: login exact, then full-name exact, then
 * mail exact, then an unambiguous contains match over login and name. Returns
 * the winner's id, or throws a no-match/ambiguous `RedmineError` that names
 * the fix. `searched` describes the source for the no-match hint.
 */
function pick(candidates: Candidate[], value: string, searched: string): number {
  const needle = fold(value);
  const exact = (field: (candidate: Candidate) => string): Candidate[] =>
    candidates.filter((candidate) => fold(field(candidate)) === needle && needle !== '');
  for (const field of [(c: Candidate): string => c.login, (c: Candidate): string => c.name, (c: Candidate): string => c.mail]) {
    const hits = exact(field);
    if (hits.length === 1) return hits[0]!.id;
    if (hits.length > 1) throw ambiguousAssigneeError(value, hits);
  }
  const contains = candidates.filter(
    (candidate) => candidate.login.toLowerCase().includes(needle) || candidate.name.toLowerCase().includes(needle),
  );
  if (contains.length === 1) return contains[0]!.id;
  if (contains.length > 1) throw ambiguousAssigneeError(value, contains);
  throw unknownAssigneeError(value, searched);
}

function usersFromSearch(users: unknown[]): Candidate[] {
  return users.filter(isRecord).flatMap((user): Candidate[] => {
    if (typeof user['id'] !== 'number') return [];
    const login = nonEmpty(user['login']);
    const name = `${nonEmpty(user['firstname'])} ${nonEmpty(user['lastname'])}`.trim();
    return [{ id: user['id'], login, name, mail: nonEmpty(user['mail']) }];
  });
}

function usersFromMemberships(memberships: unknown[]): Candidate[] {
  return memberships.filter(isRecord).flatMap((membership): Candidate[] => {
    const user = membership['user'];
    if (!isRecord(user) || typeof user['id'] !== 'number') return [];
    // Memberships carry no login or mail, only a display name: matching runs
    // on `name` alone, and errors can only repeat that name back.
    return [{ id: user['id'], login: '', name: nonEmpty(user['name']), mail: '' }];
  });
}

/**
 * Resolves an assignee argument to a numeric user id (or the literal `me`
 * when `allowMe` is set). Numeric input passes through untouched; anything
 * else is looked up before the call so Redmine never sees a name.
 */
export async function resolveAssignee(
  redmine: RedmineClient,
  value: number | string,
  opts: ResolveAssigneeOptions = {},
): Promise<number | 'me'> {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '') {
    throw new RedmineError({
      message: 'Assignee must not be empty: pass a numeric user id, a login, or "Firstname Lastname".',
      status: 422,
      path: '/users.json',
    });
  }
  if (trimmed === 'me') {
    if (opts.allowMe === true) return 'me';
    throw new RedmineError({
      message: 'The literal "me" is only accepted by issues_list.',
      status: 422,
      path: '/users.json',
      hint: 'Pass your numeric user id instead — users_get_current reports it.',
    });
  }

  let users: Candidate[];
  try {
    const res = await redmine.request<{ users: unknown[] }>({
      path: '/users.json',
      query: { name: trimmed, limit: 100 },
      scopes: ['view_users'],
    });
    users = usersFromSearch(res.data.users);
  } catch (error) {
    // The user index is admin-only; non-admins fall back to the memberships
    // of the calling tool's project when one is in scope.
    if (error instanceof RedmineError && error.status === 403 && opts.project !== undefined && opts.project !== '') {
      const res = await redmine.request<{ memberships: unknown[] }>({
        path: `/projects/${opts.project}/memberships.json`,
        query: { limit: 100 },
        scopes: ['view_project'],
      });
      return pick(usersFromMemberships(res.data.memberships), trimmed, `memberships of project "${opts.project}"`);
    }
    if (error instanceof RedmineError && error.status === 403) {
      throw new RedmineError({
        message: `Cannot resolve assignee "${trimmed}": the Redmine user index is admin-only and this account is not one.`,
        status: 403,
        path: '/users.json',
        hint: 'Pass the numeric user id instead (users_get_current reports your own), or run the same query scoped to a project so project memberships can resolve the name.',
      });
    }
    throw error;
  }
  return pick(users, trimmed, 'the user index');
}
