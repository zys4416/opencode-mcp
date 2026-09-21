import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createOpencodeServer } from "../shared/opencode-server.js";
import {
  buildServerConfig,
  getExternalDirectoryPolicy,
  startPermissionResponder,
} from "../shared/permissions.js";
import { getServer, registerServer } from "../shared/server-registry.js";

const DEFAULT_PORT = 0;

export function registerOpencodeStartServer(server: McpServer) {
  server.registerTool(
    "opencode_start_server",
    {
      description:
        "Start a headless OpenCode server in the current working directory. Omit port to automatically allocate a free port; use the returned baseUrl to connect.",
      inputSchema: {
        port: z
          .number()
          .int()
          .min(0)
          .max(65535)
          .optional()
          .describe(
            "Omit or use 0 (default) to let the OS allocate a free port. An explicit nonzero port is used strictly; conflicts return an error.",
          ),
      },
    },
    async ({ port }) => {
      try {
        const policy = getExternalDirectoryPolicy();

        // The server inherits this process' cwd, so its project worktree is the
        // directory the MCP host was launched in — no cwd argument needed.
        const instance = await createOpencodeServer({
          port: port ?? DEFAULT_PORT,
          config: buildServerConfig(policy),
        });
        const serverId = randomUUID();

        // Nothing can approve a permission prompt behind a headless server, so
        // an unanswered `ask` wedges the agent forever. The responder answers
        // every request, which is what keeps tasks from hanging indefinitely.
        const responder = startPermissionResponder(instance.client, {
          policy,
          serverId,
          directory: process.cwd(),
          onError: () => {
            const record = getServer(serverId);
            if (record)
              record.permissionError =
                "OpenCode permission responder failed; check server connectivity";
          },
          onHealthy: () => {
            const record = getServer(serverId);
            if (record) delete record.permissionError;
          },
        });

        registerServer({
          serverId,
          baseUrl: instance.url,
          client: instance.client,
          directory: process.cwd(),
          close: () => {
            responder.stop();
            instance.close();
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                server_id: serverId,
                baseUrl: instance.url,
                status: "running",
                permissions: {
                  external_directory: policy,
                  auto_approved: true,
                },
              }),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    },
  );
}
