import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask, taskSnapshot } from "../shared/opencode-client.js";

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
        const snapshot = await taskSnapshot(client, sessionId, task_id);
        return jsonResult({ task_id, ...snapshot });
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
