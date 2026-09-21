import { describe, expect, it, vi } from "vitest";
import { createDelegateTaskInstructions } from "../../../src/modules/shared/instructions.js";

const { getUsageLimits } = vi.hoisted(() => ({ getUsageLimits: vi.fn() }));
vi.mock("../../../src/modules/shared/usage-limits.js", () => ({ getUsageLimits }));

describe("default-first delegation instructions", () => {
  it("leaves default resolution to OpenCode on new tasks and follow-ups", async () => {
    const instructions = await createDelegateTaskInstructions();
    expect(instructions).toContain(
      "Omit the model parameter by default on both opencode_start_task and opencode_continue_task",
    );
    expect(instructions).toContain("retain the session's current model");
    expect(instructions).toContain("Do not copy a discovered default model ID");
    expect(instructions).toContain("Omit agent when no specific agent is needed");
  });

  it("permits explicit user-directed model selection without guessing or silent substitution", async () => {
    const instructions = await createDelegateTaskInstructions();
    expect(instructions).toContain("Only provide model when the user explicitly requests");
    expect(instructions).toContain(
      "models.providers[].provider + '/' + models.providers[].models[].id",
    );
    expect(instructions).toContain("report the mismatch instead of silently switching");
  });

  it("keeps discovery optional and removes quota-driven selection from startup", async () => {
    const instructions = await createDelegateTaskInstructions();
    expect(getUsageLimits).not.toHaveBeenCalled();
    expect(instructions).toContain("It is not a prerequisite for starting a task");
    expect(instructions).not.toContain("Default to the cheapest");
    expect(instructions).not.toContain("Choose by tier");
    expect(instructions).toContain("opencode_wait_for_task");
  });
});
