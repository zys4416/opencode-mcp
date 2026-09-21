# OpenCode v2 migration

This fork migrates upstream `b3719c7` (1.2.0) to the pinned OpenCode 2.0.11 protocol. The implementation stays in the existing MCP tool/shared structure.

## Decisions

- Use `@opencode/client@2.0.11`; remove the incompatible `@opencode-ai/sdk` dependency.
- Keep private-process ownership with `serve --stdio`. Parse its `{url}` handshake and verify the authenticated `/api/info` version and PID. No background-service replacement or attachment.
- Prefer `OPENCODE_PASSWORD`, then its legacy alias, otherwise generate a per-instance random password. Store the authenticated client privately, not credentials in tool results.
- Preserve MCP tool names and task/server IDs. Add `agents.available` because native/custom provenance is absent in v2; preserve the old arrays as empty. Follow-up selections persist as native v2 session settings.
- Correlate progress/results to an explicit prompt ID and the following native idle message or a fresh session terminal timestamp. Permission rejection can omit both the idle message and session terminal fields; current-input assistant errors are used once the session is no longer active. Handle all timeline pages, interruption outcomes, pending-input cancellation and concurrent updates.
- Reconcile permission requests using both SSE and polling. Only MCP-owned session trees are auto-answered. Keep external read-only behavior and existing independent deny rules.

## Verification

Baseline: clean `main`, HEAD and fetched `origin/main` both `b3719c7`; original 233 tests passed before migration.

Run the commands in README against the current tree. Unit tests cover native HTTP contracts, identity/authentication, invalid handshakes, timeouts, process errors, cursor loops, task boundaries, ownership and permission reconnects. Coverage thresholds remain 100%.

The integration script uses a real 2.0.11 binary and a local OpenAI-compatible model fixture. It isolates XDG/config state and removes its temporary files. It verifies real task execution and a second authenticated observer; it does not claim visual/manual testing of the TUI or production model/provider behavior.

Validated on 2026-09-21 with Node 24.16.0 and OpenCode 2.0.11:

- After the default-first and automatic-port updates, 191 tests passed across 20 suites; statements, branches, functions and lines all 100%.
- Read-only Biome check and clean TypeScript build passed.
- Real-binary integration passed: correct/missing/wrong Basic auth, port conflicts, model catalog, real write execution, second-client live text events, CLI API observation, external read approval/write rejection, follow-up boundaries, cancellation, permission reconciliation, MCP stdio handshake and child cleanup.
- A packed production installation was also validated outside the source checkout, with module resolution restricted to its release directory. Its configured MCP entry exposed all 9 tools, the automatic-port policy and default-first model guidance.

The default-first follow-up changes MCP instructions and tool descriptions only: new tasks omit model selection, follow-ups retain their current model, and catalog discovery is optional. Explicit overrides remain accepted by the schema. Coverage, lint and build were rerun; the unchanged OpenCode transport did not require another real-binary integration run.

The private-server tool now defaults to `port: 0` when omitted. The OS assigns the listening port and callers use the returned `baseUrl`. Explicit nonzero ports remain strict. The real-binary integration was rerun with the port omitted and passed, including its explicit conflicting-port check.

## Deployment and rollback

Build and validate before switching the host MCP command from the published upstream package to this fork. Use either the source build or the independent production installation described in README. Keep password-variable forwarding when a separate CLI will observe tasks, and reconnect the host after switching entrypoints.

For independently installed versions, retain release directories and switch the `current` link back to a validated previous release to roll back. Keep the package archive and generated lockfile for reinstallation. Updating a source checkout does not change an installed tarball.

Returning to the upstream npm package also requires a compatible OpenCode v1 binary; changing only the entrypoint does not restore v2 compatibility.

The migration does not manage OpenCode's shared service or alter user provider configuration. Private servers use OpenCode's normal session storage. Closing an owned server interrupts its live connections. MCP task IDs are not recoverable after process restart; OpenCode session IDs remain in OpenCode storage.
