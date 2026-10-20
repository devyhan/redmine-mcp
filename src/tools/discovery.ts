/**
 * Discovery mode: collapse the catalogue to `discover_tools`/`call_tool`
 * plus the always-exposed session tools, for clients with small context
 * windows.
 */

import { z } from 'zod';

import type { ServerConfig, ToolDefinition } from '../contracts.js';

const discoverInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('What to look for, e.g. "issues" or "log time". Matched against names, titles, and descriptions.'),
});

const callInput = z.object({
  name: z.string().min(1).describe('Tool name from discover_tools, e.g. "issues_list".'),
  arguments: z.record(z.string(), z.unknown()).default({}).describe('Tool arguments object.'),
});

/**
 * Builds the discovery pair over the full catalogue. Applies `--read-only`
 * itself so `call_tool` can explain a suppressed tool instead of claiming
 * the name is unknown.
 */
export function buildDiscoveryTools(catalogue: ToolDefinition[], config: ServerConfig): ToolDefinition[] {
  const byName = new Map(catalogue.map((tool) => [tool.name, tool]));
  return [
    {
      name: 'discover_tools',
      title: 'Discover tools',
      description:
        'Searches the tool catalogue by keyword. Returns matching tool names, titles, ' +
        'and descriptions; invoke what it names through call_tool.',
      inputSchema: discoverInput,
      scopes: [],
      group: 'generic',
      handler: async (args) => {
        const { query } = discoverInput.parse(args);
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = catalogue.filter((tool) => {
          if (config.readOnly && tool.write === true) return false;
          if (!config.orgMode && tool.requiresAdmin === true) return false;
          const haystack = `${tool.name} ${tool.title} ${tool.description}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        });
        return {
          query,
          matches: matches.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
        };
      },
    },
    {
      name: 'call_tool',
      title: 'Call a discovered tool',
      description:
        'Invokes a tool named by discover_tools with the given arguments object. ' +
        'Refuses unknown names, write tools under --read-only, and admin tools without --org-mode.',
      inputSchema: callInput,
      write: true,
      scopes: [],
      group: 'generic',
      handler: async (args) => {
        const { name, arguments: toolArgs } = callInput.parse(args);
        const target = byName.get(name);
        if (!target) throw new Error(`Unknown tool: ${name}. Call discover_tools to see what exists.`);
        if (config.readOnly && target.write === true) {
          throw new Error(`${name} is a write tool and this server runs --read-only. It exists but will not run.`);
        }
        if (!config.orgMode && target.requiresAdmin === true) {
          throw new Error(
            `${name} needs a Redmine administrator and this server runs without --org-mode. ` +
              'It exists but will not run.',
          );
        }
        return target.handler(toolArgs);
      },
    },
  ];
}
