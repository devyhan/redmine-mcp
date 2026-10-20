/**
 * The tool-group catalogue: the single source of truth for which Redmine
 * permission scopes each area needs.
 *
 * Redmine/Doorkeeper scopes are Redmine permission names (plus `admin`), and
 * `enforce_configured_scopes` forbids anything the application was not
 * registered with. Group scopes stay the coarse grouping; the per-tool
 * `scopes` arrays are the precise source the consent set is built from.
 */

import type { ServerConfig, ToolDefinition, ToolGroupMeta } from '../contracts.js';

export const GROUPS: Record<string, ToolGroupMeta> = {
  issues: {
    name: 'issues',
    title: 'Issues',
    description: 'Issue tracking: list, search, read, create, update, notes, watchers, relations.',
    readScopes: ['view_issues'],
    writeScopes: ['add_issues', 'edit_issues', 'add_issue_notes', 'delete_issues'],
    requiresAdmin: false,
  },
  projects: {
    name: 'projects',
    title: 'Projects',
    description: 'Projects and memberships: list, read, create, update, members.',
    readScopes: ['view_project'],
    writeScopes: ['add_project', 'edit_project', 'manage_members'],
    requiresAdmin: false,
  },
  users: {
    name: 'users',
    title: 'Users',
    description: 'Users and the signed-in account: current user, lookup, update own account.',
    readScopes: ['view_users'],
    writeScopes: [],
    requiresAdmin: false,
  },
  time: {
    name: 'time',
    title: 'Time tracking',
    description: 'Time entries and activities: log, list, update spent time.',
    readScopes: ['view_time_entries'],
    writeScopes: ['log_time', 'edit_time_entries'],
    requiresAdmin: false,
  },
  wiki: {
    name: 'wiki',
    title: 'Wiki',
    description: 'Wiki pages: read, create, update, delete.',
    readScopes: ['view_wiki_pages'],
    writeScopes: ['edit_wiki_pages', 'delete_wiki_pages'],
    requiresAdmin: false,
  },
  files: {
    name: 'files',
    title: 'Files',
    description: 'Attachments and uploads: download, upload, attach to issues.',
    readScopes: ['view_files'],
    writeScopes: ['manage_files'],
    requiresAdmin: false,
  },
  search: {
    name: 'search',
    title: 'Search',
    description: 'Global search across issues, wiki, documents, and files.',
    readScopes: ['search_project'],
    writeScopes: [],
    requiresAdmin: false,
  },
  queries: {
    name: 'queries',
    title: 'Saved queries',
    description: 'Saved issue queries: list and run.',
    readScopes: ['view_issues', 'save_queries'],
    writeScopes: [],
    requiresAdmin: false,
  },
  admin: {
    name: 'admin',
    title: 'Administration',
    description: 'Trackers, statuses, roles, groups, enumerations, custom fields.',
    readScopes: ['admin'],
    writeScopes: ['admin'],
    requiresAdmin: true,
  },
};

/** Group names in catalogue order. */
export const GROUP_NAMES: string[] = Object.keys(GROUPS);

/** Selectable presets for `--preset`. */
export const PRESETS: Record<string, { title: string; groups: string[] }> = {
  personal: {
    title: 'Everyday tracking',
    groups: ['issues', 'projects', 'users', 'time', 'wiki', 'files', 'search', 'queries'],
  },
  all: { title: 'Everything, including administration', groups: [...GROUP_NAMES] },
};

export const PRESET_NAMES: string[] = Object.keys(PRESETS);

/** Everything `--groups`/`--preset` resolution needs to report. */
export interface ResolvedGroups {
  groups: string[];
  droppedGroups: string[];
}

export function resolveGroupsDetailed(
  requested: string[] | undefined,
  preset: string | undefined,
  orgMode: boolean,
): ResolvedGroups {
  let names: string[];
  if (requested !== undefined && requested.length > 0) {
    names = [...requested];
  } else if (preset !== undefined) {
    const found = PRESETS[preset];
    if (found === undefined) throw new Error(`Unknown preset: ${preset} (expected ${PRESET_NAMES.join(', ')})`);
    names = [...found.groups];
  } else {
    names = [...PRESETS['personal']!.groups];
  }
  const unknown = names.filter((name) => GROUPS[name] === undefined);
  if (unknown.length > 0) {
    throw new Error(`Unknown group: ${unknown.join(', ')} (expected ${GROUP_NAMES.join(', ')})`);
  }
  const droppedGroups = orgMode ? [] : names.filter((name) => GROUPS[name]!.requiresAdmin);
  const dropped = new Set(droppedGroups);
  return { groups: names.filter((name) => !dropped.has(name)), droppedGroups };
}

/** Scopes the enabled groups' read tools need. */
export function scopesForGroups(config: ServerConfig): string[] {
  const out = new Set<string>();
  for (const name of config.groups) {
    const group = GROUPS[name];
    if (group === undefined) continue;
    for (const scope of group.readScopes) out.add(scope);
    if (!config.readOnly) for (const scope of group.writeScopes) out.add(scope);
  }
  return [...out];
}

/** Union of every tool's declared scopes: the precise consent checklist. */
export function consentScopesFor(config: ServerConfig, tools: readonly ToolDefinition[]): string[] {
  const out = new Set<string>(scopesForGroups(config));
  for (const tool of tools) {
    if (config.readOnly && tool.write === true) continue;
    for (const scope of tool.scopes) out.add(scope);
  }
  return [...out].sort();
}

/**
 * What a sign-in asks for: the minimal set plus whatever the caller names.
 * Incremental consent grows from there via re-login with added scopes.
 */
export function loginScopesFor(config: ServerConfig, extra: readonly string[] = []): string[] {
  return [...new Set([...scopesForGroups(config), ...extra])];
}
