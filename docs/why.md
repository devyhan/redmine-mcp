# Why redmine-mcp

Redmine's REST API is complete but Atlantis-shaped: 21 resources, permission
scopes per call, uploads-before-attach, and (since 6.1) a real OAuth2
provider nobody has wired to an assistant yet.

This server is the typed middle:

- **One sign-in, every tool.** Browser OAuth with PKCE on Redmine 6.1+,
  API-key binding everywhere else, silent refresh on the data path.
- **Typed tools over raw curl.** Filters validated, pages merged, errors
  rendered as `Hint:` lines an agent can act on — with `redmine_request` kept
  as the escape hatch, not the interface.
- **Consent you can audit.** `permissions` and `session_status` print the
  exact scope checklist; `--read-only` and `--org-mode` bound what an agent
  may touch.
- **Mirrored, not invented.** Layout, CLI, cache format, and test style follow
  the sibling `ms-graph-mcp` server, so operators of one already know the other.

See the [research report](../RESEARCH.md) for the reference analysis, the
OAuth design, and the API coverage map.
