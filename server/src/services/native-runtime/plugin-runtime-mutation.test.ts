import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companySecretBindings, companySecrets, createDb, heartbeatRuns, issues, nativeRunFinalizations, pluginConfig, plugins, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { pluginRegistryService } from "../plugin-registry.js";
import { withPluginRuntimeMutation } from "./plugin-runtime-mutation.js";
import { createAgentLifecycle } from "../agent-lifecycle.js";
import { secretService } from "../secrets.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("plugin runtime mutation admission barrier", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("plugin-runtime-mutation-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  async function fixture(pluginId = randomUUID(), expiresInMs = 30_000) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Runtime mutation fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "runtime-mutation-fixture", version: "1",
      status: "ready", manifestJson: { resourceLifecycle: ["agent_runtime"], capabilities: ["agents.lifecycle.manage"] } as never }).onConflictDoNothing();
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture agent", status: "idle", adapterType: "paperclip_runner",
      lifecycleRequiredPluginIds: [pluginId] });
    await db.insert(issues).values({ id: issueId, companyId, title: "Fixture task" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native", status: "running" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "running", admissionOwner: randomUUID(),
      admissionExpiresAt: new Date(Date.now() + expiresInMs) });
    await db.insert(pluginConfig).values({ pluginId, companyId, configJson: { version: 1 } });
    return { companyId, agentId, pluginId, runId };
  }
  async function finish(runId: string) {
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
      await tx.update(nativeRunFinalizations).set({ admissionFinishedAt: sql`clock_timestamp()` }).where(eq(nativeRunFinalizations.runId, runId));
    });
  }
  async function pending(pluginId: string, scope: string) {
    await vi.waitFor(async () => {
      const [plugin] = await db.select().from(plugins).where(eq(plugins.id, pluginId));
      expect(plugin.runtimeMutations[scope]?.owner).toBeTruthy();
    });
  }

  it.each(["upsert", "delete", "disable", "uninstall", "company-disable"] as const)(
    "drains the admitted startup before %s and clears the pending writer", async kind => {
      const f = await fixture(), registry = pluginRegistryService(db);
      const writing = kind === "upsert" ? registry.upsertConfig(f.pluginId, f.companyId, { companyId: f.companyId, configJson: { version: 2 } })
        : kind === "delete" ? registry.deleteConfig(f.pluginId, f.companyId)
        : kind === "disable" ? registry.updateStatus(f.pluginId, { status: "disabled" })
        : kind === "uninstall" ? registry.uninstall(f.pluginId, true)
        : registry.upsertCompanySettings(f.pluginId, f.companyId, { enabled: false, settingsJson: {} });
      void writing.catch(() => {});
      try {
        await pending(f.pluginId, ["disable", "uninstall"].includes(kind) ? "*" : f.companyId);
        expect((await registry.getConfig(f.pluginId, f.companyId))?.configJson).toEqual({ version: 1 });
        expect((await registry.getById(f.pluginId))?.status).toBe("ready");
        expect(await registry.getCompanySettings(f.pluginId, f.companyId)).toBeNull();
      } finally { await finish(f.runId); }
      await writing;
      if (kind === "uninstall") expect(await registry.getById(f.pluginId)).toBeNull();
      else {
        expect((await registry.getById(f.pluginId))?.runtimeMutations).toEqual({});
        if (kind === "upsert") expect((await registry.getConfig(f.pluginId, f.companyId))?.configJson).toEqual({ version: 2 });
        if (kind === "delete") expect(await registry.getConfig(f.pluginId, f.companyId)).toBeNull();
        if (kind === "disable") expect((await registry.getById(f.pluginId))?.status).toBe("disabled");
        if (kind === "company-disable") expect((await registry.getCompanySettings(f.pluginId, f.companyId))?.enabled).toBe(false);
      }
    },
  );

  it("does not hold a plugin transaction or stop another company's writes while draining", async () => {
    const first = await fixture(), second = await fixture(first.pluginId), registry = pluginRegistryService(db);
    await finish(second.runId);
    const writing = registry.patchConfig(first.pluginId, first.companyId, { companyId: first.companyId, configJson: { version: 2 } });
    void writing.catch(() => {});
    try {
      await pending(first.pluginId, first.companyId);
      await registry.patchConfig(second.pluginId, second.companyId, { companyId: second.companyId, configJson: { version: 3 } });
      expect((await registry.getConfig(second.pluginId, second.companyId))?.configJson).toEqual({ version: 3 });
      expect((await registry.getConfig(first.pluginId, first.companyId))?.configJson).toEqual({ version: 1 });
    } finally { await finish(first.runId); }
    await writing;
  });

  it("still drains a cancelled run until its startup reservation finishes", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    const write = vi.fn(async () => "changed");
    const writing = withPluginRuntimeMutation(db, f.pluginId, f.companyId, write);
    void writing.catch(() => {});
    try { await pending(f.pluginId, f.companyId); expect(write).not.toHaveBeenCalled(); }
    finally { await finish(f.runId); }
    await expect(writing).resolves.toBe("changed");
  });

  it("rejects an expired writer before its mutation callback can run", async () => {
    const f = await fixture(), write = vi.fn(async () => "changed");
    const writing = withPluginRuntimeMutation(db, f.pluginId, f.companyId, write);
    void writing.catch(() => {});
    await pending(f.pluginId, f.companyId);
    await db.update(plugins).set({ runtimeMutations: sql`jsonb_set(${plugins.runtimeMutations}, ${`{${f.companyId},expiresAt}`}::text[], '"2000-01-01T00:00:00.000Z"'::jsonb)` })
      .where(eq(plugins.id, f.pluginId));
    await finish(f.runId);
    await expect(writing).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
    expect((await pluginRegistryService(db).getById(f.pluginId))?.runtimeMutations).toEqual({});
  });

  it("rolls back a failed mutation and releases only its own pending scope", async () => {
    const f = await fixture(); await finish(f.runId);
    await expect(withPluginRuntimeMutation(db, f.pluginId, f.companyId, async tx => {
      await tx.update(pluginConfig).set({ configJson: { version: 2 } }).where(eq(pluginConfig.pluginId, f.pluginId));
      throw new Error("fixture mutation failed");
    })).rejects.toThrow("fixture mutation failed");
    const registry = pluginRegistryService(db);
    expect((await registry.getConfig(f.pluginId, f.companyId))?.configJson).toEqual({ version: 1 });
    expect((await registry.getById(f.pluginId))?.runtimeMutations).toEqual({});
  });

  it("accepts an expired admission without treating its expiry as remote process-stop evidence", async () => {
    const f = await fixture(randomUUID(), -1), registry = pluginRegistryService(db);
    await registry.patchConfig(f.pluginId, f.companyId, { companyId: f.companyId, configJson: { version: 2 } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("running");
    expect((await registry.getConfig(f.pluginId, f.companyId))?.configJson).toEqual({ version: 2 });
  });

  it("drains ready-agent configuration without pausing the agent or stopping its running task", async () => {
    const f = await fixture(), lifecycle = createAgentLifecycle(db);
    const writing = lifecycle.updateConfiguration(f.agentId, { title: "Updated title" });
    void writing.catch(() => {});
    try {
      await vi.waitFor(async () => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        expect(agent.runtimeMutation?.owner).toBeTruthy();
        expect(agent.title).toBeNull();
        expect(agent.status).toBe("idle");
        expect(agent.lifecycleState).toBe("ready");
      });
    } finally { await finish(f.runId); }
    await expect(writing).resolves.toMatchObject({ title: "Updated title", lifecycleState: "ready" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(agent.runtimeMutation).toBeNull();
    expect(run.status).toBe("running");
  });

  it("keeps configuration-derived secret references behind the gate and rolls them back with the config", async () => {
    const f = await fixture(), registry = pluginRegistryService(db), secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId: f.companyId, key: "fixture_capability", name: "Fixture capability" });
    const sync = (transaction: Db) => secretService(transaction).syncSecretRefsForTarget(f.companyId,
      { targetType: "plugin", targetId: f.pluginId }, [{ secretId, configPath: "capability" }], { replaceAll: true });
    const writing = registry.upsertConfig(f.pluginId, f.companyId, { companyId: f.companyId, configJson: { version: 2 } }, sync);
    void writing.catch(() => {});
    try {
      await pending(f.pluginId, f.companyId);
      expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, f.pluginId))).toEqual([]);
    } finally { await finish(f.runId); }
    await writing;
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, f.pluginId))).toHaveLength(1);
    await expect(registry.upsertConfig(f.pluginId, f.companyId, { companyId: f.companyId, configJson: { version: 3 } }, async tx => {
      await secretService(tx).syncSecretRefsForTarget(f.companyId, { targetType: "plugin", targetId: f.pluginId }, [], { replaceAll: true });
      throw new Error("fixture binding failure");
    })).rejects.toThrow("fixture binding failure");
    expect((await registry.getConfig(f.pluginId, f.companyId))?.configJson).toEqual({ version: 2 });
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, f.pluginId))).toHaveLength(1);
  });

  it("keeps configuration preconditions current after waiting and releases the agent gate on failure", async () => {
    const f = await fixture(), lifecycle = createAgentLifecycle(db);
    const writing = lifecycle.updateConfiguration(f.agentId, { title: "Stale overwrite" }, { expectedConfiguration: {
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, defaultEnvironmentId: null,
    } });
    void writing.catch(() => {});
    await vi.waitFor(async () => {
      const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(agent.runtimeMutation?.owner).toBeTruthy();
    });
    await db.update(agents).set({ adapterConfig: { provider: "codex" } }).where(eq(agents.id, f.agentId));
    await finish(f.runId);
    await expect(writing).rejects.toMatchObject({ status: 409 });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.title).toBeNull();
    expect(agent.adapterConfig).toEqual({ provider: "codex" });
    expect(agent.runtimeMutation).toBeNull();
  });

  it("drains the configuration-plus-transition entry point before applying its existing pause semantics", async () => {
    const f = await fixture(), lifecycle = createAgentLifecycle(db);
    const writing = lifecycle.updateAndTransition(f.agentId, "pause", { title: "Configured then paused" });
    void writing.catch(() => {});
    try {
      await vi.waitFor(async () => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        expect(agent.runtimeMutation?.owner).toBeTruthy();
        expect(agent.lifecycleState).toBe("ready");
      });
    } finally { await finish(f.runId); }
    await expect(writing).resolves.toMatchObject({ title: "Configured then paused", lifecycleState: "pausing" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.runtimeMutation).toBeNull();
  });
});
