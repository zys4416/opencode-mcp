import type { OpenCodeClient, PermissionReply, PermissionRequest } from "@opencode/client";
import { ownsSession } from "./task-registry.js";

/**
 * How the delegated agent may touch paths outside the directory the server was
 * launched in.
 *
 * - `read-only` (default): reads outside the cwd are approved, writes are rejected.
 * - `allow`: no boundary at all — anything outside the cwd is approved.
 * - `deny`: nothing outside the cwd is reachable.
 */
export type ExternalDirectoryPolicy = "read-only" | "allow" | "deny";

export const DEFAULT_EXTERNAL_DIRECTORY_POLICY: ExternalDirectoryPolicy = "read-only";

/** The permission type OpenCode raises for any path outside the server cwd. */
export const EXTERNAL_DIRECTORY = "external_directory";

/**
 * Tools that only observe. OpenCode raises a single `external_directory`
 * permission for reads and writes alike, so the operation has to be recovered
 * from the tool that triggered it. Names verified against the live catalog
 * (`client.tool.ids()` on opencode 1.18.18) — there is no `list` tool.
 */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "webfetch", "websearch"]);

/** Delay before re-subscribing after the event stream drops. */
const RECONNECT_DELAY_MS = 1_000;

/** Attempts to correlate a permission to its tool call before giving up. */

/** Delay between correlation attempts, covering the event/message write race. */

const POLICIES: ReadonlySet<string> = new Set<ExternalDirectoryPolicy>([
  "read-only",
  "allow",
  "deny",
]);

/**
 * Resolve the external-directory policy.
 *
 * Precedence: the `OPENCODE_MCP_EXTERNAL_DIR` environment variable wins over an
 * `OPENCODE_MCP_EXTERNAL_DIR=<policy>` CLI arg, which wins over `read-only`.
 * Unrecognised values fall back to the default.
 *
 * Reads `process.env` / `process.argv` lazily on each call so tests can vary
 * them between invocations without module re-import tricks.
 */
export function getExternalDirectoryPolicy(): ExternalDirectoryPolicy {
  const fromEnv = parsePolicy(process.env.OPENCODE_MCP_EXTERNAL_DIR);
  if (fromEnv !== undefined) return fromEnv;

  const argPrefix = "OPENCODE_MCP_EXTERNAL_DIR=";
  const argEntry = process.argv.find((arg) => arg.startsWith(argPrefix));
  if (argEntry !== undefined) {
    const fromArg = parsePolicy(argEntry.slice(argPrefix.length));
    if (fromArg !== undefined) return fromArg;
  }

  return DEFAULT_EXTERNAL_DIRECTORY_POLICY;
}

function parsePolicy(value: string | undefined): ExternalDirectoryPolicy | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!POLICIES.has(normalized)) return undefined;
  return normalized as ExternalDirectoryPolicy;
}

/** Only override the external-directory policy; preserve other configured rules. */
export function buildServerConfig(policy: ExternalDirectoryPolicy) {
  return {
    permissions: [
      {
        action: EXTERNAL_DIRECTORY,
        resource: "*",
        effect: policy === "read-only" ? "ask" : policy,
      },
    ],
  };
}

export async function decidePermission(
  client: OpenCodeClient,
  ask: PermissionRequest,
  policy: ExternalDirectoryPolicy,
): Promise<{ response: PermissionReply; reason: string }> {
  if (ask.action !== EXTERNAL_DIRECTORY)
    return { response: "always", reason: "delegated session permission" };
  if (policy === "allow")
    return { response: "always", reason: "external_directory policy is allow" };
  if (policy === "deny") return { response: "reject", reason: "external_directory policy is deny" };
  if (!ask.source || ask.metadata?.command !== undefined)
    return { response: "reject", reason: "unidentified external operation" };
  const source = ask.source;
  const message = await client.session.message.get({
    sessionID: ask.sessionID,
    messageID: source.messageID,
  });
  const tool =
    message.type === "assistant"
      ? message.content.find((part) => part.type === "tool" && part.id === source.id)
      : undefined;
  const readOnly = tool?.type === "tool" && READ_ONLY_TOOLS.has(tool.name);
  return {
    response: readOnly ? "once" : "reject",
    reason: readOnly ? "external read" : "external write or unknown tool",
  };
}

export interface PermissionResponderOptions {
  policy: ExternalDirectoryPolicy;
  serverId: string;
  directory: string;
  onError: (error: unknown) => void;
  onHealthy: () => void;
}

/** SSE for latency, bounded polling for missed events. Never answer unrelated CLI sessions. */
export function startPermissionResponder(
  client: OpenCodeClient,
  options: PermissionResponderOptions,
) {
  const controller = new AbortController();
  const { signal } = controller;
  const inFlight = new Set<string>();
  const isOwned = async (sessionId: string): Promise<boolean> => {
    let id: string | undefined = sessionId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      if (ownsSession(options.serverId, id)) return true;
      seen.add(id);
      id = (await client.session.get({ sessionID: id }, { signal })).parentID;
    }
    return false;
  };
  const answer = async (ask: PermissionRequest) => {
    if (inFlight.has(ask.id)) return;
    inFlight.add(ask.id);
    try {
      if (!(await isOwned(ask.sessionID))) return;
      const decision = await decidePermission(client, ask, options.policy);
      await client.permission.reply(
        { sessionID: ask.sessionID, requestID: ask.id, decision: decision.response },
        { signal },
      );
    } finally {
      inFlight.delete(ask.id);
    }
  };
  const pause = () =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, RECONNECT_DELAY_MS);
      signal.addEventListener("abort", finish, { once: true });
    });
  const events = (async () => {
    while (!signal.aborted) {
      try {
        for await (const event of client.event.subscribe({ signal })) {
          if (event.type === "permission.asked") await answer(event.data);
        }
      } catch (error) {
        if (!signal.aborted) options.onError(error);
      }
      await pause();
    }
  })();
  const poll = (async () => {
    while (!signal.aborted) {
      try {
        const requests = await client.permission.request.list(
          { location: { directory: options.directory } },
          { signal },
        );
        for (const ask of requests.data) await answer(ask);
        options.onHealthy();
      } catch (error) {
        if (!signal.aborted) options.onError(error);
      }
      await pause();
    }
  })();
  const done = Promise.allSettled([events, poll]).then(() => undefined);
  return { stop: () => controller.abort(), done };
}
