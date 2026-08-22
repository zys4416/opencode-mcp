import { formatTierGuide, formatUsageLimits, getUsageLimits } from "./usage-limits.js";

const QUOTA_FALLBACK = `OpenCode Go usage limits — unavailable right now (the docs could not be fetched and no cached snapshot exists).
All models share a single dollar budget per 5h / week / month, so an expensive model drains it in far fewer requests.`;

/**
 * Build the MCP server instructions.
 *
 * Only the spend budget is embedded from the daily snapshot: per-model quotas
 * ride along with `opencode_list_agents`, keyed by the real model id, so they
 * are deliberately not repeated here.
 */
export async function createDelegateTaskInstructions(): Promise<string> {
  const limits = await getUsageLimits();
  const quotaBlock = limits ? formatUsageLimits(limits) : QUOTA_FALLBACK;

  return `You have access to the opencode-mcp server, which lets you delegate work to OpenCode agents. Follow this workflow whenever you delegate tasks:

${quotaBlock}
Burning a scarce model on work a cheap model handles well is how a session runs out of budget in one shot. Default to the cheapest tier that can do the job and escalate only when the task actually demands it.

Choosing a model — pass it per task via the optional "model" input of opencode_start_task as 'providerID/modelID'. Build that string only from opencode_list_agents output: models.providers[].provider + '/' + models.providers[].models[].id, both copied verbatim. Never derive an id from a model's display name, and never assume a provider prefix — read it from the same models.providers[] entry that supplied the id. If opencode_start_task returns status "unknown_model", pick one of the available_models it returns instead of retrying a guessed id.

Every model in that output carries a quota field: per_5h (estimated requests per 5 hours) and tier. Choose by tier:
${formatTierGuide()}
Spread parallel tasks across models instead of firing every task at the same scarce one. models.providers[] is also the authority on what is actually enabled for the connected account.

Workflow:
1. Ensure an OpenCode server is running. If you don't already have a server_id from a previous opencode_start_server call, call opencode_start_server first.
2. Call opencode_list_agents with the server_id to discover the available agents (native and custom), the exact model ids and their quotas. Agents may have a pre-assigned model ("provider/model"); you can still override it per task.
3. For each task, call opencode_start_task with the server_id and the task's prompt, optionally with an agent name and/or a model override. Collect the returned task_id for every call.
4. Wait for completion with opencode_wait_for_task:
   - Single task: mode "all" with the single task_id.
   - Multiple tasks, incremental results: call it repeatedly with mode "any", removing completed task_ids each time.
   - Multiple tasks, all at once: call it once with mode "all" and every task_id.
5. Once a task is reported finished, call opencode_get_task_result for that task_id to retrieve its output.
6. Use opencode_get_task_status only for quick, non-blocking checks on a task's progress (e.g. to report status to the user) — it does not replace opencode_wait_for_task or opencode_get_task_result.

Do not call opencode_get_task_result before the task has finished, and prefer opencode_wait_for_task over polling opencode_get_task_status in a loop.`;
}
