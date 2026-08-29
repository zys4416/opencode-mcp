import { beforeEach, describe, expect, it, vi } from "vitest";

const createOpencodeClientMock = vi.fn();

vi.mock("@opencode-ai/sdk", () => ({
  createOpencodeClient: (...args: unknown[]) => createOpencodeClientMock(...args),
}));

import {
  assistantEntries,
  buildProgress,
  CANCELLED_TASK_MESSAGE,
  clientForServer,
  clientForTask,
  deriveTaskStatus,
  EMPTY_TURN_MESSAGE,
  hasWork,
  lastAssistantEntry,
  PENDING_STALL_MS,
  sessionParts,
} from "../../../src/modules/shared/opencode-client.js";
import { killAllServers, registerServer } from "../../../src/modules/shared/server-registry.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";

describe("clientForServer", () => {
  beforeEach(() => {
    killAllServers();
    createOpencodeClientMock.mockReset();
  });

  it("returns undefined when the server id is unknown", () => {
    expect(clientForServer("missing")).toBeUndefined();
    expect(createOpencodeClientMock).not.toHaveBeenCalled();
  });

  it("builds a client from the registered server's baseUrl", () => {
    const fakeClient = { fake: true };
    createOpencodeClientMock.mockReturnValue(fakeClient);
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });

    const client = clientForServer("srv-1");

    expect(client).toBe(fakeClient);
    expect(createOpencodeClientMock).toHaveBeenCalledWith({ baseUrl: "http://127.0.0.1:4096" });
  });
});

describe("clientForTask", () => {
  beforeEach(() => {
    killAllServers();
    createOpencodeClientMock.mockReset();
    removeTask("task-1");
  });

  it("returns undefined when the task id is unknown", () => {
    expect(clientForTask("missing")).toBeUndefined();
  });

  it("returns undefined when the task's server is unknown", () => {
    registerTask({ taskId: "task-1", serverId: "srv-missing", sessionId: "session-1" });
    expect(clientForTask("task-1")).toBeUndefined();
  });

  it("resolves the client and session id for a known task", () => {
    const fakeClient = { fake: true };
    createOpencodeClientMock.mockReturnValue(fakeClient);
    registerServer({ serverId: "srv-1", baseUrl: "http://127.0.0.1:4096", close: vi.fn() });
    registerTask({ taskId: "task-1", serverId: "srv-1", sessionId: "session-1" });

    const resolved = clientForTask("task-1");

    expect(resolved).toEqual({ client: fakeClient, sessionId: "session-1" });
  });
});

describe("lastAssistantEntry", () => {
  it("returns undefined when there are no messages", async () => {
    const client = { session: { messages: vi.fn().mockResolvedValue({ data: [] }) } };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns undefined when data is missing", async () => {
    const client = { session: { messages: vi.fn().mockResolvedValue({}) } };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns undefined when no message has the assistant role", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "user" }, parts: [] }],
        }),
      },
    };
    const entry = await lastAssistantEntry(client as never, "session-1");
    expect(entry).toBeUndefined();
  });

  it("returns the most recent assistant message", async () => {
    const olderAssistant = { info: { role: "assistant", id: "old" }, parts: [] };
    const newestAssistant = { info: { role: "assistant", id: "new" }, parts: [{ type: "text" }] };
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [olderAssistant, { info: { role: "user" }, parts: [] }, newestAssistant],
        }),
      },
    };

    const entry = await lastAssistantEntry(client as never, "session-1");

    expect(entry).toEqual({ info: newestAssistant.info, parts: newestAssistant.parts });
  });
});

describe("deriveTaskStatus", () => {
  it("returns running when the session is busy", async () => {
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }) },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("returns running when the session is retrying", async () => {
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "retry" } } }) },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("returns cancelled for a cancelled task, even though the session says busy", async () => {
    registerTask({
      taskId: "task-killed",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }) },
    };

    const result = await deriveTaskStatus(client as never, "s1", "task-killed");

    expect(result).toEqual({
      task_id: "task-killed",
      status: "cancelled",
      error: CANCELLED_TASK_MESSAGE,
      progress: undefined,
    });
    // Cancellation short-circuits before any session lookup.
    expect(client.session.status).not.toHaveBeenCalled();
    removeTask("task-killed");
  });

  it("returns cancelled instead of completed for an aborted finished session", async () => {
    registerTask({
      taskId: "task-killed",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: 123 } },
              parts: [{ type: "text", text: "half done" }],
            },
          ],
        }),
      },
    };

    const result = await deriveTaskStatus(client as never, "s1", "task-killed");

    expect(result.status).toBe("cancelled");
    removeTask("task-killed");
  });

  it("reports what a cancelled task managed to touch before the abort", async () => {
    registerTask({
      taskId: "task-killed",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    const client = {
      session: {
        status: vi.fn(),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: 1 } },
              parts: [
                {
                  type: "tool",
                  tool: "write",
                  state: { status: "completed", input: { filePath: "a.ts" } },
                },
              ],
            },
            { info: { role: "assistant", time: {} }, parts: [{ type: "text", text: "partial" }] },
          ],
        }),
      },
    };

    const result = await deriveTaskStatus(client as never, "s1", "task-killed", {
      includeProgress: true,
    });

    expect(result.status).toBe("cancelled");
    expect(result.progress).toEqual({
      text_snippet: "partial",
      tool_calls_completed: 1,
      mutating_tool_calls: 1,
      files_touched: ["a.ts"],
    });
    removeTask("task-killed");
  });

  it("omits progress for a cancelled task with no assistant output", async () => {
    registerTask({
      taskId: "task-killed",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    const client = {
      session: { status: vi.fn(), messages: vi.fn().mockResolvedValue({ data: [] }) },
    };

    const result = await deriveTaskStatus(client as never, "s1", "task-killed", {
      includeProgress: true,
    });

    expect(result).toEqual({
      task_id: "task-killed",
      status: "cancelled",
      error: CANCELLED_TASK_MESSAGE,
      progress: undefined,
    });
    removeTask("task-killed");
  });

  it("returns pending when not busy and there is no assistant entry", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "pending" });
  });

  it("returns pending for a recently started task with no assistant entry", async () => {
    registerTask({ taskId: "task-fresh", serverId: "srv", sessionId: "s1", createdAt: Date.now() });
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-fresh");
    expect(result).toEqual({ task_id: "task-fresh", status: "pending" });
    removeTask("task-fresh");
  });

  it("returns failed when an idle task has no assistant entry past the stall window", async () => {
    registerTask({
      taskId: "task-stalled",
      serverId: "srv",
      sessionId: "s1",
      createdAt: Date.now() - PENDING_STALL_MS - 1,
    });
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-stalled");
    expect(result).toEqual({
      task_id: "task-stalled",
      status: "failed",
      error:
        "task produced no output after starting; the prompt was likely rejected (e.g. invalid model or agent)",
    });
    removeTask("task-stalled");
  });

  it("returns failed when the assistant entry has an error", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", error: { name: "OOPS" }, time: {} }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "failed", error: "OOPS" });
  });

  it("returns completed when the assistant entry finished and produced work", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: 123 } },
              parts: [{ type: "text", text: "all done" }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "completed", progress: undefined });
  });

  it("includes side-effect evidence on the completed path when includeProgress is true", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: 123 } },
              parts: [
                { type: "text", text: "done" },
                {
                  type: "tool",
                  tool: "write",
                  state: { status: "completed", input: { filePath: "src/a.ts" } },
                },
              ],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "completed",
      progress: {
        text_snippet: "done",
        tool_calls_completed: 1,
        mutating_tool_calls: 1,
        files_touched: ["src/a.ts"],
      },
    });
  });

  it("returns empty, not completed, when the finished turn produced nothing", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", time: { completed: 123 } }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({
      task_id: "task-1",
      status: "empty",
      error: EMPTY_TURN_MESSAGE,
      progress: undefined,
    });
  });

  it("treats a whitespace-only finished turn as empty and can report its progress", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: 123 } },
              parts: [{ type: "text", text: "   \n  " }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "empty",
      error: EMPTY_TURN_MESSAGE,
      progress: {
        text_snippet: "   \n  ",
        tool_calls_completed: 0,
        mutating_tool_calls: 0,
        files_touched: [],
      },
    });
  });

  it("returns running when the assistant entry has no completed time and no error", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [{ info: { role: "assistant", time: {} }, parts: [] }],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
  });

  it("does not call messages when includeProgress is false/absent on the busy path", async () => {
    const messages = vi.fn();
    const client = {
      session: { status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }), messages },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1");
    expect(result).toEqual({ task_id: "task-1", status: "running" });
    expect(messages).not.toHaveBeenCalled();
  });

  it("includes progress on the busy path when includeProgress is true", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant" },
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "running",
      progress: {
        text_snippet: "hello",
        tool_calls_completed: 0,
        mutating_tool_calls: 0,
        files_touched: [],
      },
    });
  });

  it("omits progress on the busy path when there is no assistant entry yet", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: { s1: { type: "busy" } } }),
        messages: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({ task_id: "task-1", status: "running", progress: undefined });
  });

  it("includes progress on the not-completed fallback path when includeProgress is true", async () => {
    const client = {
      session: {
        status: vi.fn().mockResolvedValue({ data: {} }),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: {} },
              parts: [{ type: "text", text: "still working" }],
            },
          ],
        }),
      },
    };
    const result = await deriveTaskStatus(client as never, "s1", "task-1", {
      includeProgress: true,
    });
    expect(result).toEqual({
      task_id: "task-1",
      status: "running",
      progress: {
        text_snippet: "still working",
        tool_calls_completed: 0,
        mutating_tool_calls: 0,
        files_touched: [],
      },
    });
  });
});

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

describe("assistantEntries", () => {
  it("returns every assistant message in order, skipping user messages", async () => {
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [
            { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
            { info: { role: "assistant", time: { completed: 1 } }, parts: [] },
            { info: { role: "assistant", time: { completed: 2 } }, parts: [] },
          ],
        }),
      },
    };
    const entries = await assistantEntries(client as never, "s1");
    expect(entries).toHaveLength(2);
    expect(entries[0].info.time.completed).toBe(1);
    expect(entries[1].info.time.completed).toBe(2);
  });

  it("returns an empty array when the session has no messages", async () => {
    const client = { session: { messages: vi.fn().mockResolvedValue({ data: undefined }) } };
    expect(await assistantEntries(client as never, "s1")).toEqual([]);
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
