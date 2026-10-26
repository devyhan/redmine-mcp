# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-10-26

- Node.js support floor raised to the October 2026 security release:
  22.23.4+, 24.22.1+, or 26.12.1+ (`engines: >=22.23.4`). Node 20.x and
  below are end-of-life, receive no security patches, and are no longer
  supported. If you run Node 20, upgrade Node before updating this package.
- CI now tests the supported floors (22.23.4, 24.22.1) across
  ubuntu/macos/windows; release and contract workflows pin patched versions.
- No code changes: same tools and behavior as 0.4.0.

## [0.4.0] — 2026-10-20

- Structured results: `outputSchema` on issues/projects/access tools returns
  validated `structuredContent`, plus clickable Redmine `resource_link` blocks.
- Name resolution: issue assignee arguments accept display names and logins,
  resolved to ids with precise ambiguous/unknown errors (no data leakage).
- New `triage_issue` prompt with spec-supported argument completion for
  project and assignee. Tool-argument completers ship wire-dormant (spec/SDK
  route completion for prompt/resource refs only) and activate without code
  changes if that ever lands.

## [0.3.0] — 2026-10-20

- Permission-aware catalogue: per-tool `requiresAdmin` gating (`users_list`
  is admin-only and hidden without `--org-mode`), named in
  `redmine_list_permissions` and the `permissions` command.
- New `users_my_access` tool: admin flag, groups, and visible projects with
  roles, so agents scope queries before anything 403s.
- `issues_get` 403s now explain per-object visibility and point at
  `users_my_access` instead of inviting a retry.

## [0.2.0] — 2026-10-20

- First-class API-key fallback: `--api-key` / `REDMINE_MCP_API_KEY` works as
  a direct credential with zero login steps and wins over cached sessions.
  The browser login probes for the OAuth provider first and fails fast with
  the API-key fix on provider-less servers.
- `status` and `session_status` report the credential source
  (`env-key` / `stored-key` / `oauth` / `none`); the key value itself is never
  written to disk, printed, or returned by a tool.

## [0.1.0] — 2026-10-20

Initial release.

- MCP server over stdio: 9 tool groups, 55 tools covering all 21 Redmine
  REST resources (issues, projects, memberships, users, time, news, relations,
  versions, wiki, documents, queries, attachments, enumerations, search, files,
  account) plus the generic session tools.
- OAuth2 browser sign-in (authorization code + PKCE on a loopback redirect)
  against Redmine 6.1+ with encrypted local cache and silent refresh.
- API-key binding for pre-6.1 servers.
- In-conversation sign-in (`auth_begin_login`/`auth_login_status`),
  `session_status`, `redmine_list_permissions`, `redmine_request` escape hatch.
- Discovery mode, `--read-only`, `--org-mode`, per-group `--groups`/`--preset`.
- CLI: `serve`, `login`, `logout`, `status`, `permissions`.
