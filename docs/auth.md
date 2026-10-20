# Auth

Two credential kinds, one session cache.

## OAuth2 browser flow (Redmine 6.1+)

Redmine 6.1+ ships a Doorkeeper OAuth2 provider: authorization-code grants
only, refresh tokens on, scopes are Redmine permission names plus `admin`.

1. Register the application once in Redmine: Administration → OAuth2
   Applications → New. Redirect URI: `http://127.0.0.1:<port>/callback`
   (any free port; match `--auth-port` when fixed, else leave the OS to pick).
   Grant the permission scopes from `redmine-mcp permissions`.
2. Sign in:
   ```bash
   redmine-mcp --redmine-url https://redmine.example.com \
     --client-id ID --client-secret SECRET login
   ```
   The system browser opens; the loopback listener catches the redirect.
3. From inside a conversation: `auth_begin_login` (returns immediately),
   finish in the browser, then `auth_login_status`.

The token exchange sends the confidential client secret **and** a PKCE S256
verifier, so it works whether or not the server enforces PKCE. Data calls
refresh silently; failures become classified sign-in guidance, never a
browser popup mid-call.

Requirements on the server: REST API enabled (Administration → Settings →
API), OAuth2 Applications visible to an admin.

## API-key binding (any Redmine with REST enabled)

```bash
redmine-mcp --redmine-url https://redmine.example.com login --api-key <KEY>
```

The key is verified once against `GET /users/current.json` and stored
encrypted like a token. Find it on your account page (`/my/account`). Use
this for pre-6.1 servers, EasyRedmine, or headless hosts.

## Flows

`--auth-flow auto` (default) tries the browser and falls back to API-key
guidance when there is no browser, no loopback port, or no OAuth provider.
`browser` forces the browser; `apikey` prints the terminal command (the key
itself can only be passed on the CLI, never in conversation).

## Cache

`token-cache.enc` + `identity-cache.enc` + `cache.key` under
`~/.config/redmine-mcp` (AES-256-GCM, 0600/0700). `logout` wipes everything.
`status` reports account, session health, reachability, and the consent
checklist without ever printing a secret.
