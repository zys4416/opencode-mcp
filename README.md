# opencode-mcp

A stdio MCP server that lets Codex and other MCP hosts drive OpenCode asynchronously.
This is the [zys4416 fork](https://github.com/zys4416/opencode-mcp) of [alejandro-technology/opencode-mcp](https://github.com/alejandro-technology/opencode-mcp), adapted for **OpenCode 2.0.11** using **@opencode/client 2.0.11**.
The preview package version is `2.0.0-dev.0`; these changes are not published through the upstream npm package.
It starts private `opencode serve --stdio` children; it does not manage or attach to the shared background service.

## Requirements

- Node.js **22+** and pnpm (or `npx -y pnpm@10`).
- OpenCode **2.0.11**, with a provider/model configured for normal use.
- `opencode` on PATH, or an absolute path in `OPENCODE_BIN`.

Other binary versions are rejected before startup. The old `@opencode-ai/sdk` (including its `/v2` export) does not implement the OpenCode 2.x API.

## Install this source version

```bash
git clone https://github.com/zys4416/opencode-mcp.git
cd opencode-mcp
pnpm install --frozen-lockfile
pnpm build
```

Point Codex at the local build, rather than the published `npx mcp-server-opencode` package:

```toml
[mcp_servers.opencode]
command = "node"
args = ["/absolute/path/opencode-mcp/build/src/index.js"]
env_vars = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]
startup_timeout_sec = 30
tool_timeout_sec = 360

[mcp_servers.opencode.env]
OPENCODE_BIN = "/absolute/path/to/opencode"
```

The MCP process inherits the host's working directory; it explicitly uses that directory when creating sessions and listing agents/models. A configured MCP `cwd` overrides this. Restart the MCP connection after changing its configuration or build.

## Install independently of the source checkout

After building, package the compiled application and install it with production dependencies
in a separate version directory. Do not use `npm link` or a directory symlink back to the checkout.
The following Linux example keeps both the release and its installation archive:

```bash
shared_dir="$HOME/.local/share/opencode-mcp"
release_tag="2.0.0-dev.0-$(date -u +%Y%m%dT%H%M%SZ)"
artifact_dir="$shared_dir/artifacts/$release_tag"
runtime_dir="$shared_dir/releases/$release_tag"
mkdir -p "$artifact_dir" "$runtime_dir"
npm pack --ignore-scripts --pack-destination "$artifact_dir"
npm install --prefix "$runtime_dir" --omit=dev --ignore-scripts \
  "$artifact_dir/mcp-server-opencode-2.0.0-dev.0.tgz"
```

Keep the generated `package-lock.json` and archive for reproducible reinstallation.
`--ignore-scripts` is intentional: the package is already compiled and does not need its
source build lifecycle or development toolchain on the runtime installation.

Verify the new installation with your MCP host using
`<runtime_dir>/node_modules/mcp-server-opencode/build/src/index.js` before activating it.
Then point `current` to the validated release:

```bash
ln -s "releases/$release_tag" "$shared_dir/.current-$release_tag"
mv -Tf "$shared_dir/.current-$release_tag" "$shared_dir/current"
```

In the Codex configuration above, replace only `args` with the absolute shared entrypoint:

```toml
args = ["/home/YOUR_USER/.local/share/opencode-mcp/current/node_modules/mcp-server-opencode/build/src/index.js"]
```

Keep `cwd` unset to retain the host project's working directory. After reconnecting the MCP
host, the checkout can be deleted; keep the shared installation, Node.js and OpenCode binary.
For upgrades, install and validate a new release directory before switching `current`.
To roll back, switch `current` to a retained previous release and reconnect the host.
Changing only the source checkout does not update an independently installed version.

## Watch a task in the OpenCode CLI

For manual CLI access, set the **same** `OPENCODE_PASSWORD` in the environment that launches Codex and in your viewing terminal. Set it before starting the MCP connection. The legacy `OPENCODE_SERVER_PASSWORD` is also accepted, with `OPENCODE_PASSWORD` taking precedence.

After `opencode_start_server` returns `baseUrl` and `opencode_start_task` returns `session_id`:

```bash
# OPENCODE_PASSWORD must already be set in this terminal.
opencode /absolute/project/path \
  --server http://127.0.0.1:RETURNED_PORT \
  --session RETURNED_SESSION_ID
```

Use `session_id`, not MCP's `task_id`. A plain `opencode` command connects to the default background service, which is a different instance.

If neither password variable is set, MCP generates a random password per private instance. It is never returned in tool results or logged. Set an explicit shared password when CLI viewing is needed. Passwords are passed to the child through its environment; OpenCode's stdio mode removes them from the environment inherited by its tools.

Closing the MCP connection or calling `opencode_stop_server` stops its private server and disconnects CLI viewers. Session data remains in OpenCode's storage; MCP task IDs and their input mappings are in memory and are not restored on restart.

## Tools

| Tool | Behavior |
| --- | --- |
| `opencode_start_server` | Starts a loopback-only private server. Omit `port` or use `port: 0` (default) for an OS-assigned free port. Connect using the returned `baseUrl`. Explicit nonzero ports are used strictly; conflicts fail without attaching to or stopping another service. |
| `opencode_stop_server` | Stops the selected private server. |
| `opencode_list_agents` | Returns agents in `agents.available`, plus enabled models/providers and quota metadata. |
| `opencode_start_task` | Creates a session, admits a prompt, and returns `task_id` and `session_id`. Optional agent/model selection. |
| `opencode_continue_task` | Starts another input in the same idle session. Clears previous cancellation and correlates status to the new input. Running/queued sessions and concurrent updates are rejected. |
| `opencode_cancel_task` | Interrupts execution without resuming it and removes this task's pending input if queued. |
| `opencode_get_task_status` | Returns `pending`, `running`, `completed`, `failed`, `empty`, or `cancelled`; optional progress. |
| `opencode_get_task_result` | Returns the same execution status, latest assistant text (including partial text), and progress for the current input. |
| `opencode_wait_for_task` | Polls multiple tasks using `all`/`any`; completed, failed, empty and cancelled are terminal. |

Model selection is default-first: the MCP instructions tell the host to omit `model` on task creation and follow-ups, and to omit `agent` when no specific agent is needed. OpenCode resolves new-session defaults; follow-ups retain their session model. Explicit model overrides remain available only when the user asks for model selection. This is guidance, not schema enforcement. Model discovery and quota metadata remain available for inspection but no longer drive automatic selection.

Copy agent identifiers from `agents.available[].name` and model identifiers from the provider/model catalog. OpenCode v2 does not expose native/custom agent provenance: the legacy `agents.native` and `agents.custom` arrays remain empty; `agents.available` is authoritative. Hidden agents and disabled models are omitted. Catalogs may initially be empty while OpenCode plugins initialize; retry discovery before choosing a model.

An explicit follow-up agent/model selection changes the session's selection and applies to subsequent follow-ups until changed again. A failed or interrupted HTTP prompt submission may already have been admitted: inspect the returned task/session before retrying. No prompt is automatically retried.

Progress aggregates tool calls and touched files for the **current submitted input**, including all its assistant turns and all message pages. It does not count earlier follow-ups. A running tool's completion does not by itself mark the entire execution complete; completion requires a corresponding v2 idle message or a fresh session terminal timestamp after the input. A stopped execution with a current-input assistant error is failed/cancelled even when v2 omits both session terminal fields and the idle message (as can happen on permission rejection).

## Permissions

`OPENCODE_MCP_EXTERNAL_DIR` accepts `read-only` (default), `allow`, or `deny`. It can also be supplied as `OPENCODE_MCP_EXTERNAL_DIR=<policy>` on the MCP command line; the environment takes precedence.

- Existing OpenCode read/edit/shell deny rules remain enforced by OpenCode.
- Permission requests belonging to MCP-owned sessions and their descendants are automatically answered. Unrelated CLI-created sessions are left alone.
- In `read-only` mode, external-directory requests originating from recognized read tools receive `once`; writes and unidentified operations are rejected. External reads never receive a persistent `always` approval.
- Other permission requests in delegated sessions receive `always`, preserving the original headless delegation policy.
- SSE provides immediate handling; polling reconciles missed requests. Connection failures are surfaced in task status, and polling recovery clears the error.

This is an OpenCode permission policy, not an OS sandbox. Interactive CLI viewing does not disable the responder for MCP-owned tasks.

## Timeouts

`MCP_TOOL_TIMEOUT` sets the maximum `opencode_wait_for_task` timeout in milliseconds (default `300000`). Environment values take precedence over `MCP_TOOL_TIMEOUT=<ms>` arguments. Invalid values use the default.

Private startup has a 30-second handshake deadline, followed by an authenticated health/identity check. Ordinary API requests have a 30-second default timeout; event streams are cancelled when the server is closed. Child output is not forwarded to MCP logs or results.

## Development and validation

```bash
pnpm test               # Unit and HTTP-contract tests
pnpm test:coverage      # 100% statement/branch/function/line thresholds
pnpm lint              # Read-only Biome check
pnpm build             # Clean build and TypeScript checking
OPENCODE_BIN=/absolute/path/to/opencode pnpm test:integration
```

The integration test requires the build and the pinned binary. It creates temporary XDG/config directories, runs a loopback model fixture, and exercises real OpenCode tasks without user credentials or paid model requests. It checks authentication, conflicting ports, catalogs, writes, CLI/API observation, live events, external-directory policy, follow-ups, cancellation, permissions, and child cleanup.

See [migration notes](docs/opencode-v2.md) for implementation boundaries and validation evidence.
