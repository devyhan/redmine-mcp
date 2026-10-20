# Agents

Notes for AI assistants using this server (human operators: see the other docs).

1. Call `session_status` once first — it answers "who am I, is Redmine up,
   what may I consent to" in one probe.
2. If no session is signed in, call `auth_begin_login` and ask the user to
   finish in the browser; confirm with `auth_login_status`. Never ask for
   credentials, API keys, or authorization codes.
3. Under `--discovery`, find tools with `discover_tools` and run them via
   `call_tool`. Otherwise the full catalogue is listed.
4. On errors, read the `Hint:` / `Blocked-by` lines aloud: they name the fix
   (re-login with scopes, free the loopback port, widen app scopes, check the
   network). Re-running login with only missing scopes prompts only for more.
5. `422` means Redmine rejected an attribute — quote the `errors` array, which
   names the failing field. `404` on an id usually means "invisible to this
   account", not "missing".
6. Quote ids back exactly (numbers stay numbers). `total_count` tells you when
   more pages exist; pass `offset` to walk them.
7. The `agent_start` prompt contains this checklist in compressed form — read
   it at session start.
