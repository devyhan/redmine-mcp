/**
 * The `search` group: global search.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['search']!;

const READ_SCOPES = [...GROUP.readScopes];

const searchInput = z.object({
  q: z.string().min(1).describe('Search terms.'),
  scope: z.string().optional().describe('Project identifier to scope the search to ("all" for global).'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

export const searchModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'search_query',
        title: 'Global search',
        description:
          'Searches across issues, wiki pages, documents, files, and news. ' +
          'Returns ranked results with type, title, and excerpt.',
        inputSchema: searchInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = searchInput.parse(args);
          const res = await redmine.request<{ results: unknown[]; total_count?: number }>({
            path: '/search.json',
            query: { q: parsed.q, scope: parsed.scope, limit: parsed.limit, offset: parsed.offset },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, results: res.data.results };
        },
      },
    ];
  },
};
