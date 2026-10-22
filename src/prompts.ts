/**
 * Prompts with completable arguments: the live completion path.
 *
 * Tool-argument completers are implemented but wire-dormant (see
 * `src/tools/completion.ts`): the spec routes `completion/complete` only for
 * prompt and resource-template refs, so this prompt's arguments are where the
 * issue completers actually answer on the wire. The args schema is built fresh
 * per call — `withCompleter` stamps non-configurable metadata, so one shared
 * instance would pin every connection to one completer set and its cache.
 */

import { z } from 'zod';

import type { RedmineClient } from './contracts.js';
import { createIssueCompleters, withCompleter } from './tools/completion.js';

/** The triage prompt: file or triage an issue with guided, completing args. */
export const TRIAGE_PROMPT = {
  name: 'triage_issue',
  title: 'Triage an issue',
  description:
    'Guides filing or triaging an issue: pick a project and an optional assignee ' +
    '(both complete from Redmine), then create or retarget the issue.',
} as const;

export interface TriagePromptArgs {
  project?: string | undefined;
  assignee?: string | undefined;
}

/**
 * Builds the prompt's args schema over one completer set bound to `redmine`.
 * The assignee completer reads the sibling `project` argument from the
 * completion context for its membership fallback.
 */
export function createTriagePromptArgs(redmine: RedmineClient) {
  const completers = createIssueCompleters({ redmine });
  return z.object({
    project: withCompleter(
      z.string().describe('Project id or identifier to file or triage in.'),
      completers.completeProject,
    ).optional(),
    assignee: withCompleter(
      z.string().describe('Assignee user id, login, or "Firstname Lastname".'),
      completers.completeAssignee,
    ).optional(),
  });
}

/**
 * The `triage_issue` prompt body: a function of its args, exported so a test
 * can assert on the text. The registerPrompt callback below returns it
 * unchanged.
 */
export function triagePrompt(args: TriagePromptArgs): {
  messages: [{ role: 'user'; content: { type: 'text'; text: string } }];
} {
  const lines = [
    'You are triaging a Redmine issue: confirm the target project, the assignee, and the fields below, then act.',
    `1. Project: ${args.project ?? '(ask the user which project to file in, or list candidates via projects_list)'}. ` +
      'Use the project id or identifier in the call.',
    `2. Assignee: ${args.assignee ?? '(optional — leave unassigned or ask who should own it)'}. ` +
      'Issue tools accept a user id, a login, or "Firstname Lastname" and resolve it before the call.',
    '3. Create with issues_create (subject plus project required), or retarget an existing issue with issues_update.',
  ];
  return { messages: [{ role: 'user', content: { type: 'text', text: lines.join('\n') } }] };
}
