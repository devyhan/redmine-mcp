# Troubleshooting

## `Not signed in` on every call

Run `redmine-mcp status` (needs `--redmine-url`). It separates "no session"
from "session cannot refresh" from "Redmine unreachable". Then sign in again:
`login`, or `auth_begin_login` + `auth_login_status` in conversation.

## Browser never opens / loopback timeout

Headless host, firewall, VPN, or a busy port. Preflight says which. Fixes:
free the loopback port, pass `--auth-port` to match the registered redirect,
or sidestep entirely with `login --api-key`.

## `Blocked by a server configuration problem`

- Pre-6.1 Redmine: no OAuth provider exists → `login --api-key`.
- REST API disabled: Administration → Settings → API → Enable.
- Wrong `--client-id`/`--client-secret`, or the redirect URI registered in
  Redmine does not match `http://127.0.0.1:<port>/callback`.

## `Blocked by missing application scopes` / 403

`redmine_list_permissions` shows what this config may ask for. A Redmine admin
widens the OAuth application scopes, then re-run login with just the added
ones.

## `422` with an `errors` array

Redmine rejected an attribute (blank subject, bad date, unknown id). The array
names the field — fix the argument and retry.

## Empty lists that should not be empty

Usually permissions, not bugs: the credential's account cannot see the
objects. Confirm with `users_get_current`, then check project membership and
role permissions in Redmine.

## `stdout` corruption / client shows framing errors

Something wrote to stdout under `serve`. The server logs to stderr only; check
for wrappers or `--verbose` misconfiguration, and never pipe `serve` output
through a pager.

## Cache surgery

`logout` wipes everything. A corrupt `token-cache.enc` is auto-discarded to a
clean re-login. To inspect without secrets: `status` prints paths, never tokens.
