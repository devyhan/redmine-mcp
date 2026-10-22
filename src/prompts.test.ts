import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubRedmine } from './test-support.js';
import { RedmineError } from './contracts.js';
import { TRIAGE_PROMPT, createTriagePromptArgs, triagePrompt } from './prompts.js';
import { fieldCompleter, isCompletable, shapeField } from './tools/completion.js';

describe('triage prompt', () => {
  it('pins the prompt identity', () => {
    assert.equal(TRIAGE_PROMPT.name, 'triage_issue');
    assert.equal(TRIAGE_PROMPT.title, 'Triage an issue');
    assert.match(TRIAGE_PROMPT.description, /project/i);
  });

  it('registers completable project and assignee args', () => {
    const { client } = stubRedmine({});
    const args = createTriagePromptArgs(client);
    assert.equal(isCompletable(shapeField(args, 'project')), true);
    assert.equal(isCompletable(shapeField(args, 'assignee')), true);
  });

  it('answers completions from Redmine through the bound client', async () => {
    const { client } = stubRedmine({
      '/projects.json': { data: { projects: [{ id: 1, identifier: 'demo', name: 'Demo' }] } },
      '/users.json': { data: { users: [{ id: 7, login: 'jdoe', firstname: 'Jane', lastname: 'Doe' }] } },
    });
    const args = createTriagePromptArgs(client);
    const projects = fieldCompleter(shapeField(args, 'project'))!;
    assert.deepEqual(await projects('dem'), ['demo']);
    const assignees = fieldCompleter(shapeField(args, 'assignee'))!;
    assert.deepEqual(await assignees('jdoe'), ['7']);
  });

  it('completes to empty, never errors, when Redmine fails', async () => {
    const { client } = stubRedmine({
      '/projects.json': () => {
        throw new RedmineError({ message: 'boom', status: 500, path: '/projects.json' });
      },
      '/users.json': () => {
        throw new Error('network down');
      },
    });
    const args = createTriagePromptArgs(client);
    assert.deepEqual(await fieldCompleter(shapeField(args, 'project'))!('dem'), []);
    assert.deepEqual(await fieldCompleter(shapeField(args, 'assignee'))!('jdoe'), []);
  });

  it('builds independent completer sets per call', async () => {
    const first = stubRedmine({
      '/projects.json': { data: { projects: [{ id: 1, identifier: 'one', name: 'One' }] } },
    });
    const second = stubRedmine({
      '/projects.json': { data: { projects: [{ id: 2, identifier: 'two', name: 'Two' }] } },
    });
    const completeFirst = fieldCompleter(shapeField(createTriagePromptArgs(first.client), 'project'))!;
    const completeSecond = fieldCompleter(shapeField(createTriagePromptArgs(second.client), 'project'))!;
    assert.deepEqual(await completeFirst(''), ['one']);
    assert.deepEqual(await completeSecond(''), ['two']);
  });

  it('renders the body from its args, bare or filled', () => {
    const bare = triagePrompt({}).messages[0]!.content.text;
    assert.match(bare, /Project: \(ask the user/);
    assert.match(bare, /issues_create/);
    const filled = triagePrompt({ project: 'demo', assignee: 'jdoe' }).messages[0]!.content.text;
    assert.match(filled, /Project: demo/);
    assert.match(filled, /Assignee: jdoe/);
  });
});
