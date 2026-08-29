import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Part } from "@opencode-ai/sdk";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import {
  assistantEntries,
  buildProgress,
  CANCELLED_TASK_MESSAGE,
  clientForTask,
  EMPTY_TURN_MESSAGE,
  hasWork,
  sessionParts,
} from "../shared/opencode-client.js";
import { getTask } from "../shared/task-registry.js";

/** Concatenate every TextPart in a turn, in order. */
function joinText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function registerOpencodeGetTaskResult(server: McpServer) {
  server.registerTool(
    "opencode_get_task_result",
    {
      description: "Get the final result of a completed task",
      inputSchema: {
        task_id: z.string().describe("Id of the task to fetch the result for"),
      },
    },
    async ({ task_id }) => {
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "not_found" });
      }
      const { client, sessionId } = resolved;

      try {
        const entries = await assistantEntries(client, sessionId);
        const entry = entries.at(-1);

        // An aborted session keeps its completed timestamp, so without this a
        // deliberately killed task reads as a normal success.
        if (getTask(task_id)?.cancelledAt !== undefined) {
          const text = joinText(entry?.parts ?? []);
          return jsonResult({
            task_id,
            status: "cancelled",
            result: text === "" ? null : text,
            message: CANCELLED_TASK_MESSAGE,
            progress: buildProgress(entry?.parts ?? [], sessionParts(entries)),
          });
        }

        if (!entry) {
          return jsonResult({ task_id, status: "pending", result: null });
        }
        if (entry.info.error) {
          return jsonResult({
            task_id,
            status: "failed",
            error: entry.info.error.name,
            result: null,
          });
        }
        if (!entry.info.time.completed) {
          return jsonResult({ task_id, status: "running", result: null });
        }

        // Side-effect evidence, not just text: `completed` with an empty
        // files_touched on a task whose whole purpose was writing files is the
        // signal a caller needs to catch a no-op before building on top of it.
        const progress = buildProgress(entry.parts, sessionParts(entries));

        if (!hasWork(entry.parts)) {
          return jsonResult({
            task_id,
            status: "empty",
            result: null,
            message: EMPTY_TURN_MESSAGE,
            progress,
          });
        }

        return jsonResult({
          task_id,
          status: "completed",
          result: joinText(entry.parts),
          progress,
        });
      } catch (error) {
        return jsonError({
          task_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
