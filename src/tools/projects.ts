/**
 * The `projects` group: list, read, create, update, and manage project
 * memberships.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['projects']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(25).describe('Projects per page (max 100).'),
  offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
  include: z.array(z.string()).optional().describe('Associated data: trackers, issue_categories, enabled_modules, time_entry_activities.'),
});

const listOutput = z.object({
  total_count: z.number().optional(),
  projects: z.array(z.record(z.string(), z.unknown())),
});

const getInput = z.object({
  id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  include: z.array(z.string()).optional().describe('Associated data (see projects_list).'),
});

const createInput = z.object({
  name: z.string().min(1).describe('Project name.'),
  identifier: z.string().min(1).describe('URL-safe identifier.'),
  description: z.string().optional(),
  homepage: z.string().optional(),
  is_public: z.boolean().optional().describe('Public visibility (default true on most servers).'),
  parent_id: z.union([z.number().int(), z.string()]).optional().describe('Parent project id or identifier.'),
  inherit_members: z.boolean().optional(),
  tracker_ids: z.array(z.number().int()).optional(),
  enabled_module_names: z.array(z.string()).optional(),
});

const updateInput = z.object({
  id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  is_public: z.boolean().optional(),
  tracker_ids: z.array(z.number().int()).optional(),
  enabled_module_names: z.array(z.string()).optional(),
});

const membershipsInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

const membershipAddInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  user_id: z.number().int().describe('User id to add.'),
  role_ids: z.array(z.number().int()).min(1).describe('Role ids to grant.'),
});

const membershipUpdateInput = z.object({
  id: z.number().int().describe('Membership id (not a user id).'),
  role_ids: z.array(z.number().int()).min(1).describe('Role ids to set.'),
});

const membershipDeleteInput = z.object({
  id: z.number().int().describe('Membership id (not a user id).'),
});

const categoriesInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
});

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const projectsModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'projects_list',
        title: 'List projects',
        description: 'Lists visible projects. Returns the page plus total_count.',
        inputSchema: listInput,
        outputSchema: listOutput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = listInput.parse(args);
          const res = await redmine.request<{ projects: unknown[]; total_count?: number }>({
            path: '/projects.json',
            query: { limit: parsed.limit, offset: parsed.offset, include: parsed.include?.join(',') },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, projects: res.data.projects };
        },
      },
      {
        name: 'projects_get',
        title: 'Get a project',
        description: 'Returns one project by id or identifier, with optional associated data.',
        inputSchema: getInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, include } = getInput.parse(args);
          const res = await redmine.request<{ project: unknown }>({
            path: `/projects/${id}.json`,
            query: { include: include?.join(',') },
            scopes: READ_SCOPES,
          });
          return res.data.project;
        },
      },
      {
        name: 'projects_create',
        title: 'Create a project',
        description: 'Creates a project. Returns the created project (with its id).',
        inputSchema: createInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = createInput.parse(args);
          const res = await redmine.request<{ project: unknown }>({
            path: '/projects.json',
            method: 'POST',
            body: { project: dropUndefined({ ...parsed }) },
            scopes: WRITE_SCOPES,
          });
          return res.data.project;
        },
      },
      {
        name: 'projects_update',
        title: 'Update a project',
        description: 'Updates project attributes; only the fields passed change.',
        inputSchema: updateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, ...fields } = updateInput.parse(args);
          await redmine.request({
            path: `/projects/${id}.json`,
            method: 'PUT',
            body: { project: dropUndefined({ ...fields }) },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'projects_list_memberships',
        title: 'List project memberships',
        description: 'Lists the members of a project with their roles.',
        inputSchema: membershipsInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = membershipsInput.parse(args);
          const res = await redmine.request<{ memberships: unknown[]; total_count?: number }>({
            path: `/projects/${parsed.project_id}/memberships.json`,
            query: { limit: parsed.limit, offset: parsed.offset },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, memberships: res.data.memberships };
        },
      },
      {
        name: 'projects_add_member',
        title: 'Add a project member',
        description: 'Adds a user to a project with the given roles.',
        inputSchema: membershipAddInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id, user_id, role_ids } = membershipAddInput.parse(args);
          const res = await redmine.request<{ membership: unknown }>({
            path: `/projects/${project_id}/memberships.json`,
            method: 'POST',
            body: { membership: { user_id, role_ids } },
            scopes: WRITE_SCOPES,
          });
          return res.data.membership;
        },
      },
      {
        name: 'projects_update_member',
        title: 'Update a project membership',
        description: 'Sets the roles of a project membership by its membership id.',
        inputSchema: membershipUpdateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, role_ids } = membershipUpdateInput.parse(args);
          await redmine.request({
            path: `/memberships/${id}.json`,
            method: 'PUT',
            body: { membership: { role_ids } },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'projects_remove_member',
        title: 'Remove a project member',
        description: 'Removes a project membership by its membership id.',
        inputSchema: membershipDeleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = membershipDeleteInput.parse(args);
          await redmine.request({ path: `/memberships/${id}.json`, method: 'DELETE', scopes: WRITE_SCOPES });
          return { deleted: id };
        },
      },
      {
        name: 'projects_list_categories',
        title: 'List issue categories',
        description: 'Lists the issue categories of a project with their ids and assignees.',
        inputSchema: categoriesInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id } = categoriesInput.parse(args);
          const res = await redmine.request<{ issue_categories: unknown[] }>({
            path: `/projects/${project_id}/issue_categories.json`,
            scopes: READ_SCOPES,
          });
          return res.data.issue_categories;
        },
      },
    ];
  },
};
