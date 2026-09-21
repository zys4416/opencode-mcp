import { describe, expect, it } from "vitest";
import {
  getTask,
  markTaskCancelled,
  registerTask,
  removeTask,
  type TaskRecord,
} from "../../../src/modules/shared/task-registry.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    serverId: "srv-1",
    sessionId: "session-1",
    ...overrides,
  };
}

describe("task-registry", () => {
  it("registers and retrieves a task", () => {
    const task = makeTask();
    registerTask(task);
    expect(getTask("task-1")).toBe(task);
  });

  it("returns undefined for an unknown task id", () => {
    expect(getTask("missing-task")).toBeUndefined();
  });

  it("removes a registered task", () => {
    const task = makeTask({ taskId: "task-2" });
    registerTask(task);
    removeTask("task-2");
    expect(getTask("task-2")).toBeUndefined();
  });
});

describe("markTaskCancelled", () => {
  it("stamps the record with the given time", () => {
    registerTask({ taskId: "t-cancel", serverId: "srv", sessionId: "s" });
    markTaskCancelled("t-cancel", 1234);
    expect(getTask("t-cancel")?.cancelledAt).toBe(1234);
    removeTask("t-cancel");
  });

  it("defaults to now when no time is given", () => {
    registerTask({ taskId: "t-cancel", serverId: "srv", sessionId: "s" });
    markTaskCancelled("t-cancel");
    expect(getTask("t-cancel")?.cancelledAt).toBeTypeOf("number");
    removeTask("t-cancel");
  });

  it("is a no-op for an unknown task id", () => {
    expect(() => markTaskCancelled("nope")).not.toThrow();
    expect(getTask("nope")).toBeUndefined();
  });
});

it("ignores attempts to resume an unknown task", async () => {
  const { resumeTask } = await import("../../../src/modules/shared/task-registry.js");
  resumeTask("unknown", "msg_test");
  expect(getTask("unknown")).toBeUndefined();
});
