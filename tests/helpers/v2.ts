import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OpenCode } from "@opencode/client";
import { vi } from "vitest";
import { registerServer } from "../../src/modules/shared/server-registry.js";
import { createFakeMcpServer } from "../../src/test-utils/fake-mcp-server.js";

export const user = { id: "msg_input", type: "user", time: { created: 1 }, text: "hello" };
export const idle = { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 3 } };
export const assistant = {
  id: "msg_answer",
  type: "assistant",
  time: { created: 2, completed: 3 },
  agent: "build",
  model: { providerID: "test", id: "model" },
  content: [{ type: "text", text: "done" }],
};

export function fixture() {
  const routes = new Map<string, unknown>([
    ["GET /api/agent", { data: [{ id: "build", name: "Build", mode: "primary", hidden: false }] }],
    ["GET /api/model", { data: [{ id: "model", providerID: "test", enabled: true }] }],
    ["GET /api/model/default", { data: { id: "model", providerID: "test" } }],
    ["GET /api/provider", { data: [{ id: "test", name: "Test" }] }],
    ["POST /api/session", { data: { id: "ses_test" } }],
    ["GET /api/session/active", { data: {} }],
    ["GET /api/session/ses_test/inbox", { data: [] }],
    ["GET /api/session/ses_test", { data: { id: "ses_test", time: {} } }],
    ["POST /api/session/ses_test/prompt", { data: { id: "msg_input" } }],
    ["POST /api/session/ses_test/interrupt", { interrupted: true }],
    ["POST /api/session/ses_test/agent", 204],
    ["POST /api/session/ses_test/model", 204],
    ["GET /api/session/ses_test/message", { data: [user, assistant, idle], cursor: {} }],
  ]);
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes.get(`${init?.method} ${url.pathname}`);
    if (route instanceof Error) throw route;
    if (typeof route === "number") return new Response(null, { status: route });
    if (route instanceof Response) return route.clone();
    if (route === undefined) throw new Error(`Missing test route: ${init?.method} ${url.pathname}`);
    return Response.json(route);
  });
  const client = OpenCode.make({
    baseUrl: "http://localhost:4096",
    headers: { authorization: "Basic test" },
    fetch: fetch as typeof globalThis.fetch,
  });
  registerServer({
    serverId: "srv_test",
    baseUrl: "http://localhost:4096",
    directory: "/project",
    client,
    close: vi.fn(),
  });
  return { client, routes, fetch };
}

export function handler(register: (server: McpServer) => void) {
  const fake = createFakeMcpServer();
  register(fake.server);
  return async (args: object) => {
    const result = (await fake.getHandler()(args)) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { ...JSON.parse(result.content[0].text), isError: result.isError };
  };
}
