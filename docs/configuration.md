# Configuration

Every option has a `--flag` and a `REDMINE_MCP_*` environment fallback; flags
win. Unknown flags are hard errors.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--redmine-url` | `REDMINE_MCP_URL` | (required) | Redmine base URL |
| `--client-id` | `REDMINE_MCP_CLIENT_ID` | unset | OAuth2 application ID |
| `--client-secret` | `REDMINE_MCP_CLIENT_SECRET` | unset | OAuth2 application secret |
| `--api-key` | `REDMINE_MCP_API_KEY` | unset | API key: direct credential, no login needed |
| `--groups` | — | personal preset | Enabled tool groups |
| `--preset` | — | `personal` | `personal` or `all` |
| `--read-only` | `REDMINE_MCP_READ_ONLY=1` | off | Suppress write tools |
| `--discovery` | — | off | `discover_tools`/`call_tool` mode |
| `--org-mode` | — | off | Enable the `admin` group |
| `--max-output-chars` | — | 60000 | Tool output budget |
| `--output` | — | `json` | `json` or `toon` |
| `--verbose` | `REDMINE_MCP_VERBOSE=1` | off | Log requests to stderr |
| `--cache-dir` | `REDMINE_MCP_CACHE_DIR` | OS config dir | Token cache directory |
| `--auth-flow` | — | `auto` | `auto`, `browser`, `apikey` |
| `--auth-port` | — | 0 (OS-assigned) | Fixed loopback port |
| `--allow-generic-write` | — | off | Writes via `redmine_request` |

## MCP client JSON

```json
{
  "mcpServers": {
    "redmine": {
      "command": "redmine-mcp",
      "args": ["--redmine-url", "https://redmine.example.com"],
      "env": {
        "REDMINE_MCP_CLIENT_ID": "…",
        "REDMINE_MCP_CLIENT_SECRET": "…"
      }
    }
  }
}
```

Prefer env for the secret so it never appears in a process list. Sign in once
from a terminal (`login`) or from the conversation (`auth_begin_login`).
