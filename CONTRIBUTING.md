# Contributing

## Setup

Node 22.23.4+ (or 24.22.1+ / 26.12.1+) and npm — see `.node-version`.
`npm install`, then `npm test` (builds first via
`pretest`, runs the offline `node:test` suite through `scripts/run-tests.mjs`).

## Conventions

- Mirror the reference layout: one module per tool group exporting a
  `ToolModule`, colocated `*.test.ts`, contracts in `src/contracts.ts`.
- `ToolDeps.auth` stays required; new groups register in `src/server.ts`
  `MODULES` and declare scopes in `src/tools/groups.ts`.
- Tokens and API keys never appear in tool output, logs, or error text. The
  data path refreshes silently and raises `InteractionRequiredError` with the
  flag that names the fix.
- Every user-facing string (instructions, prompts, error headlines) is pinned
  by a test. If you reword one, update its test in the same change.
- Unknown flags and commands are hard errors; add both spellings to
  `src/config.test.ts` when you add an option.

## Live checks

`npm run contract` probes a real Redmine for scope/path drift. It needs
`REDMINE_MCP_URL` plus OAuth credentials or `REDMINE_MCP_API_KEY`, and never
runs in CI without them. `node scripts/smoke.mjs` exercises stdio
initialize → tools/list → session_status against a stub URL.
