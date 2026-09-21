# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before `1.2.0` predate this file and are not documented here.

## [Unreleased]

OpenCode v2 preview (`2.0.0-dev.0`) in the [zys4416 fork](https://github.com/zys4416/opencode-mcp).
The upstream npm package is not updated by this fork.

### Changed

- Target **OpenCode 2.0.11** with `@opencode/client@2.0.11`; require Node.js 22+.
  Other binary versions are rejected before starting a child process.
- Start private `opencode serve --stdio` instances using the JSON startup handshake,
  authenticated health/PID checks, and one shared authenticated client per instance.
- Allocate a free port by default (`port: 0`). Explicit nonzero ports remain strict;
  a conflict does not attach to or stop an existing service.
- Prefer OpenCode's configured model. Instructions and tool descriptions tell the
  host to omit `model` unless the user requests model selection. Discovery is optional;
  quota metadata no longer drives automatic overrides. The parameter remains available.
- Migrate task submission, model/agent selection, cancellation, message pagination,
  permission events and replies to the native v2 API.

### Fixed

- Prevent follow-ups from reporting an earlier input's completed result. Correlate
  each input with its own messages and execution outcome; reset cancellation on continuation.
- Recognize permission-rejected executions that omit session terminal fields and
  idle messages, once the execution is inactive and the current input has an assistant error.
- Treat `empty` and `cancelled` as terminal in multi-task waits. Interrupt without
  resuming queued work and remove only the task's own pending input.
- Reconcile missed permission events through polling, expose responder failures,
  and avoid auto-approving unrelated CLI sessions. Preserve external read-only decisions.
- Reject concurrent updates to the same task and clean up failed or stopped private servers.

### Added

- Shared-password CLI observation through `OPENCODE_PASSWORD` (legacy alias:
  `OPENCODE_SERVER_PASSWORD`), or private random credentials when neither is set.
  Credentials are not returned in tool results or forwarded in child logs.
- `OPENCODE_BIN` for selecting the local OpenCode executable.
- Independent installation instructions using a tarball, production dependencies,
  version directories and a `current` link; the source checkout is not needed at runtime.
- Native-client HTTP-contract tests and an isolated real-binary integration test
  using a loopback model fixture, including live events and CLI observation.

### Compatibility notes

- `agents.available` is authoritative. v2 does not expose native/custom provenance,
  so the retained `agents.native` and `agents.custom` arrays are empty.
- Progress is scoped to the current input and all its assistant turns, rather than
  all previous follow-ups. Result retrieval can include partial text and uses the
  same status snapshot as status polling; terminal diagnostics use `error`.
- Explicit model/agent changes on continuation persist as session settings.
- Only private `serve` instances are supported; shared background-service attachment
  and MCP task-ID recovery after restart are not implemented.
- Reconnect the MCP host after changing its installation. Existing sessions with an
  explicit model selection are not automatically reset by the default-first policy.

## [1.2.0] — 2026-08-28

Delegated tasks could hang forever, or report `completed` after doing nothing.
Both are fixed, and the result payload now carries evidence of what a task
actually did. See `docs/incident-2026-08-21-silent-noop-tasks.md` for the full
report this release closes out.

### Behavior changes callers must handle

- `opencode_get_task_status` and `opencode_get_task_result` can now return two
  new statuses: **`empty`** and **`cancelled`**. Both were previously reported
  as `completed`. Code that switches exhaustively on task status needs a branch
  for them; code that only special-cases `completed` will now correctly stop
  treating a no-op or an aborted task as a success.
- `opencode_get_task_result` now includes a `progress` object. Previously it
  returned only `status` and `result`.
- `opencode_start_server` now reports its permission posture under
  `permissions` (`{ external_directory, auto_approved }`).

### Added

- **Permission responder for headless servers.** A headless `opencode serve`
  has no interactive approver, so any permission resolved to `ask` blocked the
  agent forever — the session stayed genuinely busy and the task neither
  completed nor failed. `opencode_start_server` now passes a permission config
  to the OpenCode server *and* subscribes to its event stream to answer every
  request.
- **`OPENCODE_MCP_EXTERNAL_DIR`** selects how the delegated agent may touch
  paths outside the directory the server was launched in. Precedence: env var >
  `OPENCODE_MCP_EXTERNAL_DIR=<policy>` CLI arg > default.
  - `read-only` (default) — reads outside the cwd are approved, writes rejected.
  - `allow` — no boundary.
  - `deny` — nothing outside the cwd is reachable.

  Inside the cwd everything is auto-approved; the caller already owns that
  directory. The config is deep-merged per permission key, so existing
  `read` / `edit` / `bash` deny globs (secrets, keys, `.env`) survive untouched.
- **Side-effect evidence in `TaskProgress`**: `mutating_tool_calls` and
  `files_touched`, collected across every assistant turn in the session.
  `completed` with an empty `files_touched` on a task whose whole purpose was
  writing files is the signal that catches a silent no-op.
- **Per-model quota annotations.** `opencode_list_agents` now returns each model
  as `{ id, quota }` with a `per_5h` estimate and a tier (`high-volume`,
  `balanced`, `scarce`), scraped from the OpenCode Go docs and cached on disk
  for 24h. A sibling `models.quota_snapshot` distinguishes "this model has no
  quota row" from "we never got the table". Overridable with
  `OPENCODE_MCP_CACHE_DIR` and `OPENCODE_MCP_LIMITS_TTL_MS`; a failed fetch
  falls back to the stale snapshot, so startup never depends on the network.

### Fixed

- **Tasks no longer hang on a permission prompt.** Previously, any task reading
  or writing a path outside the server cwd wedged indefinitely with no way for a
  caller to tell "working" from "stuck".
- **`completed` is now a work check, not a timestamp check.** An assistant turn
  that ended with no text and no tool calls reports `empty` instead of
  `completed` with an empty result. A completed timestamp says the turn ended,
  not that it did anything.
- **Evidence is collected across the whole session, not just the last turn.** An
  agent's edits land in earlier turns while the final turn is usually just
  "DONE", so reading evidence off the last message alone reported
  `files_touched: []` for a task that had rewritten the workspace.
- **Cancelled tasks report `cancelled`.** `opencode_cancel_task` now records the
  cancellation, and status derivation checks it first. An aborted session keeps
  its completed timestamp, so a deliberately killed task was previously
  indistinguishable from one that finished on its own. A cancelled task still
  returns whatever it produced before the abort, `files_touched` included.
- **The stall guard covers the empty-turn case.** `PENDING_STALL_MS` was only
  reachable when no assistant message existed at all; once any message existed —
  including an empty or aborted one — the guard was bypassed permanently.

### Notes for contributors

- The generated `@opencode-ai/sdk` types lag the running binary. Verified
  against opencode `1.18.18` with SDK `1.17.20`: the live permission event is
  `permission.asked` (the SDK declares only `permission.updated`), its kind
  arrives as `properties.permission` (the SDK says `type`), and the call id is
  nested under `properties.tool.callID` (the SDK puts it at the top level).
  Verify wire shapes against a live server before trusting a generated type — a
  mismatch here fails silently, because a permission that is never answered just
  hangs.
- Two bugs in this release passed a green unit suite and were caught only by
  running against a live server. Mocks reproduce the contract you believe in,
  not the one the system implements.

### Not addressed

- **F3** from the incident report: there is still no staleness signal on the
  `running` path. `buildProgress` reports `current_tool` and
  `current_tool_status` but no timing, so a caller has no field to compare
  across polls to tell a slow task from a wedged one.
