# Security

## Scope

The model must never see a credential. Access tokens, refresh tokens, client
secrets, and API keys are excluded from tool output, error text, logs, and
prompt bodies by construction:

- `session_status` / `auth_login_status` report state, never secrets.
- The `redmine_request` escape hatch refuses `/oauth/*` paths.
- Stack traces go to stderr; only messages go on the wire.

## Storage

- `token-cache.enc` / `identity-cache.enc`: AES-256-GCM, key in `cache.key`
  (32 random bytes), files 0600, directory 0700, atomic tmp+rename writes.
- Default directory: `~/.config/redmine-mcp` (`%APPDATA%\redmine-mcp` on
  Windows), overridable with `--cache-dir`.
- `logout` wipes tokens, identity, and the key. A corrupt cache is discarded
  to a clean re-login, never partially trusted.

## Network

- All Redmine traffic pins the configured host; redirects are refused so a
  redirect can never leak the credential elsewhere.
- The browser flow binds 127.0.0.1 only, uses PKCE S256 with a per-attempt
  verifier, and validates the `state` on return.
- Host pinning also applies to `redmine_request`: absolute URLs are refused.

## Runtime

Supported Node.js versions track the October 2026 security release floor:

- 22.x: >= 22.23.4
- 24.x: >= 24.22.1
- 26.x: >= 26.12.1

Node 20.x and below are end-of-life and receive no security patches —
running this package on them is unsupported. `package.json` `engines`
enforces `>=22.23.4`; the per-major floors above cover the 24.x/26.x
range that a single semver range cannot express.

## Reporting

Open a private security advisory on GitHub. Do not file public issues for
credential-handling bugs.
