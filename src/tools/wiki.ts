/**
 * The `wiki` group: wiki pages per project.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['wiki']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

const listInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
});

const getInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  title: z.string().min(1).describe('Page title.'),
  version: z.number().int().optional().describe('Old version number to fetch.'),
});

const upsertInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  title: z.string().min(1).describe('Page title.'),
  text: z.string().describe('Page body (Textile by default).'),
  comments: z.string().optional().describe('Version comment.'),
});

const deleteInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
  title: z.string().min(1).describe('Page title.'),
});

export const wikiModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'wiki_list_pages',
        title: 'List wiki pages',
        description: 'Lists the wiki page index of a project.',
        inputSchema: listInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id } = listInput.parse(args);
          const res = await redmine.request<{ wiki_pages: unknown[] }>({
            path: `/projects/${project_id}/wiki/index.json`,
            scopes: READ_SCOPES,
          });
          return res.data.wiki_pages;
        },
      },
      {
        name: 'wiki_get_page',
        title: 'Get a wiki page',
        description: 'Returns one wiki page with its text and attachments.',
        inputSchema: getInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id, title, version } = getInput.parse(args);
          const res = await redmine.request<{ wiki_page: unknown }>({
            path: `/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`,
            query: { version },
            scopes: READ_SCOPES,
          });
          return res.data.wiki_page;
        },
      },
      {
        name: 'wiki_save_page',
        title: 'Create or update a wiki page',
        description: 'Creates the page when it does not exist, otherwise saves a new version.',
        inputSchema: upsertInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id, title, text, comments } = upsertInput.parse(args);
          await redmine.request({
            path: `/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`,
            method: 'PUT',
            body: { wiki_page: { text, comments } },
            scopes: WRITE_SCOPES,
          });
          return { saved: title };
        },
      },
      {
        name: 'wiki_delete_page',
        title: 'Delete a wiki page',
        description: 'Deletes a wiki page. This cannot be undone.',
        inputSchema: deleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id, title } = deleteInput.parse(args);
          await redmine.request({
            path: `/projects/${project_id}/wiki/${encodeURIComponent(title)}.json`,
            method: 'DELETE',
            scopes: WRITE_SCOPES,
          });
          return { deleted: title };
        },
      },
    ];
  },
};
