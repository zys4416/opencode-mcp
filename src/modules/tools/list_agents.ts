import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentInfo } from "@opencode/client";
import { z } from "zod";
import { jsonError, jsonResult } from "../shared/mcp-result.js";
import { getServer } from "../shared/server-registry.js";
import {
  getUsageLimits,
  type ModelQuota,
  type QuotaTier,
  quotaByModelId,
  quotaTier,
  type UsageLimits,
} from "../shared/usage-limits.js";

interface AgentSummary {
  name: string;
  mode: AgentInfo["mode"];
  description?: string;
  /** Pre-assigned model as "provider/model"; can still be overridden per task. */
  model?: string;
}

function toAgentSummary(agent: AgentInfo): AgentSummary {
  return {
    name: agent.id,
    mode: agent.mode,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.model ? { model: `${agent.model.providerID}/${agent.model.id}` } : {}),
  };
}

interface ModelSummary {
  /** The model id to combine with `provider` as "provider/id". */
  id: string;
  /** OpenCode Go quota for this model, or `null` when the docs list none. */
  quota: { per_5h: number | null; tier: QuotaTier } | null;
}

function toModelSummary(id: string, quota: ModelQuota | undefined): ModelSummary {
  if (!quota) return { id, quota: null };
  return { id, quota: { per_5h: quota.perFiveHours, tier: quotaTier(quota.perFiveHours) } };
}

// Tells the caller whether a `quota: null` means "not an OpenCode Go model" or
// "we never got the table" — the two are indistinguishable per model.
function toQuotaSnapshot(limits: UsageLimits | null) {
  if (!limits) return null;
  return { source: limits.source, checked: limits.fetchedAt.slice(0, 10) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function registerOpencodeListAgents(server: McpServer) {
  server.registerTool(
    "opencode_list_agents",
    {
      description:
        "Inspect available agents and enabled models/providers. Optional discovery, not required for default-model tasks. Catalog and quota metadata do not authorize overriding OpenCode defaults.",
      inputSchema: {
        server_id: z.string().describe("Id of the server instance to query"),
      },
    },
    async ({ server_id }) => {
      const instance = getServer(server_id);
      if (!instance) {
        return jsonError({ server_id, status: "not_found" });
      }

      try {
        const client = instance.client;
        const location = { directory: instance.directory };
        // getUsageLimits() reads a once-a-day snapshot from disk, so this adds
        // no network round-trip on a warm cache and never throws.
        const [agentsResult, providersResult, modelsResult, defaultResult, limits] =
          await Promise.all([
            client.agent.list({ location }),
            client.provider.list({ location }),
            client.model.list({ location }),
            client.model.default({ location }),
            getUsageLimits(),
          ]);
        const allAgents = agentsResult.data.filter((agent) => !agent.hidden);
        const models = modelsResult.data.filter((model) => model.enabled);
        const defaults = defaultResult.data
          ? { [defaultResult.data.providerID]: defaultResult.data.id }
          : {};
        const quotas = limits ? quotaByModelId(limits) : new Map<string, ModelQuota>();
        return jsonResult({
          server_id,
          agents: {
            native: [],
            custom: [],
            available: allAgents.map(toAgentSummary),
          },
          models: {
            defaults,
            quota_snapshot: toQuotaSnapshot(limits),
            providers: providersResult.data.map((provider) => ({
              provider: provider.id,
              name: provider.name,
              models: models
                .filter((model) => model.providerID === provider.id)
                .map((model) => toModelSummary(model.id, quotas.get(model.id))),
            })),
          },
        });
      } catch (error) {
        return jsonError({ server_id, status: "error", message: errorMessage(error) });
      }
    },
  );
}
