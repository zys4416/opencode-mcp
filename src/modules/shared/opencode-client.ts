import {
  type AssistantMessage,
  createOpencodeClient,
  type OpencodeClient,
  type Part,
} from "@opencode-ai/sdk";
import { getServer } from "./server-registry.js";
import { getTask } from "./task-registry.js";

/** Build an HTTP client for a tracked server, or undefined if the id is unknown. */
export function clientForServer(serverId: string): OpencodeClient | undefined {
  const server = getServer(serverId);
  if (!server) return undefined;
  return createOpencodeClient({ baseUrl: server.baseUrl });
}

/** Resolve a task to its server client and session id, or undefined if unknown. */
export function clientForTask(
  taskId: string,
): { client: OpencodeClient; sessionId: string } | undefined {
  const task = getTask(taskId);
  if (!task) return undefined;
  const client = clientForServer(task.serverId);
  if (!client) return undefined;
  return { client, sessionId: task.sessionId };
}

export interface AssistantEntry {
  info: AssistantMessage;
  parts: Part[];
}

/** Fetch every assistant message (with its parts) for a session, oldest first. */
export async function assistantEntries(
  client: OpencodeClient,
  sessionId: string,
): Promise<AssistantEntry[]> {
  const res = await client.session.messages({ path: { id: sessionId } });
  const entries: AssistantEntry[] = [];
  for (const message of res.data ?? []) {
    if (message.info.role === "assistant") {
      entries.push({ info: message.info, parts: message.parts });
    }
  }
  return entries;
}

/** Every part the assistant emitted across the whole session, oldest first. */
export function sessionParts(entries: AssistantEntry[]): Part[] {
  return entries.flatMap((entry) => entry.parts);
}

/** Fetch the most recent assistant message (with its parts) for a session. */
export async function lastAssistantEntry(
  client: OpencodeClient,
  sessionId: string,
): Promise<AssistantEntry | undefined> {
  return (await assistantEntries(client, sessionId)).at(-1);
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "empty";

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

/**
 * Tools that can change the workspace. Verified against the live tool catalog
 * (`client.tool.ids()` on opencode 1.18.18): the patch tool is `apply_patch`,
 * and there is no `list` tool. `task` delegates to a subagent, which can write
 * through any of the others.
 */
const MUTATING_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "task"]);

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
 * Verified against a live server: `write` and `edit` carry the path as
 * `state.input.filePath`; `bash` carries only `command`, so it counts as
 * mutating without contributing a path.
 */
function touchedFilePath(input: { [key: string]: unknown }): string | undefined {
  const filePath = input.filePath;
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

/** Message returned alongside the `empty` status, shared by status and result. */
export const EMPTY_TURN_MESSAGE =
  "the session finished without producing any text or tool calls; the prompt was likely rejected or the turn was aborted";

export interface DeriveTaskStatusOptions {
  includeProgress?: boolean;
}

/**
 * Derive the current status of a task by inspecting session busy state and
 * the last assistant message. Shared by opencode_get_task_status and
 * opencode_wait_for_task so both use identical status derivation.
 */
export async function deriveTaskStatus(
  client: OpencodeClient,
  sessionId: string,
  taskId: string,
  options?: DeriveTaskStatusOptions,
): Promise<TaskStatusResult> {
  const includeProgress = options?.includeProgress ?? false;

  // The status map only lists sessions that are actively working.
  const statusRes = await client.session.status();
  const sessionStatus = statusRes.data?.[sessionId];
  if (sessionStatus?.type === "busy" || sessionStatus?.type === "retry") {
    if (includeProgress) {
      const entries = await assistantEntries(client, sessionId);
      const latest = entries.at(-1);
      return {
        task_id: taskId,
        status: "running",
        progress: latest ? buildProgress(latest.parts, sessionParts(entries)) : undefined,
      };
    }
    return { task_id: taskId, status: "running" };
  }

  // Not busy: inspect the last assistant message to tell pending from done.
  const entries = await assistantEntries(client, sessionId);
  const entry = entries.at(-1);
  if (!entry) {
    // Idle session with no assistant output: either the prompt was just accepted,
    // or it was silently rejected (fire-and-forget) and will never run. Past the
    // stall window, report failure instead of leaving the task pending forever.
    const task = getTask(taskId);
    if (task?.createdAt !== undefined && Date.now() - task.createdAt > PENDING_STALL_MS) {
      return {
        task_id: taskId,
        status: "failed",
        error:
          "task produced no output after starting; the prompt was likely rejected (e.g. invalid model or agent)",
      };
    }
    return { task_id: taskId, status: "pending" };
  }
  if (entry.info.error) {
    return { task_id: taskId, status: "failed", error: entry.info.error.name };
  }
  if (entry.info.time.completed) {
    // A completed timestamp is not a work check. An assistant turn that ended
    // with no text and no tool calls did nothing, and reporting that as
    // `completed` is what lets a caller build on top of unchanged files.
    if (!hasWork(entry.parts)) {
      return {
        task_id: taskId,
        status: "empty",
        error: EMPTY_TURN_MESSAGE,
        progress: includeProgress ? buildProgress(entry.parts, sessionParts(entries)) : undefined,
      };
    }
    return {
      task_id: taskId,
      status: "completed",
      progress: includeProgress ? buildProgress(entry.parts, sessionParts(entries)) : undefined,
    };
  }
  return {
    task_id: taskId,
    status: "running",
    progress: includeProgress ? buildProgress(entry.parts, sessionParts(entries)) : undefined,
  };
}
