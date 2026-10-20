# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

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
