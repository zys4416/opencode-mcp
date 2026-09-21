# AGENTS.md

## Scope and commands

`opencode-mcp` is a TypeScript ESM stdio MCP server. This source version targets OpenCode **2.0.11** with `@opencode/client` **2.0.11**. It manages private `opencode serve --stdio` children, not the shared background service. Keep the binary/client compatibility gate explicit when upgrading.

Use pnpm (`npx -y pnpm@10` when pnpm is not installed).

- `pnpm test`: Vitest suites in `tests/`, including native-client HTTP contract fixtures.
- `pnpm test:coverage`: **100%** lines, statements, branches and functions; do not lower thresholds.
- `pnpm lint`: read-only Biome check. Apply fixes only to changed files.
- `pnpm build`: cleans `build`, compiles TypeScript, makes `build/src/index.js` executable.
- `pnpm test:integration`: requires a current build and OpenCode 2.0.11 (`OPENCODE_BIN` may specify its absolute path). Isolated real-binary test with a local model fixture; no paid provider calls.

## Structure

- `src/index.ts`: registers MCP tools, connects stdio and closes private servers on termination.
- `src/modules/tools/`: tool registration, Zod input schemas and MCP results. Public names start with `opencode_`.
- `shared/opencode-server.ts`: version gate, random/shared Basic credentials, JSON startup handshake, authenticated health/PID checks, bounded cleanup. Do not return passwords or forward raw child output.
- `shared/server-registry.ts`: instance URL, authenticated client, directory, permission health and cleanup.
- `shared/task-registry.ts`: task/session/input identity, cancellation and concurrent update guard. Task state is in memory.
- `shared/opencode-client.ts`: shared client lookup, paginated native messages, normalized progress, execution snapshots. Status and result use the same snapshot. Completion requires an idle message after the submitted input or a session terminal timestamp newer than both the input and the previous execution baseline. Permission rejection can omit both session terminal fields and the idle message; a current-input assistant error is terminal only after the session stops being active. An assistant turn completing alone is insufficient.
- `shared/permissions.ts`: native v2 config and permission fields, ownership/ancestor checks, external read-only policy, SSE and polling reconciliation. Unrelated CLI sessions must not be auto-approved. External reads use `once`, not persistent approvals.
- `shared/usage-limits.ts`: daily cached public quota metadata; `quotaTier` and `quotaByModelId` are the single sources of quota annotation.
- `tests/helpers/v2.ts`: real Promise client with an HTTP fixture. Put runtime-only test helpers under `tests/`.
- `scripts/smoke-v2.mjs`: isolated real-binary integration test.

The empty `src/domain`, `src/application` and `src/infrastructure` directories are not implemented layers. There is no separate MCP prompts implementation in this tree.

## Conventions and compatibility

- Relative TypeScript imports use `.js` suffixes (NodeNext ESM).
- Build entrypoint is `build/src/index.js`. Keep package `main`/`bin` and installation instructions consistent.
- Reuse the authenticated client in the registry; never create unauthenticated clients in individual tools.
- Use v2 native request/response types. Many Promise methods unwrap `data`, while catalog/list methods preserve their envelopes. Tests should exercise actual HTTP serialization, not invented SDK return shapes.
- `agents.available` is authoritative. v2 has no native/custom provenance; do not infer it from display names. Use agent `id` as the selectable `name`.
- MCP guidance is default-first: omit `model` unless the user explicitly asks for model selection. Do not reintroduce cost/quota-based automatic overrides or mandatory model discovery before each task.
- Model selections use `{ providerID, id }`; `modelID` in catalog metadata is not necessarily the selection ID.
- A prompt response is admission, not completion. Record its explicit message ID before sending. Never blindly retry uncertain admissions.
- Follow-up model/agent switches persist for the session. Do not advertise them as temporary per-turn overrides.
- v2 tool parts use `name`, `id`, `state`, and path inputs commonly use `path`. Preserve pagination and execution boundaries when aggregating evidence.
- No secrets, local provider configuration or production/session contents belong in tests or docs.
