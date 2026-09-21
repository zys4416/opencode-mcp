import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { getServer } from "../shared/server-registry.js";
import { registerTask } from "../shared/task-registry.js";

/** Parse a "providerID/modelID" string into the shape the SDK expects. */
function parseModel(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function registerOpencodeStartTask(server: McpServer) {
  server.registerTool(
    "opencode_start_task",
    {
      description:
        "Delegate a task using OpenCode's configured default model. Omit model unless the user explicitly requests model selection. Returns immediately after prompt admission.",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to run the task on"),
        prompt: z.string().describe("Prompt/instructions for the agent"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent name to delegate to (e.g. 'build', 'plan'). Discover available agents with opencode_list_agents. Omit to use the server's default agent",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "Omit by default to use the selected agent's configured model or OpenCode's default model. Only set when the user explicitly requests model selection. If authorized, copy an exact providerID/modelID from opencode_list_agents; do not guess or copy the default merely to fill this field.",
          ),
      },
    },
    async ({ server_id, prompt, agent, model }) => {
      const server = getServer(server_id);
      if (!server) {
        return jsonError({ server_id, status: "server_not_found" });
      }

      const client = server.client;
      let parsedModel: { providerID: string; modelID: string } | undefined;
      if (model !== undefined) {
        parsedModel = parseModel(model);
        if (!parsedModel) {
          return jsonError({
            server_id,
            status: "invalid_model",
            message: "model must be in 'providerID/modelID' format",
          });
        }
      }

      try {
        if (parsedModel) {
          const requested = parsedModel;
          const modelsRes = await client.model.list({
            location: { directory: server.directory },
          });
          const models = modelsRes.data.filter((model) => model.enabled);
          if (
            !models.some(
              (model) =>
                model.providerID === requested.providerID && model.id === requested.modelID,
            )
          ) {
            return jsonError({
              server_id,
              status: "unknown_model",
              model,
              message:
                "model is not available; copy a providerID/modelID from opencode_list_agents",
              available_models: models.map((model) => `${model.providerID}/${model.id}`),
            });
          }
        }

        const created = await client.session.create({
          title: prompt.slice(0, 60),
          location: { directory: server.directory },
          agent,
          model: parsedModel
            ? { providerID: parsedModel.providerID, id: parsedModel.modelID }
            : undefined,
        });
        const sessionId = created.id;
        if (!sessionId) {
          return jsonError({ server_id, status: "error", message: "failed to create session" });
        }

        const taskId = randomUUID();
        const inputId = `msg_${randomUUID()}`;
        // Register ownership before submitting, so early permission events are handled.
        registerTask({ taskId, serverId: server_id, sessionId, inputId, createdAt: Date.now() });
        try {
          await client.session.prompt({ sessionID: sessionId, id: inputId, text: prompt });
        } catch {
          // The request may have been admitted before a connection dropped. Keep its
          // identity available; never automatically retry a potentially executing prompt.
          return jsonError({
            task_id: taskId,
            session_id: sessionId,
            status: "error",
            message: "Prompt submission failed; inspect this task before retrying",
          });
        }

        return jsonResult({
          task_id: taskId,
          server_id,
          session_id: sessionId,
          status: "pending",
        });
      } catch (error) {
        return jsonError({
          server_id,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
