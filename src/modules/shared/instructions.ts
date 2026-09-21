/** Keep default model selection in OpenCode; retain the async initialization interface. */
export async function createDelegateTaskInstructions(): Promise<string> {
  return `You have access to the opencode-mcp server, which lets you delegate work to OpenCode agents.

Model selection policy:
- Omit the model parameter by default on both opencode_start_task and opencode_continue_task. Let OpenCode use the selected agent's configured model or its configured default model. For follow-ups, retain the session's current model.
- Only provide model when the user explicitly requests a particular model or explicitly asks you to choose one. Task difficulty, price, quota metadata, or parallelism are not reasons to override the configured model on your own.
- Do not copy a discovered default model ID into the model parameter: leave the parameter absent so OpenCode resolves its own configuration.
- Omit agent when no specific agent is needed, letting OpenCode choose its default agent. Selecting an agent does not require selecting a model.
- When an explicit model selection is authorized, build the ID from models.providers[].provider + '/' + models.providers[].models[].id, both copied verbatim from opencode_list_agents. Never guess an ID. If unknown_model is returned, report the mismatch instead of silently switching to another model.

Workflow:
1. Ensure an OpenCode server is running. If you don't already have a server_id from a previous opencode_start_server call, call opencode_start_server first.
2. Use OpenCode defaults. Call opencode_list_agents only when you need to discover an agent, inspect capabilities, or resolve a model explicitly requested by the user. It is not a prerequisite for starting a task.
3. For each task, call opencode_start_task with server_id and prompt. Omit model by default; omit agent when no specific agent is needed. Collect the returned task_id for every call.
4. Wait for completion with opencode_wait_for_task:
   - Single task: mode "all" with the single task_id.
   - Multiple tasks, incremental results: call it repeatedly with mode "any", removing completed task_ids each time.
   - Multiple tasks, all at once: call it once with mode "all" and every task_id.
5. Once a task is reported finished, call opencode_get_task_result for that task_id to retrieve its output.
6. Use opencode_get_task_status only for quick, non-blocking checks on a task's progress (e.g. to report status to the user) — it does not replace opencode_wait_for_task or opencode_get_task_result.

Do not call opencode_get_task_result before the task has finished, and prefer opencode_wait_for_task over polling opencode_get_task_status in a loop.`;
}
