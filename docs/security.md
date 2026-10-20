# Security (operator notes)

Companion to the root [SECURITY.md](../SECURITY.md): what to configure, not
what the code does.

- **REST API** must be on (Administration → Settings → API) or every call
  fails closed with a sign-in message, never a silent empty list.
- **OAuth application scopes** are the consent boundary. Grant the least
  permissions the agents need (`permissions` lists them per group); widen only
  after a `redmine_list_permissions`-confirmed 403.
- **`--read-only`** for triage bots: every `(W)` tool disappears from the
  catalogue, including the generic write hatch.
- **`redmine_request`** stays GET-only unless `--allow-generic-write` is set.
  Prefer typed tools: they validate, page, and explain errors.
- **Cache dir** on shared hosts: pass `--cache-dir` to a user-private path
  (0700). `logout` wipes tokens, identity, and the key.
- **Admin group** (`--org-mode`) exposes enumerations plus version creation.
  Most deployments should leave it off.
