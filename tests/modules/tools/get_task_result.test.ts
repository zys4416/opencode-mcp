import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CANCELLED_TASK_MESSAGE,
  EMPTY_TURN_MESSAGE,
} from "../../../src/modules/shared/opencode-client.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { createFakeMcpServer } from "../../../src/test-utils/fake-mcp-server.js";

const clientForTaskMock = vi.fn();
const assistantEntriesMock = vi.fn();

// Only the transport-facing helpers are stubbed; buildProgress / hasWork /
// sessionParts / EMPTY_TURN_MESSAGE stay real so the evidence payload is
// asserted end to end.
vi.mock("../../../src/modules/shared/opencode-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/shared/opencode-client.js")>()),
  clientForTask: (...args: unknown[]) => clientForTaskMock(...args),
  assistantEntries: (...args: unknown[]) => assistantEntriesMock(...args),
}));

const { registerOpencodeGetTaskResult } = await import(
  "../../../src/modules/tools/get_task_result.js"
);

describe("opencode_get_task_result", () => {
  beforeEach(() => {
    clientForTaskMock.mockReset();
    assistantEntriesMock.mockReset();
    removeTask("task-1");
  });

  it("returns not_found when the task cannot be resolved", async () => {
    clientForTaskMock.mockReturnValue(undefined);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "missing" });

    expect(result).toEqual({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ task_id: "missing", status: "not_found" }) },
      ],
    });
  });

  it("returns pending with a null result when there is no assistant entry", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "pending", result: null }),
        },
      ],
    });
  });

  it("returns failed when the assistant entry has an error", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { error: { name: "OOPS" }, time: {} },
        parts: [],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            task_id: "task-1",
            status: "failed",
            error: "OOPS",
            result: null,
          }),
        },
      ],
    });
  });

  it("returns running with a null result when not completed yet", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([{ info: { time: {} }, parts: [] }]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "running", result: null }),
        },
      ],
    });
  });

  it("returns the joined text plus side-effect evidence for a real turn", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [
          { type: "text", text: "Hello, " },
          {
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath: "src/a.ts" } },
          },
          { type: "text", text: "world!" },
        ],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toEqual({
      task_id: "task-1",
      status: "completed",
      result: "Hello, world!",
      progress: {
        text_snippet: "Hello, world!",
        tool_calls_completed: 1,
        mutating_tool_calls: 1,
        files_touched: ["src/a.ts"],
      },
    });
  });

  it("returns empty, not completed, when the finished turn produced nothing", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([{ info: { time: { completed: 123 } }, parts: [] }]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text)).toEqual({
      task_id: "task-1",
      status: "empty",
      result: null,
      message: EMPTY_TURN_MESSAGE,
      progress: {
        text_snippet: "",
        tool_calls_completed: 0,
        mutating_tool_calls: 0,
        files_touched: [],
      },
    });
  });

  it("treats a whitespace-only finished turn as empty", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [{ type: "text", text: "  \n " }],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(JSON.parse(result.content[0].text).status).toBe("empty");
  });

  it("reports completed with zero files_touched when a turn only ran read-only tools", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 123 } },
        parts: [
          {
            type: "tool",
            tool: "read",
            state: { status: "completed", input: { filePath: "a.ts" } },
          },
        ],
      },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const payload = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);

    // The incident's round 2 shape: the turn ran, but changed nothing.
    expect(payload.status).toBe("completed");
    expect(payload.result).toBe("");
    expect(payload.progress.mutating_tool_calls).toBe(0);
    expect(payload.progress.files_touched).toEqual([]);
  });

  it("collects evidence from earlier turns, not just the final one", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    // The real shape: the agent edits in earlier turns, then closes with "DONE".
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 1 } },
        parts: [
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "e2e/alpha.ts" } },
          },
          {
            type: "tool",
            tool: "edit",
            state: { status: "completed", input: { filePath: "e2e/beta.ts" } },
          },
        ],
      },
      { info: { time: { completed: 2 } }, parts: [{ type: "text", text: "DONE" }] },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const payload = JSON.parse((await handler({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("completed");
    expect(payload.result).toBe("DONE");
    expect(payload.progress.text_snippet).toBe("DONE");
    expect(payload.progress.mutating_tool_calls).toBe(2);
    expect(payload.progress.files_touched).toEqual(["e2e/alpha.ts", "e2e/beta.ts"]);
  });

  it("returns cancelled with the partial output for an aborted task", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([
      {
        info: { time: { completed: 1 } },
        parts: [
          {
            type: "tool",
            tool: "write",
            state: { status: "completed", input: { filePath: "a.ts" } },
          },
        ],
      },
      { info: { time: { completed: 2 } }, parts: [{ type: "text", text: "got halfway" }] },
    ]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);

    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("cancelled");
    expect(payload.result).toBe("got halfway");
    expect(payload.message).toBe(CANCELLED_TASK_MESSAGE);
    expect(payload.progress.files_touched).toEqual(["a.ts"]);
    removeTask("task-1");
  });

  it("returns a null result for a task cancelled before it produced anything", async () => {
    registerTask({
      taskId: "task-1",
      serverId: "srv",
      sessionId: "s1",
      cancelledAt: Date.now(),
    });
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockResolvedValue([]);
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);

    const payload = JSON.parse((await fake.getHandler()({ task_id: "task-1" })).content[0].text);

    expect(payload.status).toBe("cancelled");
    expect(payload.result).toBeNull();
    removeTask("task-1");
  });

  it("returns an error result when the client throws an Error", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockRejectedValue(new Error("network fail"));
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "network fail" }),
        },
      ],
    });
  });

  it("returns an error result when the client throws a non-Error value", async () => {
    clientForTaskMock.mockReturnValue({ client: {}, sessionId: "s1" });
    assistantEntriesMock.mockRejectedValue("weird");
    const fake = createFakeMcpServer();
    registerOpencodeGetTaskResult(fake.server);
    const handler = fake.getHandler();

    const result = await handler({ task_id: "task-1" });

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ task_id: "task-1", status: "error", message: "weird" }),
        },
      ],
    });
  });
});
