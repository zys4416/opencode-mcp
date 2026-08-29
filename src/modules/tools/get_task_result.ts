import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import {
  assistantEntries,
  buildProgress,
  clientForTask,
  EMPTY_TURN_MESSAGE,
  hasWork,
  sessionParts,
} from "../shared/opencode-client.js";

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

        const text = entry.parts
          .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("");

        return jsonResult({ task_id, status: "completed", result: text, progress });
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
