import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServerConfig,
  DEFAULT_EXTERNAL_DIRECTORY_POLICY,
  decidePermission,
  getExternalDirectoryPolicy,
  startPermissionResponder,
} from "../../../src/modules/shared/permissions.js";
import { registerTask, removeTask } from "../../../src/modules/shared/task-registry.js";
import { assistant, fixture } from "../../helpers/v2.js";

describe("getExternalDirectoryPolicy", () => {
  const originalEnv = process.env.OPENCODE_MCP_EXTERNAL_DIR;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ["node", "server.js"];
    delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env.OPENCODE_MCP_EXTERNAL_DIR;
    else process.env.OPENCODE_MCP_EXTERNAL_DIR = originalEnv;
  });

  it("defaults to read-only", () => {
    expect(getExternalDirectoryPolicy()).toBe("read-only");
    expect(DEFAULT_EXTERNAL_DIRECTORY_POLICY).toBe("read-only");
  });

  it("reads the env var, case-insensitively and trimmed", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "  ALLOW ";
    expect(getExternalDirectoryPolicy()).toBe("allow");
  });

  it("falls back to the default for an unrecognised env value", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "yolo";
    expect(getExternalDirectoryPolicy()).toBe("read-only");
  });

  it("reads a CLI arg when the env var is absent", () => {
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=deny"];
    expect(getExternalDirectoryPolicy()).toBe("deny");
  });

  it("falls back to the default for an unrecognised CLI value", () => {
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=nope"];
    expect(getExternalDirectoryPolicy()).toBe("read-only");
  });

  it("prefers the env var over the CLI arg", () => {
    process.env.OPENCODE_MCP_EXTERNAL_DIR = "deny";
    process.argv = ["node", "server.js", "OPENCODE_MCP_EXTERNAL_DIR=allow"];
    expect(getExternalDirectoryPolicy()).toBe("deny");
  });
});

describe("v2 permissions", () => {
  const ask = {
    id: "per_test",
    sessionID: "ses_test",
    action: "external_directory",
    resources: ["/external/*"],
    source: { type: "tool" as const, messageID: "msg_answer", id: "call_test" },
  };
  it.each(["allow", "deny", "read-only"] as const)("builds native configuration %s", (policy) =>
    expect(buildServerConfig(policy)).toEqual({
      permissions: [
        {
          action: "external_directory",
          resource: "*",
          effect: policy === "read-only" ? "ask" : policy,
        },
      ],
    }));
  it("retains policy decisions without persisting external read approvals", async () => {
    const { client, routes } = fixture();
    expect((await decidePermission(client, { ...ask, action: "edit" }, "read-only")).response).toBe(
      "always",
    );
    expect((await decidePermission(client, ask, "allow")).response).toBe("always");
    expect((await decidePermission(client, ask, "deny")).response).toBe("reject");
    expect(
      (await decidePermission(client, { ...ask, source: undefined }, "read-only")).response,
    ).toBe("reject");
    expect(
      (await decidePermission(client, { ...ask, metadata: { command: "rm" } }, "read-only"))
        .response,
    ).toBe("reject");
    for (const name of ["read", "write"]) {
      routes.set("GET /api/session/ses_test/message/msg_answer", {
        data: {
          ...assistant,
          content: [
            { type: "text", text: "hi" },
            { type: "tool", id: "call_test", name, state: { status: "running", input: {} } },
          ],
        },
      });
      expect((await decidePermission(client, ask, "read-only")).response).toBe(
        name === "read" ? "once" : "reject",
      );
    }
    routes.set("GET /api/session/ses_test/message/msg_answer", { data: { type: "user" } });
    expect((await decidePermission(client, ask, "read-only")).response).toBe("reject");
  });
  it("polls missed requests, restricts ownership, recovers failures and aborts both loops", async () => {
    vi.useFakeTimers();
    const { client, routes } = fixture();
    registerTask({ taskId: "owner", serverId: "srv_test", sessionId: "ses_test" });
    const request = vi
      .spyOn(client.permission.request, "list")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        location: { directory: "/project" },
        data: [{ ...ask, action: "edit" }],
      });
    const reply = vi.spyOn(client.permission, "reply").mockResolvedValue(undefined);
    const onError = vi.fn(),
      onHealthy = vi.fn();
    vi.spyOn(client.event, "subscribe").mockImplementation(async function* () {
      yield { type: "server.connected" } as never;
      throw new Error("disconnect");
    });
    const responder = startPermissionResponder(client, {
      serverId: "srv_test",
      directory: "/project",
      policy: "read-only",
      onError,
      onHealthy,
    });
    await vi.advanceTimersByTimeAsync(1100);
    expect(onError).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      { sessionID: "ses_test", requestID: "per_test", decision: "always" },
      expect.anything(),
    );
    expect(onHealthy).toHaveBeenCalled();
    removeTask("owner");
    routes.set("GET /api/session/ses_test", { data: { id: "ses_test" } });
    reply.mockClear();
    await vi.advanceTimersByTimeAsync(1100);
    expect(reply).not.toHaveBeenCalled();
    responder.stop();
    await responder.done;
    expect(request).toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("answers events for descendant sessions and deduplicates concurrent replies", async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    registerTask({ taskId: "owner", serverId: "srv_test", sessionId: "parent" });
    vi.spyOn(client.session, "get").mockResolvedValue({ parentID: "parent" } as never);
    vi.spyOn(client.permission.request, "list").mockResolvedValue({
      location: { directory: "/project" },
      data: [{ ...ask, action: "edit" }],
    });
    vi.spyOn(client.event, "subscribe").mockImplementation(async function* () {
      yield { type: "permission.asked", data: { ...ask, action: "edit" } } as never;
    });
    const reply = vi
      .spyOn(client.permission, "reply")
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(undefined), 100)),
      );
    const responder = startPermissionResponder(client, {
      serverId: "srv_test",
      directory: "/project",
      policy: "read-only",
      onError: vi.fn(),
      onHealthy: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(reply).toHaveBeenCalledOnce();
    responder.stop();
    await responder.done;
    removeTask("owner");
    vi.useRealTimers();
  });
  it("rejects ancestry cycles and suppresses abort errors", async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    vi.spyOn(client.session, "get").mockResolvedValue({ parentID: "ses_test" } as never);
    vi.spyOn(client.permission.request, "list").mockResolvedValue({
      location: { directory: "/project" },
      data: [ask],
    });
    vi.spyOn(client.event, "subscribe").mockImplementation(async function* ({ signal } = {}) {
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("abort"))),
      );
    });
    const reply = vi.spyOn(client.permission, "reply");
    const onError = vi.fn();
    const responder = startPermissionResponder(client, {
      serverId: "none",
      directory: "/project",
      policy: "deny",
      onError,
      onHealthy: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1);
    responder.stop();
    await responder.done;
    expect(reply).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
it("suppresses polling errors caused by shutdown", async () => {
  const { client } = fixture();
  vi.spyOn(client.permission.request, "list").mockImplementation(
    (_input, { signal } = {}) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("abort"))),
      ),
  );
  vi.spyOn(client.event, "subscribe").mockImplementation(async function* () {});
  const onError = vi.fn();
  const responder = startPermissionResponder(client, {
    serverId: "none",
    directory: "/project",
    policy: "deny",
    onError,
    onHealthy: vi.fn(),
  });
  responder.stop();
  await responder.done;
  expect(onError).not.toHaveBeenCalled();
});
