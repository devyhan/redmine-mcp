/**
 * The `admin` group: trackers, statuses, priorities, roles, groups, custom
 * fields, and versions. Read-only enumerations plus version management.
 *
 * Flagged `requiresAdmin`: excluded unless `--org-mode` is set.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['admin']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

const versionsInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
});

const versionCreateInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  name: z.string().min(1).describe('Version name.'),
  status: z.enum(['open', 'locked', 'closed']).optional(),
  due_date: z.string().optional().describe('YYYY-MM-DD.'),
  description: z.string().optional(),
  sharing: z.enum(['none', 'descendants', 'hierarchy', 'tree', 'system']).optional(),
});

const versionUpdateInput = z.object({
  id: z.number().int().describe('Version id.'),
  name: z.string().min(1).optional(),
  status: z.enum(['open', 'locked', 'closed']).optional(),
  due_date: z.string().optional().describe('YYYY-MM-DD.'),
  description: z.string().optional(),
  sharing: z.enum(['none', 'descendants', 'hierarchy', 'tree', 'system']).optional(),
});

const versionDeleteInput = z.object({
  id: z.number().int().describe('Version id.'),
});

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const adminModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    const enumeration = (
      name: string,
      title: string,
      description: string,
      path: string,
      key: string,
    ): ToolDefinition => ({
      name,
      title,
      description,
      inputSchema: z.object({}),
      scopes: READ_SCOPES,
      group: GROUP.name,
      handler: async () => {
        const res = await redmine.request<Record<string, unknown>>({ path, scopes: READ_SCOPES });
        return res.data[key];
      },
    });
    return [
      enumeration('admin_list_trackers', 'List trackers', 'Lists all trackers with their ids.', '/trackers.json', 'trackers'),
      enumeration('admin_list_statuses', 'List issue statuses', 'Lists all issue statuses with their ids.', '/issue_statuses.json', 'issue_statuses'),
      enumeration('admin_list_priorities', 'List priorities', 'Lists all issue priorities with their ids.', '/enumerations/issue_priorities.json', 'issue_priorities'),
      enumeration('admin_list_roles', 'List roles', 'Lists all roles with their ids and permissions.', '/roles.json', 'roles'),
      enumeration('admin_list_groups', 'List groups', 'Lists all groups with their ids and members.', '/groups.json', 'groups'),
      enumeration('admin_list_custom_fields', 'List custom fields', 'Lists all custom fields with ids, types, and bindings.', '/custom_fields.json', 'custom_fields'),
      enumeration('admin_list_news', 'List news', 'Lists news across projects (newest first).', '/news.json', 'news'),
      {
        name: 'admin_list_versions',
        title: 'List versions',
        description: 'Lists the versions (milestones) of a project with status and due dates.',
        inputSchema: versionsInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id } = versionsInput.parse(args);
          const res = await redmine.request<{ versions: unknown[]; total_count?: number }>({
            path: `/projects/${project_id}/versions.json`,
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, versions: res.data.versions };
        },
      },
      {
        name: 'admin_create_version',
        title: 'Create a version',
        description: 'Creates a version (milestone) in a project. Returns the created version.',
        inputSchema: versionCreateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id, ...fields } = versionCreateInput.parse(args);
          const res = await redmine.request<{ version: unknown }>({
            path: `/projects/${project_id}/versions.json`,
            method: 'POST',
            body: { version: dropUndefined({ ...fields }) },
            scopes: WRITE_SCOPES,
          });
          return res.data.version;
        },
      },
      {
        name: 'admin_update_version',
        title: 'Update a version',
        description: 'Updates a version; only the fields passed change.',
        inputSchema: versionUpdateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, ...fields } = versionUpdateInput.parse(args);
          await redmine.request({
            path: `/versions/${id}.json`,
            method: 'PUT',
            body: { version: dropUndefined({ ...fields }) },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'admin_delete_version',
        title: 'Delete a version',
        description: 'Deletes a version. This cannot be undone.',
        inputSchema: versionDeleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = versionDeleteInput.parse(args);
          await redmine.request({ path: `/versions/${id}.json`, method: 'DELETE', scopes: WRITE_SCOPES });
          return { deleted: id };
        },
      },
    ];
  },
};
