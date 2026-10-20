/**
 * The `users` group: the signed-in account plus user lookup.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['users']!;

const READ_SCOPES = [...GROUP.readScopes];

const getInput = z.object({
  id: z.union([z.number().int(), z.string()]).describe('User id, or "current" for the signed-in user.'),
  include: z.array(z.string()).optional().describe('Associated data: memberships, groups.'),
});

const listInput = z.object({
  name: z.string().optional().describe('Substring filter on login, firstname, lastname, or mail.'),
  status: z.number().int().optional().describe('1 active (default), 0 registered, 2 locked, 3 all.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

const updateInput = z.object({
  firstname: z.string().min(1).optional(),
  lastname: z.string().min(1).optional(),
  mail: z.string().optional(),
});

export const usersModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'users_get_current',
        title: 'Get the signed-in user',
        description:
          'Returns the signed-in account (id, login, name, mail, admin flag) from /users/current.json. ' +
          'The live identity check; session_status reports the cached copy.',
        inputSchema: z.object({}),
        includeIdentity: true,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async () => {
          const res = await redmine.request<{ user: unknown }>({
            path: '/users/current.json',
            scopes: READ_SCOPES,
          });
          return res.data.user;
        },
      },
      {
        name: 'users_get',
        title: 'Get a user',
        description: 'Returns one user by id, with optional membership and group data.',
        inputSchema: getInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, include } = getInput.parse(args);
          const res = await redmine.request<{ user: unknown }>({
            path: `/users/${id}.json`,
            query: { include: include?.join(',') },
            scopes: READ_SCOPES,
          });
          return res.data.user;
        },
      },
      {
        name: 'users_list',
        title: 'List users',
        description: 'Lists users, optionally filtered by name substring. Needs view-user rights.',
        inputSchema: listInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = listInput.parse(args);
          const res = await redmine.request<{ users: unknown[]; total_count?: number }>({
            path: '/users.json',
            query: { name: parsed.name, status: parsed.status, limit: parsed.limit, offset: parsed.offset },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, users: res.data.users };
        },
      },
      {
        name: 'users_update_current',
        title: 'Update my account',
        description: 'Updates the signed-in account name or mail address.',
        inputSchema: updateInput,
        write: true,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = updateInput.parse(args);
          await redmine.request({
            path: '/my/account.json',
            method: 'PUT',
            body: { user: { ...parsed } },
            scopes: READ_SCOPES,
          });
          return { updated: 'current' };
        },
      },
    ];
  },
};
