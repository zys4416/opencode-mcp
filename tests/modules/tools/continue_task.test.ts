import { beforeEach, describe, expect, it } from "vitest";
import { killAllServers } from "../../../src/modules/shared/server-registry.js";
import { getTask, registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { registerOpencodeContinueTask } from "../../../src/modules/tools/continue_task.js";
import { fixture, handler } from "../../helpers/v2.js";

const run = handler(registerOpencodeContinueTask);
beforeEach(() => {
  killAllServers();
  removeTask("task_test");
});
function setup() {
  const f = fixture();
  registerTask({
    taskId: "task_test",
    serverId: "srv_test",
    sessionId: "ses_test",
    cancelledAt: 1,
  });
  return f;
}
describe("continue v2 task", () => {
  it("rejects unresolved tasks and malformed models", async () => {
    expect((await run({ task_id: "missing", prompt: "hi" })).status).toBe("task_not_found");
    setup();
    for (const model of ["bad", "/model", "test/"])
      expect((await run({ task_id: "task_test", prompt: "hi", model })).status).toBe(
        "invalid_model",
      );
  });
  it("changes model and agent, resets cancellation and records the next input", async () => {
    const { fetch } = setup();
    const result = await run({
      task_id: "task_test",
      prompt: "next",
      model: "test/model",
      agent: "plan",
    });
    expect(result.status).toBe("pending");
    expect(getTask("task_test")).toMatchObject({
      inputId: expect.stringMatching(/^msg_/),
      createdAt: expect.any(Number),
    });
    expect(getTask("task_test")?.cancelledAt).toBeUndefined();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/model"))).toBe(true);
  });
  it("continues without overrides", async () => {
    setup();
    expect((await run({ task_id: "task_test", prompt: "next" })).status).toBe("pending");
  });
  it.each([true, false])("rejects active or queued sessions (%s)", async (active) => {
    const { routes } = setup();
    routes.set(active ? "GET /api/session/active" : "GET /api/session/ses_test/inbox", {
      data: active ? { ses_test: { type: "running" } } : [{ id: "pending" }],
    });
    expect((await run({ task_id: "task_test", prompt: "next" })).isError).toBe(true);
  });
  it.each([401, 400])("reports request errors (%s)", async (status) => {
    const { routes } = setup();
    routes.set(
      "POST /api/session/ses_test/prompt",
      status === 401 ? 401 : Response.json({ message: "invalid" }, { status }),
    );
    expect((await run({ task_id: "task_test", prompt: "next" })).isError).toBe(true);
  });
});
it("serializes concurrent follow-ups", async () => {
  setup();
  const first = run({ task_id: "task_test", prompt: "first" });
  expect((await run({ task_id: "task_test", prompt: "second" })).message).toBe(
    "Another task update is in progress",
  );
  await first;
  expect(getTask("task_test")?.mutating).toBe(false);
});
