/**
 * The `time` group: time entries and time-tracking activities.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['time']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

const listInput = z.object({
  issue_id: z.number().int().optional().describe('Issue id to scope the list to.'),
  project_id: z.union([z.number().int(), z.string()]).optional().describe('Project id or identifier.'),
  user_id: z.union([z.number().int(), z.string()]).optional().describe('User id or "me".'),
  from: z.string().optional().describe('Start date YYYY-MM-DD.'),
  to: z.string().optional().describe('End date YYYY-MM-DD.'),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
});

const createInput = z.object({
  issue_id: z.number().int().optional().describe('Issue id (or project_id; one is required).'),
  project_id: z.union([z.number().int(), z.string()]).optional().describe('Project id or identifier.'),
  hours: z.number().positive().describe('Hours spent.'),
  activity_id: z.number().int().optional().describe('Activity id (defaults to the server default).'),
  comments: z.string().optional().describe('Short comment.'),
  spent_on: z.string().optional().describe('Date YYYY-MM-DD (defaults to today).'),
});

const updateInput = z.object({
  id: z.number().int().describe('Time entry id.'),
  hours: z.number().positive().optional(),
  activity_id: z.number().int().optional(),
  comments: z.string().optional(),
  spent_on: z.string().optional(),
});

const deleteInput = z.object({
  id: z.number().int().describe('Time entry id.'),
});

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const timeModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'time_list_entries',
        title: 'List time entries',
        description: 'Lists time entries filtered by issue, project, user, or date range.',
        inputSchema: listInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = listInput.parse(args);
          const res = await redmine.request<{ time_entries: unknown[]; total_count?: number }>({
            path: '/time_entries.json',
            query: {
              issue_id: parsed.issue_id,
              project_id: parsed.project_id,
              user_id: parsed.user_id,
              from: parsed.from,
              to: parsed.to,
              limit: parsed.limit,
              offset: parsed.offset,
            },
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, time_entries: res.data.time_entries };
        },
      },
      {
        name: 'time_log',
        title: 'Log time',
        description: 'Logs time on an issue or a project. Returns the created entry (with its id).',
        inputSchema: createInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = createInput.parse(args);
          if (parsed.issue_id === undefined && parsed.project_id === undefined) {
            throw new Error('Pass issue_id or project_id.');
          }
          const res = await redmine.request<{ time_entry: unknown }>({
            path: '/time_entries.json',
            method: 'POST',
            body: { time_entry: dropUndefined({ ...parsed }) },
            scopes: WRITE_SCOPES,
          });
          return res.data.time_entry;
        },
      },
      {
        name: 'time_update_entry',
        title: 'Update a time entry',
        description: 'Updates a time entry; only the fields passed change.',
        inputSchema: updateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, ...fields } = updateInput.parse(args);
          await redmine.request({
            path: `/time_entries/${id}.json`,
            method: 'PUT',
            body: { time_entry: dropUndefined({ ...fields }) },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'time_delete_entry',
        title: 'Delete a time entry',
        description: 'Deletes a time entry. This cannot be undone.',
        inputSchema: deleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = deleteInput.parse(args);
          await redmine.request({ path: `/time_entries/${id}.json`, method: 'DELETE', scopes: WRITE_SCOPES });
          return { deleted: id };
        },
      },
      {
        name: 'time_list_activities',
        title: 'List time activities',
        description: 'Lists the time-tracking activities (Design, Development, …) with their ids.',
        inputSchema: z.object({}),
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async () => {
          const res = await redmine.request<{ time_entry_activities: unknown[] }>({
            path: '/enumerations/time_entry_activities.json',
            scopes: READ_SCOPES,
          });
          return res.data.time_entry_activities;
        },
      },
    ];
  },
};
