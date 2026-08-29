# Incident report — delegated tasks report `completed` after doing nothing

- **Date:** 2026-08-21
- **Version:** opencode-mcp `1.1.5` (`cc12272`)
- **Reporter:** Claude Code (Opus 5), acting as orchestrator
- **Severity:** High — a caller cannot distinguish a successful task from a task that never ran
- **Status:** F1 / F2 / F5 fixed on 2026-08-28 (see §9). F4 still open.

---

## 1. Summary

Two `opencode_start_task` delegations were dispatched to the `build` agent on
`opencode-go/glm-5.2`. Both were reported by this server as `status: "completed"`.
Both wrote **zero files**. `opencode_get_task_result` returned
`{"status": "completed", "result": ""}`.

The orchestrator only discovered the failure by independently stat-ing the files
the agents were supposed to write. Nothing in the MCP surface indicated a problem.

A separate earlier symptom — two tasks stuck for 10+ minutes on a single `read`
tool call with `tool_calls_completed: 0` — is also covered here, because it shares
the same root category: **the server reports session lifecycle state, but callers
need work-performed state, and the two are not the same thing.**

---

## 2. Environment

| | |
|---|---|
| Server cwd | `/Users/alejandro/Documents/PROJECTS/RIVEDO` |
| Started via | `opencode_start_server` (port 4096) → `server_id` `497ed517-834c-42c7-b9d9-c03d4e7d0aaf` |
| Agent | `build` (native, primary) |
| Model | `opencode-go/glm-5.2` (copied verbatim from `opencode_list_agents`) |
| Target work | Rewrite ~7 TypeScript files in `rivedo-web/`, a Next.js 16 subdirectory of the server cwd |

---

## 3. Timeline

### Round 1 — indefinite hang on `read`

| Task ID | Session | Outcome |
|---|---|---|
| `43d5284e-5e8f-4da2-b1f7-8845efbccf6f` | `ses_fd87fc913ffeUk7zrh1Kojw2j8` | hung, cancelled |
| `11e2b1ff-b914-48ce-8aa3-2f35238cfb90` | `ses_fd87f8120ffeSMk5Ei7inAo9Rf` | hung, cancelled |

Both prompts instructed the agent to read a brief at an **absolute path outside
the server cwd**: `/private/tmp/claude-501/.../RIVEDO-BRIEF.md`.

`opencode_get_task_status` with `include_progress: true`, polled at ~2 min and
again at ~12 min, returned an **identical** payload both times:

```json
{"task_id":"43d5284e-...","status":"running",
 "progress":{"text_snippet":"","tool_calls_completed":0,
             "current_tool":"read","current_tool_status":"running"}}
```

`opencode_wait_for_task` (mode `all`, timeout 600 000 ms) ran the full ten minutes
and returned `timed_out: true` with both tasks still `running`.

Both tasks were cancelled via `opencode_cancel_task`; both returned
`{"status": "cancelled"}`. No files had been written.

**Working hypothesis (unconfirmed):** the `read` was blocked on a permission
prompt for a path outside the server's working directory, with no interactive
approver present in the headless server. The session therefore stayed genuinely
`busy` forever.

### Round 2 — instant `completed`, zero side effects

The brief was copied to `<cwd>/RIVEDO-BRIEF.md` and both prompts were rewritten to
use working-directory-relative paths only. Two fresh tasks were dispatched:

| Task ID | Session | Reported | Files written |
|---|---|---|---|
| `1184c0e4-e471-4bbd-a228-97ee47e939cf` | `ses_fd879bdb8ffeMh4qN0s1KLJ2Wt` | `completed` (< 2 min) | 0 |
| `2c1e128e-e9a5-48a7-82ef-30a783ff6524` | `ses_fd87985cbffeygDYPFuARNejns` | `completed` | 0 |

`opencode_get_task_result` on the first:

```json
{"task_id":"1184c0e4-e471-4bbd-a228-97ee47e939cf","status":"completed","result":""}
```

Independent verification — the files the agent was scoped to rewrite were
untouched, still carrying their `08-20 21:xx` mtimes:

```
.rw-r--r--@ 1.5k alejandro 08-20 21:31 src/config/site.config.ts
.rw-r--r--@ 3.5k alejandro 08-20 21:32 src/domain/catalog/product.ts
.rw-r--r--@  11k alejandro 08-20 21:54 src/infrastructure/catalog/catalog.dataset.ts
```

`src/domain/catalog/product.ts` still began with the pre-existing
`export const MATERIALS = {` block that the task existed to delete.

Delegation was abandoned and the work was done directly by the orchestrator.

---

## 4. Root cause analysis

### F1 — `completed` is a timestamp check, not a work check *(primary)*

`src/modules/tools/get_task_result.ts`

```ts
if (!entry.info.time.completed) {
  return jsonResult({ task_id, status: "running", result: null });
}

const text = entry.parts
  .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
  .map((part) => part.text)
  .join("");

return jsonResult({ task_id, status: "completed", result: text });
```

`text` is `""` when the assistant message carries no text parts. That empty string
is returned under `status: "completed"` with no other signal. An assistant message
that ended with **zero text parts and zero tool calls** is byte-for-byte
indistinguishable from a task that succeeded and happened to stay quiet.

`deriveTaskStatus` in `src/modules/shared/opencode-client.ts` has the same shape:

```ts
if (entry.info.time.completed) {
  return { task_id: taskId, status: "completed" };
}
```

Neither path consults `parts` before declaring success.

### F2 — the stall guard has a hole

`PENDING_STALL_MS` (15 s) is a good idea, but it is only reachable on the
`!entry` branch:

```ts
const entry = await lastAssistantEntry(client, sessionId);
if (!entry) {
  // ... stall check lives here, and ONLY here
}
```

Once *any* assistant message exists — including an empty, aborted, or
immediately-terminated one — the guard is bypassed permanently. Round 2 produced
exactly that: an assistant message existed, so the stall detection never applied.

### F3 — no watchdog on a tool part stuck in `running`

`buildProgress` reports `current_tool` / `current_tool_status` but no timing. In
round 1 the progress payload was **byte-identical** across a ten-minute gap, and
`deriveTaskStatus` correctly reported `running` the whole time, because the
session genuinely *was* busy.

The server was not wrong. It was just unable to express the difference between
"working" and "wedged". A caller has no field to compare against.

### F4 — cancellation leaves no trace *(by inspection; consequence not observed)*

`src/modules/shared/task-registry.ts`

```ts
export interface TaskRecord {
  taskId: string;
  serverId: string;
  sessionId: string;
  createdAt?: number;
}
```

There is no cancelled/aborted field. `cancel_task` calls `client.session.abort()`
and returns, writing nothing back to the registry. Status derivation therefore has
no way to report `cancelled`, and an aborted session whose last assistant message
carries a completed timestamp would surface as `completed`.

*Not verified in this incident* — the cancelled round-1 tasks were not re-queried
after abort. The missing field is a fact; the resulting misreport is inferred from
the code path.

### F5 — headless approval capability is never surfaced

If the working hypothesis for round 1 is right, then a `build` agent that cannot
get permission approvals in a headless server will no-op or wedge on every
write-shaped task. Neither `start_server`, `list_agents` nor `start_task` reports
anything about the server's permission posture, so a caller cannot preflight this.

`start_task` already validates the model against the real catalog specifically
because "promptAsync is fire-and-forget, so an unknown model would otherwise fail
silently". That instinct is correct and simply needs to extend to permissions.

---

## 5. Impact

- **Silent data loss of work.** An orchestrator that trusts `completed` will
  proceed to the next phase on top of unchanged files.
- **Wasted wall-clock and tokens.** ~25 minutes across two rounds, plus the full
  prompt cost of four dispatches, for zero output.
- **Erodes the delegation contract.** The only reliable verification available to
  the caller was stat-ing files on disk — which defeats the purpose of delegating.

---

## 6. Recommended fixes

Ordered by value per unit of effort.

### R1 — never report `completed` on an empty assistant turn

In `get_task_result.ts` and `deriveTaskStatus`, count the parts before deciding:

```ts
const textParts  = entry.parts.filter((p) => p.type === "text");
const toolParts  = entry.parts.filter((p) => p.type === "tool");
const didWork    = textParts.some((p) => p.text.trim() !== "") || toolParts.length > 0;

if (!didWork) {
  return jsonResult({
    task_id,
    status: "empty",
    result: null,
    message:
      "the session finished without producing any text or tool calls; the prompt was likely rejected or the turn was aborted",
  });
}
```

A distinct `empty` status is better than folding it into `failed`: it is a real,
recognisable state, and naming it lets callers branch on it.

### R2 — put side-effect evidence in the result payload

The single most useful field this server could add. Derive it from the tool parts
already being walked in `buildProgress`:

```ts
export interface TaskProgress {
  text_snippet: string;
  tool_calls_completed: number;
  /** Completed tool calls that mutate the workspace (edit / write / patch / bash). */
  mutating_tool_calls: number;
  /** Distinct file paths touched by completed edit/write calls. */
  files_touched: string[];
  current_tool?: string;
  current_tool_status?: string;
}
```

Return it from `get_task_result` too, not just `get_task_status`. One call would
have caught this incident immediately: `completed` + `files_touched: []` on a task
whose whole purpose was writing files.

### R3 — extend the stall guard past the `!entry` branch

Move the `PENDING_STALL_MS` check so it also covers "assistant message exists but
is empty and the session is idle". Same 15 s window, one extra condition.

### R4 — expose staleness on the running path

Track the last observed change to `(tool_calls_completed, current_tool,
current_tool_status, text_snippet.length)` per task, with a timestamp. Emit:

```ts
{ status: "running", progress: { ..., unchanged_for_ms: 612_000 } }
```

`wait_for_task` can then surface a warning rather than silently burning its whole
timeout. This turns round 1 from a mystery into a one-line diagnosis.

### R5 — record cancellation in the task registry

```ts
export interface TaskRecord {
  taskId: string;
  serverId: string;
  sessionId: string;
  createdAt?: number;
  cancelledAt?: number;   // set by cancel_task
}
```

`deriveTaskStatus` checks it first and returns `status: "cancelled"`. Cheap, and
it closes F4 before it bites someone.

### R6 — preflight the permission posture

Mirror the existing model-validation block in `start_task`: query the server's
permission configuration and, if the selected agent needs approvals the headless
server cannot grant, fail fast with `status: "requires_approval"` and the reason —
rather than dispatching a task that can only wedge or no-op.

---

## 7. Suggested regression tests

The `tests/modules/` layout already mirrors `src/`, so these drop straight in.

`tests/modules/tools/get_task_result.test.ts`
- completed assistant message, **zero parts** → `status: "empty"`, `result: null`
- completed assistant message, text parts that are whitespace only → `status: "empty"`
- completed assistant message, zero text parts but ≥1 completed tool part →
  `status: "completed"`, `mutating_tool_calls` reflects the tool parts
- completed assistant message with real text → unchanged current behaviour

`tests/modules/shared/opencode-client.test.ts`
- `deriveTaskStatus`: idle session, empty assistant entry, `createdAt` older than
  `PENDING_STALL_MS` → `failed` (covers F2)
- `buildProgress`: given edit/write tool parts → correct `files_touched`
- `deriveTaskStatus`: task record with `cancelledAt` set → `cancelled` (covers F5)

`tests/modules/tools/cancel_task.test.ts`
- after `cancel_task`, the registry record carries `cancelledAt`
- a subsequent `get_task_status` for that task returns `cancelled`, not `completed`

---

## 8. Workaround for callers, until fixed

Do not trust `status: "completed"`. After any delegated task that was supposed to
change the workspace, verify independently before proceeding:

```bash
git -C <repo> status --porcelain          # for a tracked repo
eza -l --time-style=iso <expected paths>  # for untracked work
```

Treat `{"status": "completed", "result": ""}` as a **failure** until R1 lands.

## 9. Resolution (2026-08-28)

- F1 is fixed: `get_task_result` and `deriveTaskStatus` now return `status: "empty"` instead of `"completed"` when the latest assistant turn contains no text parts and no tool calls.
- R2 is implemented: `TaskProgress` now carries `mutating_tool_calls` and `files_touched`, and `get_task_result` returns those counts alongside the task status and result.
- F5 is fixed: a permission responder auto-answers every permission request in headless mode; reads outside the working directory are allowed, writes outside the working directory are rejected, so tasks no longer wedge on an interactive approval prompt.
- F2 is closed as a side effect of F1: an idle session whose assistant message exists but is empty now reports `empty`, which was the case the `PENDING_STALL_MS` guard could not reach.
- Side-effect evidence is collected across **every** assistant turn in the session, not just the last one. An agent's edits land in earlier turns while the final turn is usually just "DONE", so reading evidence off the last message reported `files_touched: []` for a task that had rewritten the workspace. This was caught only by end-to-end runs against a live server; the unit tests passed throughout.
- F4 (cancellation leaves no trace in the task registry) is **not** addressed.

Verified end to end against opencode `1.18.18`, replaying both incident rounds:

| Replayed scenario | Before | After |
|---|---|---|
| Round 1 — read a brief at an absolute path outside the cwd | hung indefinitely, `tool_calls_completed: 0` | `completed` in 15s, `mutating_tool_calls: 0`, `files_touched: []` |
| Round 2 — rewrite files in a subdirectory | `completed` with `result: ""`, 0 files written | `completed`, `mutating_tool_calls: 2`, `files_touched` lists both files, both changed on disk |
| Write outside the cwd | n/a | rejected, tool state `error`, file not created |
