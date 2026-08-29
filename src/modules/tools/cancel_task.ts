import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";
import { markTaskCancelled } from "../shared/task-registry.js";

export function registerOpencodeCancelTask(server: McpServer) {
  server.registerTool(
    "opencode_cancel_task",
    {
      description: "Cancel a delegated task by aborting its OpenCode session",
      inputSchema: {
        task_id: z.string().describe("Id of the task to cancel"),
      },
    },
    async ({ task_id }) => {
      const resolved = clientForTask(task_id);
      if (!resolved) {
        return jsonError({ task_id, status: "task_not_found" });
      }
      const { client, sessionId } = resolved;

      try {
        await client.session.abort({ path: { id: sessionId } });
        // Aborting alone leaves no trace: the session's last assistant message
        // still carries a completed timestamp, so status derivation would
        // report `completed` for a task the caller deliberately killed.
        markTaskCancelled(task_id);

        return jsonResult({
          task_id,
          session_id: sessionId,
          status: "cancelled",
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
