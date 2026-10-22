/**
 * The `issues` group: read, search, create, update, and annotate issues.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { RedmineError } from '../contracts.js';
import { createIssueCompleters, withCompleter, type IssueCompleters } from './completion.js';
import { resolveAssignee } from './resolve.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['issues']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

/**
 * Built fresh per `build()` call: `withCompleter` stamps metadata onto the
 * schema objects (non-configurable, like the SDK helper), so sharing one
 * instance across builds would pin every connection to one completer set.
 */
function createListInput(completers: IssueCompleters) {
  return z.object({
    project_id: withCompleter(
      z.union([z.number().int(), z.string()]).describe('Project id or identifier to scope the list to.'),
      completers.completeProject,
    ).optional(),
    tracker_id: withCompleter(
      z.number().int().describe('Tracker id to filter by.'),
      completers.completeTracker,
    ).optional(),
    status_id: withCompleter(
      z.union([z.number().int(), z.string()]).describe('Status id, name, "open", "closed", or "*".'),
      completers.completeStatus,
    ).optional(),
    assigned_to_id: withCompleter(
      z
        .union([z.number().int(), z.string()])
        .describe('Assignee id, "me", or display name/login (resolved to an id before the call).'),
      completers.completeAssignee,
    ).optional(),
    query_id: z.number().int().optional().describe('Saved query id to run.'),
    subject: z.string().optional().describe('Substring filter on the subject, applied client-side after the page is fetched.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Issues per page (max 100).'),
    offset: z.number().int().min(0).default(0).describe('Pagination offset.'),
    include: z.array(z.string()).optional().describe('Associated data: children, attachments, relations, changesets, journals, watchers.'),
    sort: z.string().optional().describe('Sort column and direction, e.g. "updated_on:desc".'),
  });
}

const listOutput = z.object({
  total_count: z.number().optional(),
  issues: z.array(z.record(z.string(), z.unknown())),
});

/** Loose by design: issues carry custom fields no schema can enumerate. */
const issueOutput = z.record(z.string(), z.unknown());

const getInput = z.object({
  id: z.number().int().describe('Issue id.'),
  include: z.array(z.string()).optional().describe('Associated data to include (see issues_list).'),
});

const customFieldInput = z.object({
  id: z.number().int().describe('Custom field id.'),
  value: z.union([z.string(), z.array(z.string())]).describe('Value (array for multiselect fields).'),
});

const uploadInput = z.object({
  token: z.string().min(1).describe('Upload token from files_upload.'),
  filename: z.string().min(1).describe('Filename stored on the issue.'),
  content_type: z.string().optional().describe('MIME type (informational; 7.1+ detects from contents).'),
  description: z.string().optional(),
});

function createCreateInput(completers: IssueCompleters) {
  return z.object({
    project_id: withCompleter(
      z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
      completers.completeProject,
    ),
    tracker_id: withCompleter(
      z.number().int().describe('Tracker id (defaults to the project default).'),
      completers.completeTracker,
    ).optional(),
    subject: z.string().min(1).describe('Subject.'),
    description: z.string().optional().describe('Description (Textile by default).'),
    status_id: withCompleter(z.number().int().describe('Status id.'), completers.completeStatus).optional(),
    priority_id: z.number().int().optional().describe('Priority id.'),
    assigned_to_id: withCompleter(
      z
        .union([z.number().int(), z.string()])
        .describe('Assignee user id, login, or "Firstname Lastname" (resolved to an id before the call).'),
      completers.completeAssignee,
    ).optional(),
    category_id: z.number().int().optional().describe('Category id.'),
    fixed_version_id: z.number().int().optional().describe('Target version id.'),
    parent_issue_id: z.number().int().optional().describe('Parent issue id for subtasks.'),
    start_date: z.string().optional().describe('YYYY-MM-DD.'),
    due_date: z.string().optional().describe('YYYY-MM-DD.'),
    estimated_hours: z.number().optional().describe('Estimated hours.'),
    done_ratio: z.number().int().min(0).max(100).optional().describe('Done %.'),
    custom_fields: z.array(customFieldInput).optional().describe('Custom field values.'),
    watcher_user_ids: z.array(z.number().int()).optional().describe('Watcher user ids.'),
    uploads: z.array(uploadInput).optional().describe('Tokens from files_upload to attach on creation.'),
  });
}

function createUpdateInput(completers: IssueCompleters) {
  return z.object({
    id: z.number().int().describe('Issue id.'),
    subject: z.string().min(1).optional(),
    description: z.string().optional(),
    status_id: withCompleter(z.number().int(), completers.completeStatus).optional(),
    priority_id: z.number().int().optional(),
    assigned_to_id: withCompleter(
      z.union([z.number().int(), z.string()]),
      completers.completeAssignee,
    ).optional(),
    category_id: z.number().int().optional(),
    fixed_version_id: z.number().int().optional(),
    parent_issue_id: z.number().int().optional(),
    start_date: z.string().optional(),
    due_date: z.string().optional(),
    estimated_hours: z.number().optional(),
    done_ratio: z.number().int().min(0).max(100).optional(),
    custom_fields: z.array(customFieldInput).optional(),
    uploads: z.array(uploadInput).optional().describe('Tokens from files_upload to attach with the update.'),
    notes: z.string().optional().describe('Journal note appended with the update.'),
    private_notes: z.boolean().optional().describe('Mark the appended note private.'),
  });
}

const noteInput = z.object({
  id: z.number().int().describe('Issue id.'),
  notes: z.string().min(1).describe('Journal note.'),
  private_notes: z.boolean().optional().describe('Mark the note private.'),
});

const deleteInput = z.object({
  id: z.number().int().describe('Issue id.'),
});

const relationsListInput = z.object({
  issue_id: z.number().int().describe('Issue id.'),
});

const relationCreateInput = z.object({
  issue_id: z.number().int().describe('Issue id owning the relation.'),
  issue_to_id: z.number().int().describe('Related issue id.'),
  relation_type: z
    .enum(['relates', 'duplicates', 'duplicated', 'blocks', 'blocked', 'precedes', 'follows', 'copied_to', 'copied_from'])
    .default('relates')
    .describe('Relation type.'),
  delay: z.number().int().optional().describe('Delay in days (precedes/follows only).'),
});

const relationDeleteInput = z.object({
  id: z.number().int().describe('Relation id (not an issue id).'),
});

function dropUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const issuesModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    const completers = createIssueCompleters({ redmine });
    const listInput = createListInput(completers);
    const createInput = createCreateInput(completers);
    const updateInput = createUpdateInput(completers);
    return [
      {
        name: 'issues_list',
        title: 'List issues',
        description:
          'Lists issues with Redmine filters (project, tracker, status, assignee, saved query). ' +
          'Returns the page plus total_count; pass offset to walk further pages.',
        inputSchema: listInput,
        outputSchema: listOutput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = listInput.parse(args);
          // Redmine filters take ids (or `me`) only; a display name or login
          // is resolved first, scoped to the listed project when one is set.
          const assignedTo =
            parsed.assigned_to_id === undefined
              ? undefined
              : await resolveAssignee(redmine, parsed.assigned_to_id, {
                  allowMe: true,
                  project: parsed.project_id,
                });
          const res = await redmine.request<{ issues: { subject?: string }[]; total_count?: number }>({
            path: '/issues.json',
            query: {
              project_id: parsed.project_id,
              tracker_id: parsed.tracker_id,
              status_id: parsed.status_id,
              assigned_to_id: assignedTo,
              query_id: parsed.query_id,
              limit: parsed.limit,
              offset: parsed.offset,
              include: parsed.include?.join(','),
              sort: parsed.sort,
            },
            scopes: READ_SCOPES,
          });
          // Redmine offers no server-side subject filter on this endpoint, so
          // the substring match runs here, on the fetched page only.
          const needle = parsed.subject?.toLowerCase();
          const issues =
            needle === undefined
              ? res.data.issues
              : res.data.issues.filter((issue) => (issue.subject ?? '').toLowerCase().includes(needle));
          return { total_count: res.totalCount, issues };
        },
      },
      {
        name: 'issues_get',
        title: 'Get an issue',
        description:
          'Returns one issue by id, with optional associated data via include. ' +
          'A 403 means the issue sits in a project you cannot see or is private to someone else — ' +
          'call users_my_access to list what is visible instead of retrying the id.',
        inputSchema: getInput,
        outputSchema: issueOutput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, include } = getInput.parse(args);
          try {
            const res = await redmine.request<{ issue: unknown }>({
              path: `/issues/${id}.json`,
              query: { include: include?.join(',') },
              scopes: READ_SCOPES,
            });
            return res.data.issue;
          } catch (error) {
            if (error instanceof RedmineError && error.status === 403) {
              throw new RedmineError({
                message: error.message,
                status: error.status,
                path: error.path,
                hint:
                  'Issue visibility is per-object: this issue is in a project outside your membership ' +
                  'or marked private. Retrying the id cannot help — call users_my_access to see which ' +
                  'projects and roles your account reaches, then query within those.',
              });
            }
            throw error;
          }
        },
      },
      {
        name: 'issues_create',
        title: 'Create an issue',
        description: 'Creates an issue in a project. Returns the created issue (with its id).',
        inputSchema: createInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const parsed = createInput.parse(args);
          // Creation needs the target project anyway, so its memberships are
          // the non-admin fallback when the user index refuses.
          const assignedTo =
            parsed.assigned_to_id === undefined
              ? undefined
              : await resolveAssignee(redmine, parsed.assigned_to_id, { project: parsed.project_id });
          const res = await redmine.request<{ issue: unknown }>({
            path: '/issues.json',
            method: 'POST',
            body: { issue: dropUndefined({ ...parsed, assigned_to_id: assignedTo }) },
            scopes: WRITE_SCOPES,
          });
          return res.data.issue;
        },
      },
      {
        name: 'issues_update',
        title: 'Update an issue',
        description:
          'Updates issue attributes; only the fields passed change. Pass notes to ' +
          'append a journal entry with the update.',
        inputSchema: updateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, ...fields } = updateInput.parse(args);
          // Updates carry no project argument, so a non-admin resolving a
          // name here needs the user index to answer — else a numeric id.
          const assignedTo =
            fields.assigned_to_id === undefined
              ? undefined
              : await resolveAssignee(redmine, fields.assigned_to_id);
          await redmine.request({
            path: `/issues/${id}.json`,
            method: 'PUT',
            body: { issue: dropUndefined({ ...fields, assigned_to_id: assignedTo }) },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'issues_add_note',
        title: 'Add an issue note',
        description: 'Appends a journal note to an issue without changing anything else.',
        inputSchema: noteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, notes, private_notes } = noteInput.parse(args);
          await redmine.request({
            path: `/issues/${id}.json`,
            method: 'PUT',
            body: { issue: dropUndefined({ notes, private_notes }) },
            scopes: WRITE_SCOPES,
          });
          return { updated: id };
        },
      },
      {
        name: 'issues_delete',
        title: 'Delete an issue',
        description: 'Deletes an issue. This cannot be undone.',
        inputSchema: deleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = deleteInput.parse(args);
          await redmine.request({ path: `/issues/${id}.json`, method: 'DELETE', scopes: WRITE_SCOPES });
          return { deleted: id };
        },
      },
      {
        name: 'issues_list_relations',
        title: 'List issue relations',
        description: 'Lists the relations (blocks, duplicates, …) of an issue.',
        inputSchema: relationsListInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { issue_id } = relationsListInput.parse(args);
          const res = await redmine.request<{ relations: unknown[] }>({
            path: `/issues/${issue_id}/relations.json`,
            scopes: READ_SCOPES,
          });
          return res.data.relations;
        },
      },
      {
        name: 'issues_create_relation',
        title: 'Create an issue relation',
        description: 'Links two issues (relates, blocks, duplicates, precedes, …).',
        inputSchema: relationCreateInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { issue_id, ...fields } = relationCreateInput.parse(args);
          const res = await redmine.request<{ relation: unknown }>({
            path: `/issues/${issue_id}/relations.json`,
            method: 'POST',
            body: { relation: dropUndefined({ ...fields }) },
            scopes: WRITE_SCOPES,
          });
          return res.data.relation;
        },
      },
      {
        name: 'issues_delete_relation',
        title: 'Delete an issue relation',
        description: 'Removes an issue relation by its relation id.',
        inputSchema: relationDeleteInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = relationDeleteInput.parse(args);
          await redmine.request({ path: `/relations/${id}.json`, method: 'DELETE', scopes: WRITE_SCOPES });
          return { deleted: id };
        },
      },
    ];
  },
};
