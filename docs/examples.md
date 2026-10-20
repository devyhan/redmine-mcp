# Examples

## Morning triage

1. `session_status` — confirm the session.
2. `issues_list` with `{"assigned_to_id": "me", "status_id": "open", "sort": "updated_on:desc"}`.
3. `issues_get` with `{"id": 1234, "include": ["journals", "attachments"]}` for context.
4. `issues_update` with `{"id": 1234, "status_id": 2, "notes": "Picked up."}`.

## Log yesterday's work

1. `time_list_activities` — get the activity id for Development.
2. `time_log` with `{"issue_id": 1234, "hours": 6, "activity_id": 9, "spent_on": "2026-10-19"}`.

## File a bug with a screenshot

1. `files_upload` with `{"filename": "shot.png", "content_base64": "…", "content_type": "image/png"}`.
2. `issues_create` with `{"project_id": "demo", "subject": "Crash on save", "uploads": [{"token": "…", "filename": "shot.png"}]}`.

## Find anything

- `search_query` with `{"q": "deadlock"}` across issues, wiki, files, news.
- `queries_run` with `{"query_id": 5}` for a teammate's saved filter.

## Typed tool missing a field?

`redmine_request` with `{"path": "/issues/1234.json", "method": "PUT", "body": {"issue": {"…"}}}` —
needs `--allow-generic-write` for writes.
