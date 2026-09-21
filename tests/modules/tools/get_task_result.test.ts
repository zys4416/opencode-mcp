import { beforeEach, expect, it, vi } from "vitest";
import { registerOpencodeGetTaskResult } from "../../../src/modules/tools/get_task_result.js";
import { handler } from "../../helpers/v2.js";

const mocks = vi.hoisted(() => ({ clientForTask: vi.fn(), taskSnapshot: vi.fn() }));
vi.mock("../../../src/modules/shared/opencode-client.js", () => mocks);
const run = handler(registerOpencodeGetTaskResult);
beforeEach(() => vi.resetAllMocks());
it("rejects missing tasks", async () =>
  expect((await run({ task_id: "missing" })).status).toBe("not_found"));
it("uses the same execution snapshot as status", async () => {
  mocks.clientForTask.mockReturnValue({ client: {}, sessionId: "ses_test" });
  mocks.taskSnapshot.mockResolvedValue({
    status: "running",
    result: "partial",
    progress: { text_snippet: "partial" },
  });
  expect(await run({ task_id: "task_test" })).toMatchObject({
    task_id: "task_test",
    status: "running",
    result: "partial",
  });
});
it.each([new Error("failed"), "failed"])("reports errors %s", async (error) => {
  mocks.clientForTask.mockReturnValue({ client: {}, sessionId: "ses_test" });
  mocks.taskSnapshot.mockRejectedValue(error);
  expect((await run({ task_id: "task_test" })).isError).toBe(true);
});
