/**
 * Resource links for tool results: browser-openable Redmine web URLs carried
 * as `resource_link` content blocks after the text.
 *
 * Redmine `https://` URLs are used rather than `redmine://` URIs on purpose:
 * this server implements no `resources` handlers, so a custom scheme would be
 * dead, while an `https` link renders in every client with no extra
 * capability. The text output is untouched — links only ever append.
 */

import type { ServerConfig } from '../contracts.js';

/** The wire shape of one `resource_link` content block. */
export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string | undefined;
  mimeType: string;
}

/** Caps the appended blocks so a 100-item page stays small. */
export const MAX_RESOURCE_LINKS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asId(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

function baseOf(config: Pick<ServerConfig, 'redmineUrl'>): string {
  return config.redmineUrl.replace(/\/+$/, '');
}

function issueLink(base: string, issue: Record<string, unknown>): ResourceLinkBlock | undefined {
  const id = asId(issue['id']);
  if (id === undefined) return undefined;
  const subject = typeof issue['subject'] === 'string' && issue['subject'] !== '' ? ` ${issue['subject']}` : '';
  return {
    type: 'resource_link',
    uri: `${base}/issues/${id}`,
    name: `#${id}${subject}`,
    mimeType: 'text/html',
  };
}

function projectLink(base: string, project: Record<string, unknown>): ResourceLinkBlock | undefined {
  const slug = asId(project['identifier']) ?? asId(project['id']);
  if (slug === undefined) return undefined;
  const name =
    typeof project['name'] === 'string' && project['name'] !== '' ? project['name'] : `project ${String(slug)}`;
  return { type: 'resource_link', uri: `${base}/projects/${slug}`, name, mimeType: 'text/html' };
}

function userLink(base: string, user: Record<string, unknown>): ResourceLinkBlock | undefined {
  const id = asId(user['id']);
  if (id === undefined) return undefined;
  const login = typeof user['login'] === 'string' && user['login'] !== '' ? user['login'] : `#${id}`;
  return { type: 'resource_link', uri: `${base}/users/${id}`, name: login, mimeType: 'text/html' };
}

function take(links: (ResourceLinkBlock | undefined)[]): ResourceLinkBlock[] {
  const out: ResourceLinkBlock[] = [];
  for (const link of links) {
    if (link !== undefined) out.push(link);
    if (out.length >= MAX_RESOURCE_LINKS) break;
  }
  return out;
}

/**
 * Builds the `resource_link` blocks for a tool result. Returns `[]` for tools
 * and shapes with nothing linkable — never throws on unexpected shapes.
 */
export function resourceLinksFor(
  toolName: string,
  value: unknown,
  config: Pick<ServerConfig, 'redmineUrl'>,
): ResourceLinkBlock[] {
  const base = baseOf(config);
  if (toolName === 'issues_list' && isRecord(value) && Array.isArray(value['issues'])) {
    return take((value['issues'] as unknown[]).map((issue) => (isRecord(issue) ? issueLink(base, issue) : undefined)));
  }
  if ((toolName === 'issues_get' || toolName === 'issues_create') && isRecord(value)) {
    return take([issueLink(base, value)]);
  }
  if (
    (toolName === 'issues_update' || toolName === 'issues_add_note' || toolName === 'issues_delete') &&
    isRecord(value)
  ) {
    const id = asId(value['updated']) ?? asId(value['deleted']);
    if (id === undefined) return [];
    return [{ type: 'resource_link', uri: `${base}/issues/${id}`, name: `#${String(id)}`, mimeType: 'text/html' }];
  }
  if (toolName === 'projects_list' && isRecord(value) && Array.isArray(value['projects'])) {
    return take(
      (value['projects'] as unknown[]).map((project) => (isRecord(project) ? projectLink(base, project) : undefined)),
    );
  }
  if ((toolName === 'projects_get' || toolName === 'projects_create') && isRecord(value)) {
    return take([projectLink(base, value)]);
  }
  if (toolName === 'projects_update' && isRecord(value)) {
    const slug = asId(value['updated']);
    if (slug === undefined) return [];
    const name = typeof slug === 'number' ? `project ${slug}` : slug;
    return [{ type: 'resource_link', uri: `${base}/projects/${slug}`, name, mimeType: 'text/html' }];
  }
  if (toolName === 'users_list' && isRecord(value) && Array.isArray(value['users'])) {
    return take((value['users'] as unknown[]).map((user) => (isRecord(user) ? userLink(base, user) : undefined)));
  }
  if ((toolName === 'users_get' || toolName === 'users_get_current') && isRecord(value)) {
    return take([userLink(base, value)]);
  }
  if (toolName === 'users_my_access' && isRecord(value) && Array.isArray(value['projects'])) {
    return take(
      (value['projects'] as unknown[]).map((project) => (isRecord(project) ? projectLink(base, project) : undefined)),
    );
  }
  return [];
}
