# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-10-20

Initial release.

- MCP server over stdio: 9 tool groups, 36 tools (issues, projects, users,
  time, wiki, files, search, queries, admin) plus the generic session tools.
- OAuth2 browser sign-in (authorization code + PKCE on a loopback redirect)
  against Redmine 6.1+ with encrypted local cache and silent refresh.
- API-key binding for pre-6.1 servers.
- In-conversation sign-in (`auth_begin_login`/`auth_login_status`),
  `session_status`, `redmine_list_permissions`, `redmine_request` escape hatch.
- Discovery mode, `--read-only`, `--org-mode`, per-group `--groups`/`--preset`.
- CLI: `serve`, `login`, `logout`, `status`, `permissions`.
