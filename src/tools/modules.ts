/**
 * The domain module registry, keyed by group name.
 *
 * Lives apart from `server.ts` so the permission catalogue (`generic.ts`)
 * can enumerate per-tool metadata without importing the server assembly
 * (which would be a dependency cycle). The generic module is deliberately
 * absent: it is appended unconditionally by `collectTools`, never selected.
 */

import type { ToolModule } from '../contracts.js';
import { adminModule } from './admin.js';
import { filesModule } from './files.js';
import { issuesModule } from './issues.js';
import { projectsModule } from './projects.js';
import { queriesModule } from './queries.js';
import { searchModule } from './search.js';
import { timeModule } from './time.js';
import { usersModule } from './users.js';
import { wikiModule } from './wiki.js';

/** Every domain module, keyed by the group name it owns. */
export const DOMAIN_MODULES: Record<string, ToolModule> = {
  issues: issuesModule,
  projects: projectsModule,
  users: usersModule,
  time: timeModule,
  wiki: wikiModule,
  files: filesModule,
  search: searchModule,
  queries: queriesModule,
  admin: adminModule,
};
