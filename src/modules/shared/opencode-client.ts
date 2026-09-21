import type { OpenCodeClient, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client";
import { getServer } from "./server-registry.js";
import { getTask } from "./task-registry.js";

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      callID: string;
      tool: string;
      state: {
        status: "pending" | "running" | "completed" | "error";
        input: Record<string, unknown>;
      };
    };

export function clientForServer(serverId: string): OpenCodeClient | undefined {
  const server = getServer(serverId);
  return server?.client;
}

export function clientForTask(
  taskId: string,
): { client: OpenCodeClient; sessionId: string } | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const client = clientForServer(task.serverId);
  if (!client) return undefined;
  return { client, sessionId: task.sessionId };
}

export interface AssistantEntry {
  info: SessionMessageAssistant;
  parts: Part[];
}

export async function messages(
  client: OpenCodeClient,
  sessionId: string,
): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID: sessionId,
      limit: 100,
      ...(cursor ? { cursor } : { order: "asc" }),
    });
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("OpenCode returned a repeated message cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return result;
}

export function assistantEntry(info: SessionMessageAssistant): AssistantEntry {
  return {
    info,
    parts: info.content.map((part): Part => {
      if (part.type !== "tool") return { type: part.type, text: part.text };
      return {
        type: "tool",
        callID: part.id,
        tool: part.name,
        state: {
          status: part.state.status === "streaming" ? "pending" : part.state.status,
          input: part.state.status === "streaming" ? {} : part.state.input,
        },
      };
    }),
  };
}

export async function assistantEntries(
  client: OpenCodeClient,
  sessionId: string,
): Promise<AssistantEntry[]> {
  return (await messages(client, sessionId))
    .filter((message): message is SessionMessageAssistant => message.type === "assistant")
    .map(assistantEntry);
}

export function sessionParts(entries: AssistantEntry[]): Part[] {
  return entries.flatMap((entry) => entry.parts);
}
export async function lastAssistantEntry(
  client: OpenCodeClient,
  sessionId: string,
): Promise<AssistantEntry | undefined> {
  return (await assistantEntries(client, sessionId)).at(-1);
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "empty" | "cancelled";

export interface TaskProgress {
  /** Last ~500 chars of concatenated TextPart text from the last assistant message. */
  text_snippet: string;
  /** Count of ToolPart parts whose state.status is "completed". */
  tool_calls_completed: number;
  /** Completed tool calls that can mutate the workspace. */
  mutating_tool_calls: number;
  /** Distinct file paths touched by completed mutating tool calls. */
  files_touched: string[];
  /** Tool name of the last ToolPart whose state.status is "running" or "pending". */
  current_tool?: string;
  /** state.status of that tool part. */
  current_tool_status?: string;
}

export interface TaskStatusResult {
  task_id: string;
  status: TaskStatus;
  error?: string;
  progress?: TaskProgress;
}

const TEXT_SNIPPET_MAX_LENGTH = 500;

/** Native v2 mutation tools plus aliases emitted by compatibility plugins. */
const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "apply_patch",
  "shell",
  "bash",
  "subagent",
  "task",
]);

/**
 * Whether an assistant turn actually produced anything.
 *
 * A completed timestamp only says the turn ended, not that it did work: an
 * aborted or rejected turn carries a completed timestamp with no parts at all,
 * which is byte-for-byte indistinguishable from a task that succeeded quietly.
 */
export function hasWork(parts: Part[]): boolean {
  for (const part of parts) {
    if (part.type === "text" && part.text.trim() !== "") return true;
    if (part.type === "tool") return true;
  }
  return false;
}

/**
 * How long an idle session may stay without any assistant message before the
 * task is considered dead (e.g. the fire-and-forget prompt was rejected).
 */
export const PENDING_STALL_MS = 15_000;

/**
 * The workspace path a completed tool call wrote to, if it names one.
 *
 * Native write/edit inputs use `path`; compatibility plugins may use `filePath`.
 * Shell operations count as mutations but do not always expose affected paths.
 */
function touchedFilePath(input: { [key: string]: unknown }): string | undefined {
  const filePath = input.path ?? input.filePath;
  return typeof filePath === "string" && filePath !== "" ? filePath : undefined;
}

/**
 * Build a TaskProgress summary.
 *
 * `latest` is the current assistant turn — it drives the text snippet and the
 * in-flight tool. `whole` is every assistant part in the session and drives the
 * side-effect evidence, because an agent's edits land in earlier turns while
 * the final turn is usually just "DONE". Reading evidence off the last message
 * alone reports `files_touched: []` for a task that rewrote the workspace.
 */
export function buildProgress(latest: Part[], whole: Part[] = latest): TaskProgress {
  let text = "";
  let currentTool: string | undefined;
  let currentToolStatus: string | undefined;

  for (const part of latest) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    if (
      part.type === "tool" &&
      (part.state.status === "running" || part.state.status === "pending")
    ) {
      currentTool = part.tool;
      currentToolStatus = part.state.status;
    }
  }

  let toolCallsCompleted = 0;
  let mutatingToolCalls = 0;
  const filesTouched = new Set<string>();

  for (const part of whole) {
    if (part.type !== "tool" || part.state.status !== "completed") continue;
    toolCallsCompleted++;
    if (!MUTATING_TOOLS.has(part.tool)) continue;
    mutatingToolCalls++;
    const filePath = touchedFilePath(part.state.input);
    if (filePath !== undefined) filesTouched.add(filePath);
  }

  return {
    text_snippet: text.slice(-TEXT_SNIPPET_MAX_LENGTH),
    tool_calls_completed: toolCallsCompleted,
    mutating_tool_calls: mutatingToolCalls,
    files_touched: [...filesTouched],
    current_tool: currentTool,
    current_tool_status: currentToolStatus,
  };
}

/** Message returned alongside the `cancelled` status, shared by status and result. */
export const CANCELLED_TASK_MESSAGE =
  "the task was cancelled via opencode_cancel_task; any output below is whatever the agent produced before the abort";

/** Message returned alongside the `empty` status, shared by status and result. */
export const EMPTY_TURN_MESSAGE =
  "the session finished without producing any text or tool calls; the prompt was likely rejected or the turn was aborted";

export interface DeriveTaskStatusOptions {
  includeProgress?: boolean;
}

/** Correlate completion to this prompt, never to a previous completed turn. */
export async function taskSnapshot(client: OpenCodeClient, sessionId: string, taskId: string) {
  const task = getTask(taskId);
  const server = task && getServer(task.serverId);
  if (server?.permissionError) throw new Error(server.permissionError);
  const timeline = await messages(client, sessionId);
  const boundary = timeline.findIndex((message) => message.id === task?.inputId);
  const current = boundary < 0 ? [] : timeline.slice(boundary + 1);
  const entries = current
    .filter((message): message is SessionMessageAssistant => message.type === "assistant")
    .map(assistantEntry);
  const latest = entries.at(-1);
  const progress = buildProgress(latest?.parts ?? [], sessionParts(entries));
  const result =
    latest?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") || null;
  if (task?.cancelledAt !== undefined)
    return { status: "cancelled" as const, error: CANCELLED_TASK_MESSAGE, progress, result };
  // Fetch active last: an assistant turn completing is not the whole execution completing.
  const info = await client.session.get({ sessionID: sessionId });
  const active = await client.session.active();
  if (active[sessionId]) return { status: "running" as const, progress, result };
  // Permission rejection can terminate the current step without a session idle
  // projection. Only use errors from this input, and only after execution stops.
  if (latest?.info.error)
    return {
      status: latest.info.error.type === "aborted" ? ("cancelled" as const) : ("failed" as const),
      error: latest.info.error.message,
      progress,
      result,
    };
  const idle = current.filter((message) => message.type === "idle").at(-1);
  const input = timeline[boundary];
  const finishedAfterInput =
    input !== undefined &&
    info.time.idle !== undefined &&
    info.time.idle >= input.time.created &&
    info.time.idle > (task?.previousIdleAt ?? 0);
  const outcome = idle?.outcome ?? (finishedAfterInput ? info.outcome : undefined);
  if (boundary < 0 || !outcome) {
    if (
      task?.createdAt !== undefined &&
      Date.now() - task.createdAt > PENDING_STALL_MS &&
      entries.length === 0
    ) {
      return {
        status: "failed" as const,
        error: "task input was not executed; inspect the OpenCode session inbox",
        progress,
        result,
      };
    }
    return { status: "pending" as const, progress, result };
  }
  if (outcome === "failed")
    return {
      status: "failed" as const,
      error: "OpenCode execution failed",
      progress,
      result,
    };
  if (outcome === "interrupted")
    return {
      status: "cancelled" as const,
      error: "OpenCode execution was interrupted",
      progress,
      result,
    };
  if (!hasWork(sessionParts(entries)))
    return { status: "empty" as const, error: EMPTY_TURN_MESSAGE, progress, result };
  return { status: "completed" as const, progress, result };
}

export async function deriveTaskStatus(
  client: OpenCodeClient,
  sessionId: string,
  taskId: string,
  options?: DeriveTaskStatusOptions,
): Promise<TaskStatusResult> {
  const snapshot = await taskSnapshot(client, sessionId, taskId);
  return {
    task_id: taskId,
    status: snapshot.status,
    error: snapshot.error,
    ...(options?.includeProgress ? { progress: snapshot.progress } : {}),
  };
}
