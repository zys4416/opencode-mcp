import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { OpenCode, type OpenCodeClient } from "@opencode/client";

export const SUPPORTED_VERSION = "2.0.11";

/** A private HTTP server whose lease is the child's stdin. Never attach on port conflicts. */
export async function createOpencodeServer(options: {
  port: number;
  config: object;
  timeout?: number;
}): Promise<{ url: string; client: OpenCodeClient; close: () => void }> {
  const binary = process.env.OPENCODE_BIN || "opencode";
  const version = await promisify(execFile)(binary, ["--version"], { timeout: 5000 });
  if (
    version.stdout
      .trim()
      .replace(/^opencode\s+v?/, "")
      .replace(/^v/, "") !== SUPPORTED_VERSION
  ) {
    throw new Error(`Unsupported OpenCode version; this build requires ${SUPPORTED_VERSION}`);
  }
  const password =
    process.env.OPENCODE_PASSWORD ||
    process.env.OPENCODE_SERVER_PASSWORD ||
    randomBytes(32).toString("base64url");
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const controller = new AbortController();
  const child = spawn(
    binary,
    ["serve", "--stdio", "--hostname=127.0.0.1", `--port=${options.port}`],
    {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      },
    },
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    child.stdin.end();
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    force.unref();
    child.once("exit", () => clearTimeout(force));
  };
  // Never forward child output: it may contain credentials or user configuration.
  child.stderr.resume();
  child.stdin.on("error", () => close());
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for OpenCode server")),
        options.timeout ?? 30000,
      );
      let buffer = "";
      const finish = (error?: Error, url?: string) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(url as string);
      };
      child.once("error", () => finish(new Error("Could not start OpenCode server")));
      child.once("exit", (code) => {
        controller.abort();
        finish(new Error(`OpenCode server exited (code ${code})`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 65536) return finish(new Error("Invalid OpenCode startup output"));
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (typeof message.url === "string") {
              const parsed = new URL(message.url);
              if (
                parsed.protocol !== "http:" ||
                parsed.hostname !== "127.0.0.1" ||
                parsed.username ||
                parsed.password ||
                (options.port !== 0 && parsed.port !== String(options.port))
              ) {
                return finish(new Error("Invalid OpenCode server address"));
              }
              finish(undefined, parsed.origin);
            }
          } catch {
            /* Ignore non-handshake log lines. */
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    const client = OpenCode.make({
      baseUrl: url,
      headers: { authorization },
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([controller.signal, init?.signal ?? AbortSignal.timeout(30000)]),
        }),
    });
    const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
    if (info.version !== SUPPORTED_VERSION || info.pid !== child.pid)
      throw new Error("OpenCode server identity mismatch");
    return { url, client, close };
  } catch (error) {
    close();
    throw error;
  }
}
