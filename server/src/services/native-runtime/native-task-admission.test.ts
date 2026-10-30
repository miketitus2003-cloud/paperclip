import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, pluginCompanySettings, plugins } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { assertNativeTaskAdmissionCurrent, assertNativeTaskAdmissionPermit, beginNativeTaskAdmission,
  finishNativeTaskAdmission, pendingNativeTaskAdmissionDeadline } from "./native-task-admission.js";
import { createPluginRunnerTaskOwner } from "./plugin-runner-task.js";
import type { RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";

const ingress = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../../realtime/runner-prp-outbound.js", () => ({ connectRunnerPrpIngress: ingress.connect }));

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping native task admission tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("bounded native task admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("native-task-admission-");
    db = createDb(database.connectionString, { maxConnections: 5 });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(),
      pluginId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), leaseOwner = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Admission fixture", issuePrefix: `A${companyId.slice(0, 7)}` });
    await db.insert(plugins).values({ id: pluginId, pluginKey: `admission-${pluginId}`, packageName: "admission-fixture", version: "1.0.0", status: "ready",
      manifestJson: { id: `admission-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Admission fixture", description: "Fixture",
        author: "Paperclip", categories: ["automation"], capabilities: ["agents.lifecycle.manage"], entrypoints: { worker: "./worker.js" } } });
    await db.insert(environments).values({ id: environmentId, name: `Admission ${environmentId}`, driver: "plugin" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Admission agent", status: "running", lifecycleState: "ready", lifecycleVersion: 7,
      adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId], defaultEnvironmentId: environmentId });
    await db.insert(issues).values({ id: issueId, companyId, title: "Admission task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, providerLeaseId: `task-${runId}`, status: "active", metadata: { pluginId } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 2,
      leaseOwner, controllerGeneration: 3, leaseExpiresAt: new Date(Date.now() + 60_000) });
    return { companyId, agentId, runId, leaseId, leaseOwner, pluginId };
  }

  it("keeps the granted ready snapshot while a pending pause blocks new admission", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope);
    expect(admission.lifecycleVersion).toBe(7);
    expect(admission.runtimeRevision).not.toBe("0");
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", lifecycleVersion: 8 }).where(eq(agents.id, scope.agentId));
    await expect(assertNativeTaskAdmissionCurrent(db, admission)).resolves.toBeUndefined();
    await expect(beginNativeTaskAdmission(db, scope)).rejects.toThrow("native_task_admission_cancelled");
    expect(await pendingNativeTaskAdmissionDeadline(db, scope.companyId, [scope.agentId])).toBeInstanceOf(Date);
    await finishNativeTaskAdmission(db, admission);
    expect(await pendingNativeTaskAdmissionDeadline(db, scope.companyId, [scope.agentId])).toBeNull();
  });

  it("rejects a forged or cross-scope permit and cannot release a successor", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope);
    expect(() => assertNativeTaskAdmissionPermit({ ...admission }, scope)).toThrow("native_task_admission_expired");
    expect(() => assertNativeTaskAdmissionPermit(admission, { ...scope, agentId: randomUUID() })).toThrow("native_task_admission_expired");
    const successor = randomUUID();
    await db.update(nativeRunFinalizations).set({ admissionOwner: successor, controllerGeneration: 4 }).where(eq(nativeRunFinalizations.runId, scope.runId));
    await expect(assertNativeTaskAdmissionCurrent(db, admission)).rejects.toThrow("native_task_admission_lost");
    await finishNativeTaskAdmission(db, admission);
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(row.admissionOwner).toBe(successor);
    expect(row.admissionFinishedAt).toBeNull();
  });

  it("treats expiry as expired authority, not a finished or stopped execution", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope);
    await db.update(nativeRunFinalizations).set({ admissionExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(await pendingNativeTaskAdmissionDeadline(db, scope.companyId, [scope.agentId])).toBeNull();
    await expect(assertNativeTaskAdmissionCurrent(db, admission)).rejects.toThrow("native_task_admission_lost");
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(row.admissionFinishedAt).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId));
    expect(run.status).toBe("running");
    await finishNativeTaskAdmission(db, admission);
  });

  it("drains a settled startup after finalization cleared its execution owner", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope);
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, scope.runId));
    await expect(assertNativeTaskAdmissionCurrent(db, admission)).rejects.toThrow("native_task_admission_lost");
    await finishNativeTaskAdmission(db, admission);
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(row.admissionFinishedAt).toBeInstanceOf(Date);
    expect(await pendingNativeTaskAdmissionDeadline(db, scope.companyId, [scope.agentId])).toBeNull();
  });

  it("requires the lifecycle-owning plugin and a live controller lease", async () => {
    const scope = await seed();
    await db.update(agents).set({ lifecycleRequiredPluginIds: [] }).where(eq(agents.id, scope.agentId));
    await expect(beginNativeTaskAdmission(db, scope)).rejects.toThrow("native_task_admission_blocked");
    await db.update(agents).set({ lifecycleRequiredPluginIds: [scope.pluginId] }).where(eq(agents.id, scope.agentId));
    const admission = await beginNativeTaskAdmission(db, scope);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(nativeRunFinalizations.runId, scope.runId));
    await expect(assertNativeTaskAdmissionCurrent(db, admission)).rejects.toThrow("native_task_admission_lost");
    await finishNativeTaskAdmission(db, admission);
  });

  it.each(["*", "company"])("waits for a pending plugin writer in %s scope without failing the task", async key => {
    const scope = await seed();
    await db.update(plugins).set({ runtimeMutations: { [key === "*" ? "*" : scope.companyId]: {
      owner: randomUUID(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
    } } }).where(eq(plugins.id, scope.pluginId));
    const clearing = delay(50).then(() => db.update(plugins).set({ runtimeMutations: {} }).where(eq(plugins.id, scope.pluginId)));
    const admission = await beginNativeTaskAdmission(db, scope, 1_000);
    await clearing;
    await finishNativeTaskAdmission(db, admission);
  });

  it("does not wait on an agent writer while holding the run and coordinator", async () => {
    const scope = await seed();
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, scope.agentId)).for("update"); locked(); await release;
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.runId)).for("update");
    });
    try {
      await ready;
      const releasing = delay(50).then(unlock);
      const admission = await beginNativeTaskAdmission(db, scope, 1_000);
      await releasing;
      await finishNativeTaskAdmission(db, admission);
    } finally { unlock(); await writer; }
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(row.attempt).toBe(2);
    expect(row.admissionFinishedAt).toBeInstanceOf(Date);
  });

  it("includes acquisition lock waits in the deadline and never mints a fresh late budget", async () => {
    const scope = await seed();
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, scope.runId),
        eq(nativeRunFinalizations.companyId, scope.companyId))).for("update"); locked(); await release;
    });
    try {
      await ready;
      await expect(beginNativeTaskAdmission(db, scope, 50)).rejects.toThrow();
    } finally { unlock(); await writer; }
    await db.execute(sql`select 1`);
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
    expect(row.admissionOwner).toBeNull();
  });

  it.each(["revision", "disable"])("reads fresh %s after waiting for the coordinator lock", async mode => {
    const scope = await seed();
    let unlock!: () => void, locked!: (pid: number) => void;
    const release = new Promise<void>(resolve => { unlock = resolve; }), ready = new Promise<number>(resolve => { locked = resolve; });
    const writer = db.transaction(async tx => {
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      locked(backend.pid); await release;
    });
    let acquiring: ReturnType<typeof beginNativeTaskAdmission> | undefined;
    try {
      const pid = await ready;
      acquiring = beginNativeTaskAdmission(db, scope);
      void acquiring.catch(() => undefined);
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const [activity] = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
          where ${pid} = any(pg_blocking_pids(pid))) as waiting`);
        if (activity.waiting) { observed = true; break; }
        await delay(5);
      }
      expect(observed).toBe(true);
      if (mode === "revision") await db.update(agents).set({ name: "Updated before admission lock" }).where(eq(agents.id, scope.agentId));
      else await db.insert(pluginCompanySettings).values({ pluginId: scope.pluginId, companyId: scope.companyId, enabled: false });
      unlock(); await writer;
      if (mode === "disable") {
        await expect(acquiring).rejects.toThrow("native_task_admission_blocked");
        const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, scope.runId));
        expect(row.admissionOwner).toBeNull();
      } else {
        const admission = await acquiring;
        const [latest] = await db.execute<{ revision: string }>(sql`select max(id)::text as revision from resource_lifecycle_events
          where company_id = ${scope.companyId} and resource_type = 'agent_runtime' and resource_id = ${scope.agentId}`);
        expect(admission.runtimeRevision).toBe(latest.revision);
        await finishNativeTaskAdmission(db, admission);
      }
    } finally { unlock(); await writer; await acquiring?.catch(() => undefined); }
  });

  it("the actual plugin owner rejects hung preparation and cannot attach after late completion", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope, 1_000);
    let complete!: (value: unknown) => void;
    const response = new Promise(resolve => { complete = resolve; }), attach = vi.fn();
    const task = vi.fn(async (_operation: unknown, _context?: { admission?: { id: string; expiresAtMs: number } }) => response);
    const owner = createPluginRunnerTaskOwner({ task, admission, projectIds: [], harness: "codex", projectAuthCheckVersion: 1 });
    const requirements: RunnerProviderLaunchRequirements = { schema: "paperclip.runner.launch-requirements.v1",
      identity: { runnerInstanceId: "runner", environmentLeaseId: scope.leaseId, runId: scope.runId, normalizedSessionId: "session", turnId: "turn", itemId: "item" },
      provider: "codex", model: null, instructions: "Fixture", runtimeContext: null, settings: {}, approvalPolicy: "never", readOnly: false,
      preparedConversation: false, includeCollaborationModeInstructions: false };
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const outcome = owner.driver.withRetainedRunAdmission!(async () => { await owner.driver.prepareLaunch!(requirements); attach(); })
        .catch(error => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toMatchObject({ message: "native_task_admission_expired" });
      expect(task).toHaveBeenCalledOnce();
      expect(task.mock.calls[0]?.[1]).toEqual({ admission });
      complete({ kind: "prepared", taskId: admission.taskId, launch: { configurationId: "fixture", requirementsDigest: `sha256:${"a".repeat(64)}`, provider: {} } });
      await vi.advanceTimersByTimeAsync(0);
      expect(attach).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); complete(undefined); await finishNativeTaskAdmission(db, admission); }
  });

  it("rejects a current-row response that arrives after the permit deadline", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope);
    let release!: () => void, observed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), read = new Promise<void>(resolve => { observed = resolve; });
    const select = db.select.bind(db);
    const spy = vi.spyOn(db, "select").mockImplementation(((fields: unknown) => {
      const builder = select(fields as never) as any;
      const from = builder.from.bind(builder);
      builder.from = (table: unknown) => {
        const query = from(table), then = query.then.bind(query);
        query.then = (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
          then(async (rows: unknown) => { observed(); await held; return resolve(rows); }, reject);
        return query;
      };
      return builder;
    }) as typeof db.select);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    const result = assertNativeTaskAdmissionCurrent(db, admission).catch(error => error);
    try {
      await read;
      clock = vi.spyOn(Date, "now").mockReturnValue(admission.expiresAtMs + 1);
      release();
      expect(await result).toMatchObject({ message: "native_task_admission_expired" });
    } finally { release(); spy.mockRestore(); clock?.mockRestore(); await result; await finishNativeTaskAdmission(db, admission); }
  });

  it("the actual plugin registration cannot open ingress after a late connection response", async () => {
    const scope = await seed(), admission = await beginNativeTaskAdmission(db, scope, 1_000);
    const identity = { runnerInstanceId: "runner", environmentLeaseId: scope.leaseId, runId: scope.runId,
      normalizedSessionId: "session", turnId: "turn", itemId: "item" };
    let complete!: (value: unknown) => void, connecting!: () => void;
    const response = new Promise(resolve => { complete = resolve; }), called = new Promise<void>(resolve => { connecting = resolve; });
    const task = vi.fn(async (operation: any): Promise<unknown> => {
      if (operation.kind === "status") return { kind: "status", taskId: admission.taskId, phase: "running", executionStopped: false };
      if (operation.kind === "read_state") return { kind: "state", taskId: admission.taskId,
        state: { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended" } };
      if (operation.kind === "connection") { connecting(); return response; }
      throw new Error("Unexpected fixture operation");
    });
    const owner = createPluginRunnerTaskOwner({ task, admission, projectIds: [], harness: "codex", adoptIdentity: identity });
    const registration = await owner.registration({} as never, scope.runId);
    ingress.connect.mockClear();
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const result = owner.driver.withRetainedRunAdmission!(async () => { registration.activate(); await registration.ready(); }).catch(error => error);
      await called;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toMatchObject({ message: "native_task_admission_expired" });
      complete({ kind: "connection", taskId: admission.taskId, endpoint: { kind: "authenticated_websocket",
        websocketUrl: "wss://fixture.example.test/connect", generation: "fixture", secretHeaders: [] } });
      await vi.advanceTimersByTimeAsync(0);
      await expect(registration.ready()).rejects.toThrow("native_task_admission_expired");
      expect(ingress.connect).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); complete(undefined); await registration.release("detach"); await finishNativeTaskAdmission(db, admission); }
  });
});
