import { beforeEach, describe, expect, it } from "vitest";
import { killAllServers } from "../../../src/modules/shared/server-registry.js";
import { getTask } from "../../../src/modules/shared/task-registry.js";
import { registerOpencodeStartTask } from "../../../src/modules/tools/start_task.js";
import { fixture, handler } from "../../helpers/v2.js";

const run = handler(registerOpencodeStartTask);
beforeEach(killAllServers);
describe("start v2 task", () => {
  it("rejects missing server and malformed model", async () => {
    expect((await run({ server_id: "missing", prompt: "hi" })).status).toBe("server_not_found");
    fixture();
    for (const model of ["bad", "/model", "test/"])
      expect((await run({ server_id: "srv_test", prompt: "hi", model })).status).toBe(
        "invalid_model",
      );
  });
  it("creates the session at its explicit location, then admits a correlated prompt", async () => {
    const { fetch } = fixture();
    const result = await run({
      server_id: "srv_test",
      prompt: "hi",
      model: "test/model",
      agent: "build",
    });
    expect(result.status).toBe("pending");
    expect(getTask(result.task_id)?.inputId).toMatch(/^msg_/);
    const bodies = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0]).toMatchObject({
      location: { directory: "/project" },
      model: { providerID: "test", id: "model" },
      agent: "build",
    });
    expect(bodies[1]).toMatchObject({ id: getTask(result.task_id)?.inputId, text: "hi" });
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic test");
  });
  it("uses defaults when no agent or model is supplied", async () => {
    fixture();
    expect((await run({ server_id: "srv_test", prompt: "hi" })).status).toBe("pending");
  });
  it("rejects unavailable and disabled models before session creation", async () => {
    const { routes } = fixture();
    for (const model of ["test/unknown", "unknown/model"])
      expect((await run({ server_id: "srv_test", prompt: "hi", model })).status).toBe(
        "unknown_model",
      );
    routes.set("GET /api/model", { data: [{ id: "model", providerID: "test", enabled: false }] });
    expect((await run({ server_id: "srv_test", prompt: "hi", model: "test/model" })).status).toBe(
      "unknown_model",
    );
  });
  it("reports creation failures and does not hide uncertain prompt submissions", async () => {
    const { routes } = fixture();
    routes.set("POST /api/session", { data: {} });
    expect((await run({ server_id: "srv_test", prompt: "hi" })).message).toBe(
      "failed to create session",
    );
    routes.set("POST /api/session", 401);
    expect((await run({ server_id: "srv_test", prompt: "hi" })).isError).toBe(true);
    routes.set("POST /api/session", Response.json({ message: "invalid" }, { status: 400 }));
    expect((await run({ server_id: "srv_test", prompt: "hi" })).isError).toBe(true);
    routes.set("POST /api/session", { data: { id: "ses_test" } });
    routes.set("POST /api/session/ses_test/prompt", 401);
    const result = await run({ server_id: "srv_test", prompt: "hi" });
    expect(result.isError).toBe(true);
    expect(getTask(result.task_id)?.sessionId).toBe("ses_test");
  });
});
