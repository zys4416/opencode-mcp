import { beforeEach, describe, expect, it } from "vitest";
import { killAllServers } from "../../../src/modules/shared/server-registry.js";
import { getTask, registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { registerOpencodeCancelTask } from "../../../src/modules/tools/cancel_task.js";
import { fixture, handler } from "../../helpers/v2.js";

const run = handler(registerOpencodeCancelTask);
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
    inputId: "msg_input",
  });
  return f;
}
describe("cancel v2 task", () => {
  it("rejects unresolved task", async () =>
    expect((await run({ task_id: "missing" })).status).toBe("task_not_found"));
  it.each([
    true,
    false,
  ])("interrupts without resuming and cancels only owned pending input (%s)", async (pending) => {
    const { routes, fetch } = setup();
    routes.set("GET /api/session/ses_test/inbox", {
      data: pending ? [{ id: "other" }, { id: "msg_input" }] : [],
    });
    routes.set("DELETE /api/session/ses_test/inbox/msg_input", 204);
    expect((await run({ task_id: "task_test" })).status).toBe("cancelled");
    expect(getTask("task_test")?.cancelledAt).toBeTypeOf("number");
    expect(String(fetch.mock.calls[0][0])).toContain("resume=false");
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/inbox/other"))).toBe(false);
  });
  it.each([401, 400])("does not mark cancellation on errors (%s)", async (status) => {
    const { routes } = setup();
    routes.set(
      "POST /api/session/ses_test/interrupt",
      status === 401 ? 401 : Response.json({ message: "invalid" }, { status }),
    );
    expect((await run({ task_id: "task_test" })).isError).toBe(true);
    expect(getTask("task_test")?.cancelledAt).toBeUndefined();
  });
});
it("does not race another task update", async () => {
  setup();
  Object.assign(getTask("task_test"), { mutating: true });
  expect((await run({ task_id: "task_test" })).message).toBe("Another task update is in progress");
});
