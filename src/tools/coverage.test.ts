import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stubAuth, stubRedmine, testConfig } from '../test-support.js';
import { adminModule } from './admin.js';
import { filesModule } from './files.js';
import { issuesModule } from './issues.js';
import { projectsModule } from './projects.js';

function build(module: { build: (deps: never) => { name: string; handler: (args: never) => Promise<unknown> }[] }, paths: Record<string, { data: unknown; totalCount?: number }>) {
  const config = testConfig({ groups: ['issues'] });
  const { client, seen } = stubRedmine(paths);
  const tools = module.build({ redmine: client, config, auth: stubAuth(), consentScopes: () => [] } as never);
  return { tools, seen };
}

describe('extended coverage tools', () => {
  it('manages issue relations', async () => {
    const { tools, seen } = build(issuesModule, {
      '/issues/1/relations.json': { data: { relations: [{ id: 5 }] } },
      '/relations/5.json': { data: {} },
    });
    const list = tools.find((tool) => tool.name === 'issues_list_relations')!;
    assert.deepEqual(await list.handler({ issue_id: 1 } as never), [{ id: 5 }]);
    const create = tools.find((tool) => tool.name === 'issues_create_relation')!;
    await create.handler({ issue_id: 1, issue_to_id: 2, relation_type: 'blocks' } as never);
    assert.equal(seen[1]!.method, 'POST');
    assert.deepEqual(seen[1]!.body, { relation: { issue_to_id: 2, relation_type: 'blocks' } });
    const remove = tools.find((tool) => tool.name === 'issues_delete_relation')!;
    assert.deepEqual(await remove.handler({ id: 5 } as never), { deleted: 5 });
  });

  it('manages memberships and lists categories', async () => {
    const { tools, seen } = build(projectsModule, {
      '/memberships/3.json': { data: {} },
      '/projects/demo/issue_categories.json': { data: { issue_categories: [{ id: 1 }] } },
    });
    const update = tools.find((tool) => tool.name === 'projects_update_member')!;
    assert.deepEqual(await update.handler({ id: 3, role_ids: [4] } as never), { updated: 3 });
    assert.equal(seen[0]!.method, 'PUT');
    const remove = tools.find((tool) => tool.name === 'projects_remove_member')!;
    await remove.handler({ id: 3 } as never);
    assert.equal(seen[1]!.method, 'DELETE');
    const categories = tools.find((tool) => tool.name === 'projects_list_categories')!;
    assert.deepEqual(await categories.handler({ project_id: 'demo' } as never), [{ id: 1 }]);
  });

  it('lists project files and documents', async () => {
    const { tools } = build(filesModule, {
      '/projects/demo/files.json': { data: { files: [{ id: 1 }], total_count: 1 }, totalCount: 1 },
      '/projects/demo/documents.json': { data: { documents: [{ id: 2 }], total_count: 1 }, totalCount: 1 },
    });
    const files = tools.find((tool) => tool.name === 'files_list_project_files')!;
    assert.deepEqual(await files.handler({ project_id: 'demo' } as never), { total_count: 1, files: [{ id: 1 }] });
    const documents = tools.find((tool) => tool.name === 'files_list_documents')!;
    assert.deepEqual(await documents.handler({ project_id: 'demo' } as never), {
      total_count: 1,
      documents: [{ id: 2 }],
    });
  });

  it('updates and deletes versions', async () => {
    const { tools, seen } = build(adminModule, { '/versions/9.json': { data: {} } });
    const update = tools.find((tool) => tool.name === 'admin_update_version')!;
    assert.deepEqual(await update.handler({ id: 9, status: 'closed' } as never), { updated: 9 });
    assert.equal(seen[0]!.method, 'PUT');
    assert.deepEqual(seen[0]!.body, { version: { status: 'closed' } });
    const remove = tools.find((tool) => tool.name === 'admin_delete_version')!;
    assert.deepEqual(await remove.handler({ id: 9 } as never), { deleted: 9 });
  });
});
