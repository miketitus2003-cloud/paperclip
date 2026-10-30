import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues,
  nativeRunFinalizations, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { adapterExecutionControls, createAdapterExecutionControl } from "../services/adapter-execution-control.js";
import { assertNativeTaskAdmissionCurrent, beginNativeTaskAdmission,
  finishNativeTaskAdmission } from "../services/native-runtime/native-task-admission.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping agent Pause admission route tests: ${support.reason}`);
describe.skipIf(!support.supported)("manual Pause across native startup admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-pause-native-admission-");
    db = createDb(database.connectionString, { maxConnections: 5 });
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture(runtimeMode = "native") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(),
      pluginId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), leaseOwner = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pause route fixture", issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: `pause-${pluginId}`, packageName: "pause-route-fixture",
      version: "1.0.0", status: "ready", manifestJson: { id: `pause-${pluginId}`, apiVersion: 1,
        version: "1.0.0", displayName: "Pause route fixture", description: "Fixture", author: "Paperclip",
        categories: ["automation"], capabilities: ["agents.lifecycle.manage"], entrypoints: { worker: "./worker.js" } } });
    await db.insert(environments).values({ id: environmentId, name: `Pause ${environmentId}`, driver: "plugin" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pause route agent", status: "running",
      lifecycleState: "ready", lifecycleVersion: 7, adapterType: "paperclip_runner",
      lifecycleRequiredPluginIds: [pluginId], defaultEnvironmentId: environmentId });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pause route task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode,
      runtimeModeResolvedAt: new Date(), nativeIssueId: runtimeMode === "native" ? issueId : null });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      providerLeaseId: `task-${runId}`, status: "active", metadata: { pluginId } });
    if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      leaseOwner, controllerGeneration: 3, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "pause-route-board", companyIds: [companyId] };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { companyId, agentId, issueId, runId, leaseId, leaseOwner, app };
  }

  it.each(["finished", "expired"] as const)("commits Pause intent, drains %s startup, then waits for durable native cancellation", async outcome => {
    const f = await fixture(), admission = await beginNativeTaskAdmission(db, f);
    let responseSettled = false;
    const response = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({})
      .then(value => { responseSettled = true; return value; });
    let unlock = () => {}, writer: Promise<unknown> | undefined;
    try {
      await vi.waitFor(async () => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
        expect(agent).toMatchObject({ status: "paused", lifecycleState: "pausing", lifecycleVersion: 8 });
      });
      expect(responseSettled).toBe(false);
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(before.status).toBe("running");
      expect(before.resultJson?.startupCancellation).toBeUndefined();
      expect(before.resultJson?.nativeCancellation).toBeUndefined();
      await expect(beginNativeTaskAdmission(db, f)).rejects.toThrow("native_task_admission_cancelled");
      await expect(assertNativeTaskAdmissionCurrent(db, admission)).resolves.toBeUndefined();
      let locked!: (pid: number) => void;
      const ready = new Promise<number>(resolve => { locked = resolve; });
      const release = new Promise<void>(resolve => { unlock = resolve; });
      writer = db.transaction(async tx => {
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        locked(backend.pid);
        await release;
      });
      const pid = await ready;
      if (outcome === "finished") await finishNativeTaskAdmission(db, admission);
      else {
        await db.update(nativeRunFinalizations).set({ admissionExpiresAt: new Date(0) })
          .where(eq(nativeRunFinalizations.runId, f.runId));
        await expect(assertNativeTaskAdmissionCurrent(db, admission)).rejects.toThrow("native_task_admission_lost");
      }
      await vi.waitFor(async () => {
        const [activity] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where ${pid} = any(pg_blocking_pids(pid))) as waiting`);
        expect(activity.waiting).toBe(true);
      });
      expect(responseSettled).toBe(false);
      unlock(); await writer;
      const result = await response;
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
      expect(cancelled.resultJson?.nativeCancellation).toMatchObject({ scope: "run", dispatchState: "acknowledged" });
      await expect(beginNativeTaskAdmission(db, f)).rejects.toThrow("native_task_admission_cancelled");
    } finally {
      unlock(); await writer;
      await finishNativeTaskAdmission(db, admission);
      await response;
    }
  });

  it("waits for an ordinary running adapter's stop settlement before answering Pause", async () => {
    const f = await fixture("legacy"), control = createAdapterExecutionControl();
    adapterExecutionControls.set(f.runId, control);
    let responseSettled = false;
    const response = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({})
      .then(value => { responseSettled = true; return value; });
    try {
      await vi.waitFor(() => expect(control.controller.signal.aborted).toBe(true));
      expect(responseSettled).toBe(false);
      const [stopping] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(stopping).toMatchObject({ status: "running", resultJson: { executionCancellation: { state: "requested" } } });
      control.finish();
      const result = await response;
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "agent_paused" });
    } finally {
      control.finish();
      adapterExecutionControls.delete(f.runId);
      await response;
    }
  });
});
