import { beforeEach, describe, expect, it, vi } from "vitest";
import { killAllServers } from "../../../src/modules/shared/server-registry.js";
import { registerOpencodeListAgents } from "../../../src/modules/tools/list_agents.js";
import { fixture, handler } from "../../helpers/v2.js";

const limits = vi.hoisted(() => vi.fn());
vi.mock("../../../src/modules/shared/usage-limits.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getUsageLimits: limits,
}));
const run = handler(registerOpencodeListAgents);
beforeEach(() => {
  killAllServers();
  limits.mockResolvedValue(null);
});
describe("v2 agents and models", () => {
  it("rejects unknown server", async () =>
    expect((await run({ server_id: "missing" })).status).toBe("not_found"));
  it("reports stable agent IDs without fabricating native/custom provenance", async () => {
    const { routes } = fixture();
    routes.set("GET /api/agent", {
      data: [
        {
          id: "custom",
          name: "Display",
          mode: "all",
          hidden: false,
          description: "Description",
          model: { providerID: "test", id: "model" },
        },
        { id: "hidden", hidden: true },
      ],
    });
    const result = await run({ server_id: "srv_test" });
    expect(result.agents.available).toEqual([
      { name: "custom", mode: "all", description: "Description", model: "test/model" },
    ]);
    expect(result.models.providers[0].models).toEqual([{ id: "model", quota: null }]);
  });
  it("handles empty defaults and annotates quota snapshots", async () => {
    const { routes } = fixture();
    routes.set("GET /api/model/default", { data: null });
    routes.set("GET /api/model", {
      data: [
        { id: "model", providerID: "test", enabled: true },
        { id: "off", providerID: "test", enabled: false },
      ],
    });
    limits.mockResolvedValue({
      source: "test",
      fetchedAt: "2026-09-21",
      models: [{ model: "Model", perFiveHours: 100 }],
    });
    const result = await run({ server_id: "srv_test" });
    expect(result.models.defaults).toEqual({});
    expect(result.models.quota_snapshot).toEqual({ source: "test", checked: "2026-09-21" });
  });
  it.each([401, 400])("reports API errors (%s)", async (status) => {
    const { routes } = fixture();
    routes.set(
      "GET /api/agent",
      status === 401 ? 401 : Response.json({ message: "invalid" }, { status }),
    );
    expect((await run({ server_id: "srv_test" })).isError).toBe(true);
  });
});
it("formats non-object failures", async () => {
  const { client } = fixture();
  vi.spyOn(client.agent, "list").mockRejectedValue("offline");
  expect((await run({ server_id: "srv_test" })).message).toBe("offline");
});
