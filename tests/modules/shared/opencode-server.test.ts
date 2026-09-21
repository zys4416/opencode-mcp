import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), version: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawn(...args),
  execFile: (
    _binary: unknown,
    _args: unknown,
    _opts: unknown,
    callback: (error: unknown, stdout?: object) => void,
  ) => callback(null, { stdout: mocks.version() }),
}));

import { createOpencodeServer } from "../../../src/modules/shared/opencode-server.js";

function processFixture(output = '{"url":"http://127.0.0.1:4096"}\n') {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: { resume: vi.fn() },
    kill: vi.fn(),
  });
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => child.stdout.emit("data", Buffer.from(output)));
    return child;
  });
  return child;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.version.mockReturnValue("opencode v2.0.11\n");
  vi.stubEnv("OPENCODE_BIN", "");
  vi.stubEnv("OPENCODE_PASSWORD", "");
  vi.stubEnv("OPENCODE_SERVER_PASSWORD", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ version: "2.0.11", pid: 123, urls: [], paths: { tmp: "/tmp" } }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("v2 process lifecycle", () => {
  it.each([
    "opencode v2.0.11\n",
    "v2.0.11",
    "2.0.11",
  ])("accepts the pinned binary version %s", async (version) => {
    mocks.version.mockReturnValue(version);
    const child = processFixture();
    const instance = await createOpencodeServer({ port: 4096, config: { permissions: [] } });
    expect(instance.url).toBe("http://127.0.0.1:4096");
    expect(mocks.spawn.mock.calls[0][1]).toContain("--stdio");
    const env = mocks.spawn.mock.calls[0][2].env;
    expect(env.OPENCODE_PASSWORD.length).toBeGreaterThan(30);
    expect(JSON.stringify(instance)).not.toContain(env.OPENCODE_PASSWORD);
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")}`,
    );
    instance.close();
    instance.close();
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(2100);
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
  it("prefers explicit credentials and binary, accepts OS-assigned ports", async () => {
    vi.stubEnv("OPENCODE_PASSWORD", "chosen");
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "legacy");
    vi.stubEnv("OPENCODE_BIN", "/custom/opencode");
    const child = processFixture('{"url":"http://127.0.0.1:51234"}\n');
    const instance = await createOpencodeServer({ port: 0, config: {} });
    expect(mocks.spawn.mock.calls[0][0]).toBe("/custom/opencode");
    expect(mocks.spawn.mock.calls[0][2].env.OPENCODE_PASSWORD).toBe("chosen");
    await instance.client.server.info(); // exercise the default request timeout
    instance.close();
    await vi.advanceTimersByTimeAsync(2100);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("honors the legacy password name and handles split handshake lines", async () => {
    vi.stubEnv("OPENCODE_SERVER_PASSWORD", "legacy");
    const child = processFixture('log line\n{"other":true}\n{"url":');
    const pending = createOpencodeServer({ port: 4096, config: {} });
    await vi.advanceTimersByTimeAsync(1);
    child.stdout.emit("data", Buffer.from('"http://127.0.0.1:4096"}\n'));
    const instance = await pending;
    expect(mocks.spawn.mock.calls[0][2].env.OPENCODE_PASSWORD).toBe("legacy");
    child.stdin.emit("error", new Error("closed"));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    instance.close();
    child.emit("exit", 0);
  });
  it("rejects unsupported binaries without starting a server", async () => {
    mocks.version.mockReturnValue("1.18.31");
    await expect(createOpencodeServer({ port: 4096, config: {} })).rejects.toThrow("Unsupported");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it.each([
    "https://127.0.0.1:4096",
    "http://remote:4096",
    "http://user:password@127.0.0.1:4096",
    "http://:password@127.0.0.1:4096",
    "http://127.0.0.1:5555",
  ])("rejects unexpected handshake addresses %s", async (url) => {
    const child = processFixture(`${JSON.stringify({ url })}\n`);
    await expect(createOpencodeServer({ port: 4096, config: {} })).rejects.toThrow("address");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 1);
  });
  it.each([
    "timeout",
    "overflow",
    "error",
    "exit",
  ])("cleans up startup failure %s", async (failure) => {
    const child = processFixture(
      failure === "overflow" ? "x".repeat(65537) : '{"url":"invalid"}\n',
    );
    const pending = createOpencodeServer({ port: 4096, config: {}, timeout: 20 });
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    if (failure === "error") child.emit("error", new Error("private information"));
    if (failure === "exit") child.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 1);
  });
  it.each([
    { version: "2.0.12", pid: 123 },
    { version: "2.0.11", pid: 999 },
  ])("rejects mismatched service identity %o", async (info) => {
    const child = processFixture();
    vi.mocked(fetch).mockResolvedValue(Response.json(info));
    await expect(createOpencodeServer({ port: 4096, config: {} })).rejects.toThrow("identity");
    child.emit("exit", 1);
  });
  it("does not register a server whose authentication fails", async () => {
    const child = processFixture();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));
    await expect(createOpencodeServer({ port: 4096, config: {} })).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 1);
  });
});
