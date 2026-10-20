/**
 * The `queries` group: saved issue queries.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['queries']!;

const READ_SCOPES = [...GROUP.readScopes];

const listInput = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

const runInput = z.object({
  query_id: z.number().int().describe('Saved query id.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

export const queriesModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'queries_list',
        title: 'List saved queries',
        description: 'Lists the visible saved issue queries with their filters and columns.',
        inputSchema: listInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = listInput.parse(args);
          const res = await redmine.request<{ queries: unknown[]; total_count?: number }>({
            path: '/queries.json',
            query: { limit: parsed.limit, offset: parsed.offset },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, queries: res.data.queries };
        },
      },
      {
        name: 'queries_run',
        title: 'Run a saved query',
        description: 'Runs a saved issue query and returns the matching issues plus total_count.',
        inputSchema: runInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = runInput.parse(args);
          const res = await redmine.request<{ issues: unknown[]; total_count?: number }>({
            path: '/issues.json',
            query: { query_id: parsed.query_id, limit: parsed.limit, offset: parsed.offset },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, issues: res.data.issues };
        },
      },
    ];
  },
};
