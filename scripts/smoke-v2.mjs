// Isolated real-binary integration test. The model provider runs on loopback;
// no user configuration, credentials or paid model requests are used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenCode } from "@opencode/client";
import { getServer, killAllServers } from "../build/src/modules/shared/server-registry.js";
import { registerOpencodeCancelTask } from "../build/src/modules/tools/cancel_task.js";
import { registerOpencodeContinueTask } from "../build/src/modules/tools/continue_task.js";
import { registerOpencodeGetTaskResult } from "../build/src/modules/tools/get_task_result.js";
import { registerOpencodeGetTaskStatus } from "../build/src/modules/tools/get_task_status.js";
import { registerOpencodeListAgents } from "../build/src/modules/tools/list_agents.js";
import { registerOpencodeStartServer } from "../build/src/modules/tools/start_server.js";
import { registerOpencodeStartTask } from "../build/src/modules/tools/start_task.js";
import { registerOpencodeWaitForTask } from "../build/src/modules/tools/wait_for_task.js";

const root = await mkdtemp(join(tmpdir(), "opencode-mcp-v2-"));
const outside = await mkdtemp(join(tmpdir(), "opencode-mcp-external-"));
await writeFile(join(outside, "read.txt"), "external fixture");
const observerAbort = new AbortController();
const events = [];
const prior = process.cwd();
for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"])
  process.env[key] = join(root, key);
Object.assign(process.env, {
  OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_PASSWORD: "integration-only-password",
  OPENCODE_MCP_CACHE_DIR: join(root, "cache"),
});
for (const key of [
  "OPENCODE_CONFIG",
  "OPENCODE_SIMULATE",
  "OPENCODE_DRIVE",
  "OPENCODE_CONFIG_CONTENT",
])
  delete process.env[key];
await mkdir(process.env.OPENCODE_CONFIG_DIR);
// Avoid quota-doc HTTP requests in this test.
await mkdir(process.env.OPENCODE_MCP_CACHE_DIR);
await writeFile(
  join(process.env.OPENCODE_MCP_CACHE_DIR, "usage-limits.json"),
  JSON.stringify({
    source: "local-fixture",
    fetchedAt: new Date().toISOString(),
    models: [{ model: "fixture", perFiveHours: null }],
    spendBudget: { fiveHours: null, weekly: null, monthly: null },
  }),
);
let modelCalls = 0;
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelCalls++;
  const lastUser = body.messages?.filter((m) => m.role === "user").at(-1);
  const input = JSON.stringify(lastUser?.content);
  if (input?.includes("WAIT_FOR_CANCEL")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": waiting\n\n");
    return;
  }
  const needsWrite =
    (input?.includes("WRITE_FIXTURE") || input?.includes("EXTERNAL_")) &&
    !body.messages.some((m) => m.role === "tool");
  const text = input?.includes("FOLLOW_UP") ? "SECOND_RESULT" : "FIRST_RESULT";
  const delta = needsWrite
    ? {
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: {
              name: input.includes("EXTERNAL_READ") ? "read" : "write",
              arguments: JSON.stringify(
                input.includes("EXTERNAL_READ")
                  ? { path: join(outside, "read.txt") }
                  : {
                      path: input.includes("EXTERNAL_WRITE")
                        ? join(outside, "blocked.txt")
                        : join(root, "result.txt"),
                      content: "fixture written",
                    },
              ),
            },
          },
        ],
      }
    : { content: text };
  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of [{ ...delta, role: "assistant" }, {}])
      res.write(
        `data: ${JSON.stringify({ id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: item, finish_reason: Object.keys(item).length ? null : needsWrite ? "tool_calls" : "stop" }] })}\n\n`,
      );
    res.end("data: [DONE]\n\n");
  } else {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "chat_fixture",
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const config = {
  model: "fixture/fixture",
  providers: {
    fixture: {
      name: "Fixture",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture" },
      models: { fixture: { name: "Fixture", limit: { context: 100000, output: 4096 } } },
    },
  },
};
await writeFile(join(process.env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify(config));
function tool(register) {
  let handler;
  register({
    registerTool(_name, _config, fn) {
      handler = fn;
    },
  });
  return async (args) => {
    const value = await handler(args);
    const data = JSON.parse(value.content[0].text);
    if (value.isError) throw new Error(JSON.stringify(data));
    return data;
  };
}
const start = tool(registerOpencodeStartServer),
  task = tool(registerOpencodeStartTask),
  follow = tool(registerOpencodeContinueTask),
  cancel = tool(registerOpencodeCancelTask),
  status = tool(registerOpencodeGetTaskStatus),
  result = tool(registerOpencodeGetTaskResult),
  catalog = tool(registerOpencodeListAgents),
  wait = tool(registerOpencodeWaitForTask);
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(200);
  }
  throw new Error("Integration condition timed out");
}
try {
  process.chdir(root);
  const started = await start({});
  const record = getServer(started.server_id);
  assert.equal((await fetch(`${started.baseUrl}/api/info`)).status, 401);
  assert.equal(
    (await fetch(`${started.baseUrl}/api/info`, { headers: { authorization: "Basic wrong" } }))
      .status,
    401,
  );
  const observer = OpenCode.make({
    baseUrl: started.baseUrl,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
    },
  });
  assert.equal((await observer.server.info()).version, "2.0.11");
  await assert.rejects(start({ port: Number(new URL(started.baseUrl).port) }));
  assert.equal((await observer.server.info()).version, "2.0.11");
  const observing = (async () => {
    try {
      for await (const event of observer.event.subscribe({ signal: observerAbort.signal }))
        events.push(event);
    } catch (error) {
      if (!observerAbort.signal.aborted) throw error;
    }
  })();
  await until(async () => events.some((event) => event.type === "server.connected"));
  await until(async () => {
    const c = await catalog({ server_id: started.server_id });
    return (
      c.agents.available.some((a) => a.name === "build") &&
      c.models.providers.some((p) => p.provider === "fixture" && p.models.length)
    );
  });
  const created = await task({
    server_id: started.server_id,
    prompt: "WRITE_FIXTURE",
    agent: "build",
    model: "fixture/fixture",
  });
  console.log("Task admitted; waiting for local fixture model");
  await until(async () => {
    const s = await status({ task_id: created.task_id, include_progress: true });
    if (s.status === "failed") throw new Error(JSON.stringify(s));
    return s.status === "completed";
  });
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "fixture written");
  assert.equal((await result({ task_id: created.task_id })).result, "FIRST_RESULT");
  const visible = await observer.message.list({ sessionID: created.session_id });
  assert(visible.data.length > 0);
  assert(
    events.some(
      (event) => event.type === "session.text.delta" && event.data.sessionID === created.session_id,
    ),
  );
  const cli = await promisify(execFile)(
    process.env.OPENCODE_BIN || "opencode",
    ["api", "--server", started.baseUrl, "GET", `/api/session/${created.session_id}`],
    { timeout: 10000 },
  );
  assert(cli.stdout.includes(created.session_id));
  for (const kind of ["EXTERNAL_READ", "EXTERNAL_WRITE"]) {
    const externalTask = await task({
      server_id: started.server_id,
      prompt: kind,
      agent: "build",
      model: "fixture/fixture",
    });
    await until(async () => {
      const state = await status({ task_id: externalTask.task_id, include_progress: true });
      if (kind === "EXTERNAL_READ" && ["failed", "cancelled", "empty"].includes(state.status))
        throw new Error(`${kind}: ${JSON.stringify(state)}`);
      return (
        state.status === "completed" || (kind === "EXTERNAL_WRITE" && state.status === "cancelled")
      );
    }).catch(async (error) => {
      console.log(
        "External diagnostics",
        kind,
        JSON.stringify({
          session: await observer.session.get({ sessionID: externalTask.session_id }),
          active: await observer.session.active(),
          status: await status({ task_id: externalTask.task_id }),
          messages: await observer.message.list({ sessionID: externalTask.session_id }),
        }),
      );
      throw error;
    });
    const timeline = await observer.message.list({ sessionID: externalTask.session_id });
    const call = timeline.data
      .filter((message) => message.type === "assistant")
      .flatMap((message) => message.content)
      .find((part) => part.type === "tool");
    assert.equal(call.state.status, kind === "EXTERNAL_READ" ? "completed" : "error");
  }
  await assert.rejects(readFile(join(outside, "blocked.txt")));
  await follow({ task_id: created.task_id, prompt: "FOLLOW_UP" });
  const next = await until(async () => {
    const r = await result({ task_id: created.task_id });
    return r.status === "completed" && r.result === "SECOND_RESULT" ? r : false;
  });
  assert.equal(next.result, "SECOND_RESULT");
  const slow = await task({
    server_id: started.server_id,
    prompt: "WAIT_FOR_CANCEL",
    agent: "build",
    model: "fixture/fixture",
  });
  await until(async () => (await status({ task_id: slow.task_id })).status === "running");
  await cancel({ task_id: slow.task_id });
  assert.equal((await status({ task_id: slow.task_id })).status, "cancelled");
  await wait({ task_ids: [slow.task_id], mode: "all", timeout_ms: 500, poll_interval_ms: 500 });
  // Permission polling must handle a request admitted after event subscription.
  await observer.permission.create({
    sessionID: created.session_id,
    action: "edit",
    resources: [join(root, "permission-test")],
  });
  assert(modelCalls > 0);
  const pid = (await observer.server.info()).pid;
  observerAbort.abort();
  await observing;
  record.close();
  killAllServers();
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  const mcp = new Client({ name: "integration", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(prior, "build/src/index.js")],
    cwd: root,
    env: process.env,
    stderr: "pipe",
  });
  try {
    await mcp.connect(transport);
    assert.equal((await mcp.listTools()).tools.length, 9);
    const reply = await mcp.callTool({ name: "opencode_start_server", arguments: { port: 0 } });
    assert(!reply.isError);
    const launched = JSON.parse(reply.content[0].text);
    const info = await fetch(`${launched.baseUrl}/api/info`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
      },
    }).then((r) => r.json());
    await mcp.close();
    await until(async () => {
      try {
        process.kill(info.pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    await mcp.close();
  }
  console.log(
    "PASS: v2 authentication, catalog, write task, observer, follow-up, cancellation, permissions and process cleanup",
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  observerAbort.abort();
  killAllServers();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await sleep(2200);
  process.chdir(prior);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
