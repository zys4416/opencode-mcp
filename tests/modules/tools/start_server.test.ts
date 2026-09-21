import { beforeEach, describe, expect, it, vi } from "vitest";
import { getServer, killAllServers } from "../../../src/modules/shared/server-registry.js";
import { handler } from "../../helpers/v2.js";

const mocks = vi.hoisted(() => ({ start: vi.fn(), responder: vi.fn() }));
vi.mock("../../../src/modules/shared/opencode-server.js", () => ({
  createOpencodeServer: mocks.start,
}));
vi.mock("../../../src/modules/shared/permissions.js", async (original) => ({
  ...(await original()),
  startPermissionResponder: mocks.responder,
}));

import { registerOpencodeStartServer } from "../../../src/modules/tools/start_server.js";

const run = handler(registerOpencodeStartServer);
beforeEach(() => {
  killAllServers();
  vi.resetAllMocks();
  mocks.responder.mockReturnValue({ stop: vi.fn() });
});
describe("private v2 server tool", () => {
  it.each([undefined, 0, 5000])("registers one authenticated client (%s)", async (port) => {
    const close = vi.fn();
    const client = {};
    mocks.start.mockResolvedValue({ url: "http://127.0.0.1:4096", client, close });
    const result = await run({ port });
    expect(result.status).toBe("running");
    expect(result.baseUrl).toBe("http://127.0.0.1:4096");
    expect(getServer(result.server_id)?.client).toBe(client);
    expect(mocks.start).toHaveBeenCalledWith({
      port: port ?? 0,
      config: { permissions: [{ action: "external_directory", resource: "*", effect: "ask" }] },
    });
    const opts = mocks.responder.mock.calls[0][1];
    opts.onError(new Error("secret"));
    expect(getServer(result.server_id)?.permissionError).not.toContain("secret");
    opts.onHealthy();
    expect(getServer(result.server_id)?.permissionError).toBeUndefined();
    killAllServers();
    opts.onError(new Error("later"));
    opts.onHealthy();
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([new Error("failed"), "failed"])("returns startup errors %s", async (error) => {
    mocks.start.mockRejectedValue(error);
    expect((await run({})).isError).toBe(true);
  });
});
