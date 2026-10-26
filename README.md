# redmine-mcp

<!-- mcp-name: io.github.devyhan/redmine-mcp -->

MCP server connecting Redmine to AI assistants: issues, projects, users, time
tracking, wiki, files, search, and saved queries over the Redmine REST API.

Sign-in happens in the system browser via OAuth 2.0 (authorization code +
PKCE, Redmine 6.1+), with an encrypted local token cache and silent refresh.
Pre-6.1 servers use an API-key binding instead.

## Install

```bash
npm install -g @devyhan/redmine-mcp
```

Or run without installing:

```bash
npx -y @devyhan/redmine-mcp --redmine-url https://redmine.example.com
```

Straight from GitHub (tracks the default branch instead of a release):

```bash
npx -y github:devyhan/redmine-mcp --redmine-url https://redmine.example.com
```

Node 22.23.4+, 24.22.1+, or 26.12.1+ required (October 2026 security
floor; Node 20 and below are EOL and unpatched).

## Quick start

1. Register an OAuth2 application in Redmine (Administration → OAuth2
   Applications) with redirect URI `http://127.0.0.1:<port>/callback` and the
   permission scopes you need (see `permissions` below).
2. Sign in once:
   ```bash
   redmine-mcp --redmine-url https://redmine.example.com \
     --client-id <ID> --client-secret <SECRET> login
   ```
   Pre-6.1 servers (or no browser): set `REDMINE_MCP_API_KEY` and skip login
   entirely, or `redmine-mcp --redmine-url … login --api-key <KEY>` once.
3. Add to your MCP client:
   ```json
   {
     "mcpServers": {
       "redmine": {
         "command": "redmine-mcp",
         "args": ["--redmine-url", "https://redmine.example.com"]
       }
     }
   }
   ```
4. In the conversation, call `session_status` first. If no session is signed
   in, call `auth_begin_login`, finish in the browser, then `auth_login_status`.

## Commands

| Command | What it does |
|---|---|
| `serve` (default) | Speak MCP over stdio |
| `login [--scopes a,b] [--full] [--api-key KEY]` | Sign in |
| `logout` | Clear the cached session |
| `status` | Session, reachability, consent checklist |
| `permissions` | Tool groups and the scopes they need |

Every flag has a `REDMINE_MCP_*` environment fallback; flags win. See
`redmine-mcp --help` and [configuration](docs/configuration.md).

## Tools

9 groups, 55 tools (44 in the personal preset; `admin` needs `--org-mode`):

| Group | Tools |
|---|---|
| `issues` | list, get, create, update, add_note, delete, list/create/delete_relation |
| `projects` | list, get, create, update, list_memberships, add/update/remove_member, list_categories |
| `users` | get_current, get, list, update_current |
| `time` | list_entries, log, update_entry, delete_entry, list_activities |
| `wiki` | list_pages, get_page, save_page, delete_page |
| `files` | get_attachment, download, upload, list_project_files, list_documents |
| `search` | query |
| `queries` | list, run |
| `admin` (`--org-mode`) | list_trackers/statuses/priorities/roles/groups/custom_fields/news, list/create/update/delete_version |
| `generic` (always on) | auth_begin_login, auth_login_status, session_status, redmine_list_permissions, redmine_request |

Full reference: [tools](docs/tools.md). Small-context clients: `--discovery`
collapses the catalogue to `discover_tools`/`call_tool` plus the session tools.

## Docs

- [Why redmine-mcp](docs/why.md) · [Auth](docs/auth.md) ·
  [Configuration](docs/configuration.md) · [Tools](docs/tools.md) ·
  [Examples](docs/examples.md) · [Security](docs/security.md) ·
  [Agents](docs/agents.md) · [Troubleshooting](docs/troubleshooting.md)
- [Research report](RESEARCH.md) — reference-repo analysis, OAuth design, API coverage

## Development

```bash
npm install
npm test        # typecheck + node:test suite (offline, stubbed network)
npm run contract  # live drift check against a Redmine (needs REDMINE_MCP_URL + creds)
```

## License

MIT
