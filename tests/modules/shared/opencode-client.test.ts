import { beforeEach, describe, expect, it } from "vitest";
import {
  assistantEntries,
  assistantEntry,
  buildProgress,
  clientForServer,
  clientForTask,
  deriveTaskStatus,
  hasWork,
  lastAssistantEntry,
  messages,
  PENDING_STALL_MS,
  sessionParts,
  taskSnapshot,
} from "../../../src/modules/shared/opencode-client.js";
import { getServer, killAllServers } from "../../../src/modules/shared/server-registry.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { assistant, fixture, idle, user } from "../../helpers/v2.js";

describe("buildProgress across a whole session", () => {
  it("reads the snippet from the latest turn and the evidence from every turn", () => {
    const earlier = [
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "a.ts" } } },
    ];
    const latest = [{ type: "text", text: "DONE" }];
    const progress = buildProgress(latest as never, [...earlier, ...latest] as never);
    expect(progress.text_snippet).toBe("DONE");
    expect(progress.mutating_tool_calls).toBe(1);
    expect(progress.files_touched).toEqual(["a.ts"]);
  });

  it("still reports the in-flight tool from the latest turn only", () => {
    const earlier = [
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a.ts" } } },
    ];
    const latest = [{ type: "tool", tool: "write", state: { status: "running", input: {} } }];
    const progress = buildProgress(latest as never, [...earlier, ...latest] as never);
    expect(progress.current_tool).toBe("write");
    expect(progress.current_tool_status).toBe("running");
    expect(progress.tool_calls_completed).toBe(1);
  });

  it("defaults the session view to the latest turn when no session parts are given", () => {
    const parts = [
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "a.ts" } } },
    ];
    expect(buildProgress(parts as never).files_touched).toEqual(["a.ts"]);
  });
});

describe("sessionParts", () => {
  it("flattens every assistant entry's parts, oldest first", () => {
    const entries = [
      { info: {}, parts: [{ type: "text", text: "one" }] },
      { info: {}, parts: [{ type: "text", text: "two" }] },
    ];
    expect(sessionParts(entries as never)).toEqual([
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ]);
  });
});

describe("hasWork", () => {
  it("is false for no parts at all", () => {
    expect(hasWork([])).toBe(false);
  });

  it("is false for text parts that are only whitespace", () => {
    expect(hasWork([{ type: "text", text: "  \n\t " }] as never)).toBe(false);
  });

  it("is true for text parts with real content", () => {
    expect(hasWork([{ type: "text", text: "ok" }] as never)).toBe(true);
  });

  it("is true for a tool part even with no text, whatever its status", () => {
    expect(hasWork([{ type: "tool", tool: "write", state: { status: "error" } }] as never)).toBe(
      true,
    );
  });

  it("ignores part types that are neither text nor tool", () => {
    expect(hasWork([{ type: "step-start" }] as never)).toBe(false);
  });
});

describe("buildProgress", () => {
  it("counts mutating tool calls and collects the files they touched", () => {
    const parts = [
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a.ts" } } },
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "b.ts" } } },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "c.ts" } } },
      {
        type: "tool",
        tool: "apply_patch",
        state: { status: "completed", input: { filePath: "d.ts" } },
      },
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" } } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.tool_calls_completed).toBe(5);
    // `read` is not mutating; `bash` is, but names no path.
    expect(progress.mutating_tool_calls).toBe(4);
    expect(progress.files_touched).toEqual(["b.ts", "c.ts", "d.ts"]);
  });

  it("deduplicates repeated file paths", () => {
    const parts = [
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "a.ts" } } },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: "a.ts" } } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.mutating_tool_calls).toBe(2);
    expect(progress.files_touched).toEqual(["a.ts"]);
  });

  it("ignores a mutating call whose filePath is missing, empty, or not a string", () => {
    const parts = [
      { type: "tool", tool: "write", state: { status: "completed", input: {} } },
      { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "" } } },
      { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: 42 } } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.mutating_tool_calls).toBe(3);
    expect(progress.files_touched).toEqual([]);
  });

  it("does not count a mutating call that has not completed", () => {
    const parts = [
      { type: "tool", tool: "write", state: { status: "running", input: { filePath: "a.ts" } } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.mutating_tool_calls).toBe(0);
    expect(progress.files_touched).toEqual([]);
  });

  it("concatenates text parts and truncates the snippet to the last ~500 chars", () => {
    const longText = "a".repeat(300) + "b".repeat(300);
    const parts = [
      { type: "text", text: "a".repeat(300) },
      { type: "text", text: "b".repeat(300) },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.text_snippet).toBe(longText.slice(-500));
    expect(progress.text_snippet.length).toBe(500);
    expect(progress.tool_calls_completed).toBe(0);
  });

  it("counts completed tool parts and tracks the last running/pending tool", () => {
    const parts = [
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "grep", state: { status: "completed" } },
      { type: "tool", tool: "edit", state: { status: "pending" } },
      { type: "tool", tool: "write", state: { status: "running" } },
    ];
    const progress = buildProgress(parts as never);
    expect(progress.tool_calls_completed).toBe(2);
    expect(progress.current_tool).toBe("write");
    expect(progress.current_tool_status).toBe("running");
  });

  it("ignores error tool parts and leaves current_tool undefined when nothing is running/pending", () => {
    const parts = [{ type: "tool", tool: "bash", state: { status: "error" } }];
    const progress = buildProgress(parts as never);
    expect(progress.tool_calls_completed).toBe(0);
    expect(progress.current_tool).toBeUndefined();
    expect(progress.current_tool_status).toBeUndefined();
  });

  it("ignores part types that are neither text nor tool", () => {
    const parts = [{ type: "step-start" }];
    const progress = buildProgress(parts as never);
    expect(progress).toEqual({
      text_snippet: "",
      tool_calls_completed: 0,
      mutating_tool_calls: 0,
      files_touched: [],
    });
  });

  it("returns an empty snippet when there are no parts", () => {
    const progress = buildProgress([]);
    expect(progress).toEqual({
      text_snippet: "",
      tool_calls_completed: 0,
      mutating_tool_calls: 0,
      files_touched: [],
    });
  });
});

describe("v2 snapshots", () => {
  beforeEach(() => {
    killAllServers();
    removeTask("task_test");
  });
  function task() {
    registerTask({
      taskId: "task_test",
      serverId: "srv_test",
      sessionId: "ses_test",
      inputId: "msg_input",
      createdAt: Date.now(),
    });
  }
  it("reuses the authenticated client and resolves only registered tasks", () => {
    const { client } = fixture();
    expect(clientForServer("missing")).toBeUndefined();
    expect(clientForTask("missing")).toBeUndefined();
    task();
    expect(clientForTask("task_test")).toEqual({ client, sessionId: "ses_test" });
    killAllServers();
    expect(clientForTask("task_test")).toBeUndefined();
  });
  it("reads ordered pages and rejects looping cursors", async () => {
    const { client, fetch } = fixture();
    fetch
      .mockResolvedValueOnce(Response.json({ data: [user], cursor: { next: "next" } }))
      .mockResolvedValueOnce(Response.json({ data: [assistant], cursor: {} }));
    expect(await messages(client, "ses_test")).toHaveLength(2);
    expect(String(fetch.mock.calls[1][0])).toContain("cursor=next");
    expect(String(fetch.mock.calls[1][0])).not.toContain("order=");
    fetch.mockImplementation(async () => Response.json({ data: [], cursor: { next: "same" } }));
    await expect(messages(client, "ses_test")).rejects.toThrow("repeated");
  });
  it("normalizes content without treating streamed JSON as tool input", () => {
    const content = [
      { type: "reasoning", text: "thinking" },
      ...["streaming", "running", "completed", "error"].map((status) => ({
        type: "tool",
        id: status,
        name: "write",
        state: { status, input: status === "streaming" ? "{" : { path: "/a" } },
      })),
    ];
    const entry = assistantEntry({ ...assistant, content } as never);
    expect(entry.parts[1]).toMatchObject({ state: { status: "pending", input: {} } });
    expect(buildProgress(entry.parts).files_touched).toEqual(["/a"]);
  });
  it("collects assistant entries and handles empty timelines", async () => {
    const { client, routes } = fixture();
    expect(await assistantEntries(client, "ses_test")).toHaveLength(1);
    expect((await lastAssistantEntry(client, "ses_test"))?.info.id).toBe("msg_answer");
    routes.set("GET /api/session/ses_test/message", { data: [], cursor: {} });
    expect(await lastAssistantEntry(client, "ses_test")).toBeUndefined();
  });
  it("reports completed output and optional progress", async () => {
    const { client } = fixture();
    task();
    expect(await deriveTaskStatus(client, "ses_test", "task_test")).toMatchObject({
      status: "completed",
    });
    expect(
      await deriveTaskStatus(client, "ses_test", "task_test", { includeProgress: true }),
    ).toMatchObject({ progress: { text_snippet: "done" } });
  });
  it("never reads an old completion as a newly submitted prompt", async () => {
    const { client } = fixture();
    task();
    registerTask({
      taskId: "task_test",
      serverId: "srv_test",
      sessionId: "ses_test",
      inputId: "msg_new",
      createdAt: Date.now(),
    });
    expect(await taskSnapshot(client, "ses_test", "task_test")).toMatchObject({
      status: "pending",
      result: null,
    });
  });
  it("reports running until the whole execution is idle", async () => {
    const { client, routes } = fixture();
    task();
    routes.set("GET /api/session/active", { data: { ses_test: { type: "running" } } });
    expect(await taskSnapshot(client, "ses_test", "task_test")).toMatchObject({
      status: "running",
    });
  });
  it.each([
    "failed",
    "interrupted",
    "succeeded",
  ])("handles terminal %s with no assistant output", async (outcome) => {
    const { client, routes } = fixture();
    task();
    routes.set("GET /api/session/ses_test/message", {
      data: [user, { ...idle, outcome }],
      cursor: {},
    });
    expect((await taskSnapshot(client, "ses_test", "task_test")).status).toBe(
      outcome === "succeeded" ? "empty" : outcome === "failed" ? "failed" : "cancelled",
    );
  });
  it("preserves execution failure details", async () => {
    const { client, routes } = fixture();
    task();
    routes.set("GET /api/session/ses_test/message", {
      data: [
        user,
        { ...assistant, error: { type: "provider", message: "failed" } },
        { ...idle, outcome: "failed" },
      ],
      cursor: {},
    });
    expect(await taskSnapshot(client, "ses_test", "task_test")).toMatchObject({ error: "failed" });
  });
  it("keeps explicit cancellation and reports stalled inputs", async () => {
    const { client, routes } = fixture();
    task();
    registerTask({
      taskId: "task_test",
      serverId: "srv_test",
      sessionId: "ses_test",
      inputId: "msg_input",
      cancelledAt: 1,
    });
    expect((await taskSnapshot(client, "ses_test", "task_test")).status).toBe("cancelled");
    routes.set("GET /api/session/ses_test/message", { data: [user], cursor: {} });
    registerTask({
      taskId: "task_test",
      serverId: "srv_test",
      sessionId: "ses_test",
      inputId: "msg_input",
      createdAt: Date.now() - PENDING_STALL_MS - 1,
    });
    expect((await taskSnapshot(client, "ses_test", "task_test")).status).toBe("failed");
    expect((await taskSnapshot(client, "ses_test", "unknown")).status).toBe("pending");
  });
  it("surfaces unhealthy permission handling", async () => {
    const { client } = fixture();
    task();
    Object.assign(getServer("srv_test"), { permissionError: "unavailable" });
    await expect(taskSnapshot(client, "ses_test", "task_test")).rejects.toThrow("unavailable");
  });
});

it.each([
  { idleAt: 3, previousIdleAt: 0, expected: "cancelled" },
  { idleAt: 3, previousIdleAt: 3, expected: "pending" },
  { idleAt: 0, previousIdleAt: 0, expected: "pending" },
])("uses a fresh session terminal timestamp without an idle message: %o", async ({
  idleAt,
  previousIdleAt,
  expected,
}) => {
  const { client, routes } = fixture();
  registerTask({
    taskId: "terminal_test",
    serverId: "srv_test",
    sessionId: "ses_test",
    inputId: "msg_input",
    previousIdleAt,
  });
  routes.set("GET /api/session/ses_test/message", { data: [user, assistant], cursor: {} });
  routes.set("GET /api/session/ses_test", {
    data: { id: "ses_test", outcome: "interrupted", time: { idle: idleAt } },
  });
  expect((await taskSnapshot(client, "ses_test", "terminal_test")).status).toBe(expected);
  removeTask("terminal_test");
});
it("accepts a first-run terminal timestamp without a previous baseline", async () => {
  const { client, routes } = fixture();
  registerTask({
    taskId: "first_run",
    serverId: "srv_test",
    sessionId: "ses_test",
    inputId: "msg_input",
  });
  routes.set("GET /api/session/ses_test/message", { data: [user, assistant], cursor: {} });
  routes.set("GET /api/session/ses_test", {
    data: { id: "ses_test", outcome: "succeeded", time: { idle: 3 } },
  });
  expect((await taskSnapshot(client, "ses_test", "first_run")).status).toBe("completed");
  removeTask("first_run");
});
it("recognizes permission rejection without session outcome or idle projection", async () => {
  const { client, routes } = fixture();
  registerTask({
    taskId: "rejected",
    serverId: "srv_test",
    sessionId: "ses_test",
    inputId: "msg_input",
  });
  routes.set("GET /api/session/ses_test/message", {
    data: [user, { ...assistant, error: { type: "aborted", message: "Step interrupted" } }],
    cursor: {},
  });
  expect(await taskSnapshot(client, "ses_test", "rejected")).toMatchObject({
    status: "cancelled",
    error: "Step interrupted",
  });
  removeTask("rejected");
});
