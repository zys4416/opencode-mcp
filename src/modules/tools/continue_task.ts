import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { clientForTask } from "../shared/opencode-client.js";
import { getTask, resumeTask } from "../shared/task-registry.js";

/** Parse a "providerID/modelID" string into the shape the SDK expects. */
function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function registerOpencodeContinueTask(server: McpServer) {
  server.registerTool(
    "opencode_continue_task",
    {
      description:
        "Send a follow-up prompt while retaining the session's current model. Omit model unless the user explicitly requests model selection.",
      inputSchema: {
        task_id: z
          .string()
          .describe("Id of the task whose session should receive the follow-up prompt"),
        prompt: z.string().describe("Follow-up prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the session's current agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Omit by default to retain the session's current model. Only set when the user explicitly requests model selection. An explicit providerID/modelID changes the session model for this and subsequent follow-ups; copy its exact ID from opencode_list_agents.",
          ),
      },
    },
    async ({ task_id, prompt, agent, model }) => {
      const task = getTask(task_id);
      const resolved = clientForTask(task_id);
      if (!resolved || !task) {
        return jsonError({ task_id, status: "task_not_found" });
      }
      const { client, sessionId } = resolved;

      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          return jsonError({
            task_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          });
        }
      }

      if (task.mutating)
        return jsonError({
          task_id,
          status: "error",
          message: "Another task update is in progress",
        });
      task.mutating = true;
      try {
        if (
          (await client.session.active())[sessionId] ||
          (await client.session.inbox.list({ sessionID: sessionId })).length > 0
        ) {
          return jsonError({
            task_id,
            status: "error",
            message:
              "Session is still running or has queued input; wait or cancel before continuing",
          });
        }
        if (agent) await client.session.switchAgent({ sessionID: sessionId, agent });
        if (parsedModel)
          await client.session.switchModel({
            sessionID: sessionId,
            model: { providerID: parsedModel.providerID, id: parsedModel.modelID },
          });
        const inputId = `msg_${randomUUID()}`;
        const before = await client.session.get({ sessionID: sessionId });
        resumeTask(task.taskId, inputId, before.time.idle);
        await client.session.prompt({ sessionID: sessionId, id: inputId, text: prompt });

        return jsonResult({
          task_id,
          session_id: sessionId,
          status: "pending",
        });
      } catch (error) {
        return jsonError({
          task_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        task.mutating = false;
      }
    },
  );
}
