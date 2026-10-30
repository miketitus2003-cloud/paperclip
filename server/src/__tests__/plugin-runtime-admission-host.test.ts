import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companySecrets, createDb, environmentLeases, environments, heartbeatRuns, issues, nativeRunFinalizations, plugins } from "@paperclipai/db";
import { createHostClientHandlers, type HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { beginNativeTaskAdmission, currentNativeTaskAdmissionHostCall, finishNativeTaskAdmission,
  withNativeTaskAdmissionHostCall } from "../services/native-runtime/native-task-admission.js";
import { secretService } from "../services/secrets.js";
import * as instructionModule from "../services/agent-instructions.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("issued native admission in worker host calls", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const cleanups: Array<() => Promise<unknown>> = [];
  beforeAll(async () => {
    home = await mkdtemp(path.join(tmpdir(), "native-admission-host-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("native-admission-host-");
    db = createDb(database.connectionString, { maxConnections: 8 });
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seed(existingPluginId?: string) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(),
      pluginId = existingPluginId ?? randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), leaseOwner = randomUUID();
    const manifest = { id: `admission-${pluginId}`, apiVersion: 1 as const, version: "1.0.0", displayName: "Admission fixture",
      description: "Fixture", author: "Paperclip", categories: ["automation" as const], capabilities: ["agents.lifecycle.manage" as const],
      entrypoints: { worker: "./worker.js" }, resourceLifecycle: ["agent_runtime" as const] };
    await db.insert(companies).values({ id: companyId, name: "Admission host", issuePrefix: `H${companyId.slice(0, 7)}` });
    if (!existingPluginId) await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "admission-host-fixture", version: "1.0.0", status: "ready", manifestJson: manifest });
    await db.insert(environments).values({ id: environmentId, name: `Admission ${environmentId}`, driver: "plugin" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Admission agent", status: "running", lifecycleState: "ready", lifecycleVersion: 7,
      adapterType: "paperclip_runner", lifecycleRequiredPluginIds: [pluginId], defaultEnvironmentId: environmentId });
    await db.insert(issues).values({ id: issueId, companyId, title: "Admission task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, providerLeaseId: `task-${runId}`, status: "active", metadata: { pluginId } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 2,
      leaseOwner, controllerGeneration: 3, leaseExpiresAt: new Date(Date.now() + 60_000) });
    const scope = { companyId, agentId, runId, leaseId, leaseOwner, pluginId };
    await secretService(db).agentInstance.set({ companyId, agentId, pluginId }, "runtime", "disposable-runtime-value");
    const admission = await beginNativeTaskAdmission(db, scope);
    cleanups.push(() => finishNativeTaskAdmission(db, admission));
    return { ...scope, environmentId, admission, manifest };
  }

  async function worker(f: Awaited<ReturnType<typeof seed>>, inspect?: () => Promise<void>) {
    const services = buildHostServices(db, f.pluginId, f.manifest.id, createPluginEventBus(), undefined, { manifest: f.manifest });
    const handlers = createHostClientHandlers({ pluginId: f.pluginId, capabilities: f.manifest.capabilities, services });
    if (inspect) {
      const original = handlers["agents.getRuntimeIdentity"];
      handlers["agents.getRuntimeIdentity"] = async (params, context) => { await inspect(); return original(params, context); };
    }
    const handle = createPluginWorkerHandle(f.pluginId, {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-native-admission.cjs", import.meta.url)),
      manifest: f.manifest, config: {}, instanceInfo: { instanceId: "fixture", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: handlers,
    });
    cleanups.push(async () => { await handle.stop(); services.dispose(); });
    await handle.start();
    return { handle, services };
  }

  function params(f: Awaited<ReturnType<typeof seed>>, config: Record<string, unknown> = {}, issued = true): HostToWorkerMethods["environmentTask"][0] {
    const a = f.admission;
    return { driverKey: "fixture", companyId: f.companyId, environmentId: f.environmentId, agentId: f.agentId, runId: f.runId,
      taskId: a.taskId, projectIds: [], config, operation: { kind: "status" }, lease: { providerLeaseId: a.taskId,
        metadata: issued ? { runnerTaskAdmission: { id: a.id, expiresAtMs: a.expiresAtMs,
          lifecycleVersion: a.lifecycleVersion, agentStatus: a.agentStatus, runtimeRevision: a.runtimeRevision } } : {} } };
  }

  it("projects the admitted ready identity after pause and retains live secret reads", async () => {
    const f = await seed(), { handle } = await worker(f);
    await db.update(agents).set({ status: "paused", lifecycleState: "pausing", lifecycleVersion: 8 }).where(eq(agents.id, f.agentId));
    const result = await handle.call("environmentTask", params(f), undefined, undefined, undefined, f.admission);
    expect(result).toMatchObject({ revision: f.admission.runtimeRevision, agent: {
      id: f.agentId, companyId: f.companyId, status: "running", lifecycleState: "ready", lifecycleVersion: 7 },
      instanceSecrets: { runtime: "disposable-runtime-value" } });
    expect(currentNativeTaskAdmissionHostCall()).toBeUndefined();
    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.ownerAgentId, f.agentId));
    expect(await handle.call("environmentTask", params(f), undefined, undefined, undefined, f.admission))
      .toMatchObject({ instanceSecrets: {} });
    const current = await handle.call("environmentTask", params(f, {}, false));
    expect(current).toMatchObject({ agent: { status: "paused", lifecycleState: "pausing", lifecycleVersion: 8 } });
  });

  it("rejects unissued, cloned, and mismatched wire authority before dispatch", async () => {
    const f = await seed(), inspect = vi.fn(async () => undefined), { handle } = await worker(f, inspect);
    await expect(handle.call("environmentTask", params(f))).rejects.toThrow("native_task_admission_unissued");
    await expect(handle.call("environmentTask", params(f), undefined, undefined, undefined, { ...f.admission })).rejects.toThrow("native_task_admission_expired");
    for (const field of ["companyId", "agentId", "runId", "environmentId", "taskId"] as const) {
      await expect(handle.call("environmentTask", { ...params(f), [field]: randomUUID() }, undefined, undefined, undefined, f.admission))
        .rejects.toThrow(/native_task_admission_/);
    }
    const forged = params(f);
    forged.lease.metadata!.runnerTaskAdmission = { id: randomUUID() };
    await expect(handle.call("environmentTask", forged, undefined, undefined, undefined, f.admission)).rejects.toThrow("native_task_admission_scope_mismatch");
    expect(inspect).not.toHaveBeenCalled();
    await handle.call("environmentTask", params(f), undefined, undefined, undefined, f.admission);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each(["agent", "environment", "unknown invocation"])("rejects a worker's %s substitution", async kind => {
    const f = await seed(), { handle } = await worker(f);
    const config = kind === "agent" ? { agentId: randomUUID() }
      : kind === "environment" ? { hostMethod: "agents.getRuntime", environmentId: randomUUID() } : { unknownInvocation: true };
    await expect(handle.call("environmentTask", params(f, config), undefined, undefined, undefined, f.admission)).rejects.toThrow();
  });

  it("bounds a hung worker by the admission budget remaining after claim", async () => {
    const f = await seed(), { handle } = await worker(f);
    const now = vi.spyOn(Date, "now").mockReturnValue(f.admission.expiresAtMs - 100);
    try {
      await expect(handle.call("environmentTask", params(f, { ignore: true }), 5_000, undefined, undefined, f.admission))
        .rejects.toThrow("timed out after 100ms");
    } finally { now.mockRestore(); }
  });

  it("fails closed for lost or expired markers before returning identity", async () => {
    const f = await seed(), { services } = await worker(f);
    await db.update(nativeRunFinalizations).set({ admissionOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(withNativeTaskAdmissionHostCall(f.admission, () => services.agents.getRuntimeIdentity!({ companyId: f.companyId, agentId: f.agentId })))
      .rejects.toThrow("native_task_admission_lost");
    const now = vi.spyOn(Date, "now").mockReturnValue(f.admission.expiresAtMs + 1);
    try {
      await expect(withNativeTaskAdmissionHostCall(f.admission, () => services.agents.getRuntimeIdentity!({ companyId: f.companyId, agentId: f.agentId })))
        .rejects.toThrow("native_task_admission_expired");
    } finally { now.mockRestore(); }
  });

  it("rechecks durable owner after full-state hydration settles", async () => {
    const f = await seed(), { services } = await worker(f);
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = instructionModule.agentInstructionsService;
    vi.spyOn(instructionModule, "agentInstructionsService").mockImplementation(() => ({ ...original(),
      getBundleLocation: async agent => { started(); await gate; return original().getBundleLocation(agent); },
    }));
    const pending = withNativeTaskAdmissionHostCall(f.admission, () => services.agents.getRuntime!({ companyId: f.companyId, agentId: f.agentId, environmentId: f.environmentId }));
    try {
      await ready;
      await db.update(nativeRunFinalizations).set({ admissionOwner: randomUUID() }).where(eq(nativeRunFinalizations.runId, f.runId));
    } finally { release(); }
    await expect(pending).rejects.toThrow("native_task_admission_lost");
  });

  it("isolates overlapping invocation admissions in one worker", async () => {
    const a = await seed(), b = await seed(a.pluginId);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    const seen: string[] = [];
    const { handle } = await worker(a, async () => {
      const admission = currentNativeTaskAdmissionHostCall()!;
      if (admission.agentId === a.agentId && !held) { held = true; entered(); await gate; }
      expect(currentNativeTaskAdmissionHostCall()).toBe(admission);
      seen.push(admission.agentId);
    });
    const first = handle.call("environmentTask", params(a), undefined, undefined, undefined, a.admission);
    try {
      await ready;
      const second = await handle.call("environmentTask", params(b), undefined, undefined, undefined, b.admission);
      expect(second).toMatchObject({ agent: { id: b.agentId } });
    } finally { release(); }
    expect(await first).toMatchObject({ agent: { id: a.agentId } });
    expect(seen).toEqual([b.agentId, a.agentId]);
  });
});
