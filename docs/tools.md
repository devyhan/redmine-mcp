# Tools

Wire names are lowercase with underscores. `(W)` mutates and is suppressed
under `--read-only`.

## issues — view_issues (+ add/edit/notes/delete)

- `issues_list` — filter by project, tracker, status (`open`/`closed`/`*`),
  assignee (`me`), saved `query_id`, subject substring; `limit`/`offset`/`sort`/`include`.
- `issues_get` — one issue, optional `include` (journals, attachments, …).
- `issues_create` (W) — `project_id` + `subject` required; trackers, versions,
  dates, estimates, custom fields, watchers optional.
- `issues_update` (W) — partial update; pass `notes` to journal with it.
- `issues_add_note` (W) — journal note only, optionally private.
- `issues_delete` (W) — irreversible.
- `issues_list_relations`, `issues_create_relation` (W), `issues_delete_relation` (W) — blocks/duplicates/precedes links.

## projects — view_project (+ add/edit/members)

- `projects_list`, `projects_get` (id or identifier), `projects_create` (W),
  `projects_update` (W), `projects_list_memberships`, `projects_add_member` (W),
  `projects_update_member` (W), `projects_remove_member` (W), `projects_list_categories`.

## users — view_users

- `users_get_current` — live identity (also carries the session attribution line).
- `users_get` (id or `current`), `users_list` (name/status filter),
  `users_update_current` (W, own firstname/lastname/mail).

## time — view_time_entries (+ log/edit)

- `time_list_entries` (issue/project/user/date filters), `time_log` (W,
  needs `issue_id` or `project_id`), `time_update_entry` (W),
  `time_delete_entry` (W), `time_list_activities`.

## wiki — view_wiki_pages (+ edit/delete)

- `wiki_list_pages`, `wiki_get_page` (optional old `version`),
  `wiki_save_page` (W, creates or versions), `wiki_delete_page` (W).

## files — view_files (+ manage_files)

- `files_get_attachment` (metadata), `files_download` (base64, text decoded
  when textual, size-capped), `files_upload` (W, returns an upload token for
  issue `uploads`), `files_list_project_files`, `files_list_documents` (7.1+).

## search — search_project

- `search_query` — global search across issues, wiki, documents, files, news.

## queries — view_issues + save_queries

- `queries_list`, `queries_run` (issues matching a saved query).

## admin — admin (needs `--org-mode`)

- `admin_list_trackers/statuses/priorities/roles/groups/custom_fields/news`,
  `admin_list_versions`, `admin_create_version` (W), `admin_update_version` (W),
  `admin_delete_version` (W).

## generic (always on)

- `auth_begin_login` / `auth_login_status` — in-conversation browser sign-in.
- `session_status` — call first: account, session health, live reachability,
  consent checklist.
- `redmine_list_permissions` — groups, scopes, what is enabled. First call on 403.
- `redmine_request` — raw path escape hatch. GET by default; writes need
  `--allow-generic-write`; `/oauth/*` and absolute URLs refused.
