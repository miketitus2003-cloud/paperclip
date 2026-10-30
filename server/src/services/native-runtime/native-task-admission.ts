import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "../delivery-work-notifications.js";

const permits = new WeakSet<NativeTaskAdmission>();
const workerCalls = new WeakMap<NativeTaskAdmission, Set<object>>();
const hostCalls = new AsyncLocalStorage<NativeTaskAdmission | undefined>();
export const NATIVE_TASK_ADMISSION_TIMEOUT_MS = 30_000;

export interface NativeTaskAdmission {
  readonly id: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly taskId: string;
  readonly environmentId: string;
  readonly pluginId: string;
  readonly leaseOwner: string;
  readonly controllerGeneration: number;
  readonly expiresAtMs: number;
  readonly lifecycleVersion: number;
  readonly agentStatus: string;
  readonly runtimeRevision: string;
}

export function withNativeTaskAdmissionHostCall<T>(admission: NativeTaskAdmission | undefined, work: () => T): T {
  return hostCalls.run(admission, work);
}

export function currentNativeTaskAdmissionHostCall(): NativeTaskAdmission | undefined {
  return hostCalls.getStore();
}

export function trackNativeTaskAdmissionInvocation(admission: NativeTaskAdmission): () => void {
  const calls = workerCalls.get(admission) ?? new Set<object>(), call = {};
  workerCalls.set(admission, calls);
  calls.add(call);
  return () => { calls.delete(call); };
}

export function assertNativeTaskAdmissionPermit(admission: unknown, scope: {
  companyId: string; agentId: string; runId: string;
}): asserts admission is NativeTaskAdmission {
  const value = admission as NativeTaskAdmission | null;
  if (!value || !permits.has(value) || value.companyId !== scope.companyId || value.agentId !== scope.agentId ||
      value.runId !== scope.runId || value.expiresAtMs <= Date.now()) {
    throw new Error("native_task_admission_expired");
  }
}

export async function beginNativeTaskAdmission(db: Db, scope: {
  companyId: string; agentId: string; runId: string; leaseId: string; leaseOwner: string;
}, timeoutMs = NATIVE_TASK_ADMISSION_TIMEOUT_MS): Promise<NativeTaskAdmission> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > NATIVE_TASK_ADMISSION_TIMEOUT_MS) {
    throw new Error("native_task_admission_invalid_timeout");
  }
  const expiresAtMs = Date.now() + timeoutMs;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const assertDeadline = () => {
    if (expired || Date.now() >= expiresAtMs) throw new Error("native_task_admission_expired");
  };
  let wake = () => {}, changed = false;
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, () => { changed = true; wake(); });
  const acquisition = (async () => {
    for (;;) {
      assertDeadline();
      try {
        const admission = await db.transaction(async tx => {
          assertDeadline();
          await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, expiresAtMs - Date.now()))}, true),
            set_config('lock_timeout', ${String(Math.max(1, expiresAtMs - Date.now()))}, true)`);
          assertDeadline();
          const id = randomUUID();
          const [result] = await tx.execute<{ admission: {
            pluginId: string; taskId: string; environmentId: string; controllerGeneration: number; lifecycleVersion: number; agentStatus: string;
          } | null; blocked: boolean; cancelled: boolean }>(sql`
            with coordinator as materialized (
              select f.* from native_run_finalizations f
              where f.company_id = ${scope.companyId} and f.run_id = ${scope.runId}
                and f.lease_owner = ${scope.leaseOwner} and f.phase = 'observed'
                and f.lease_expires_at > clock_timestamp() for update
            ), bound_run as materialized (
              select r.*, l.status as lease_status, l.metadata as lease_metadata, l.environment_id as environment_id, l.provider_lease_id as task_id
              from heartbeat_runs r join coordinator c on c.run_id = r.id
              left join environment_leases l on l.id = ${scope.leaseId} and l.company_id = r.company_id and l.heartbeat_run_id = r.id
              where r.company_id = ${scope.companyId} and r.agent_id = ${scope.agentId} for update of r
            ), bound_agent as materialized (
              select a.* from agents a join bound_run r on r.agent_id = a.id and r.company_id = a.company_id
              for share of a nowait
            ), bound_plugin as materialized (
              select p.* from plugins p join bound_run r on p.id::text = r.lease_metadata->>'pluginId'
              join bound_agent a on a.id = r.agent_id
              for share of p nowait
            ), eligible as materialized (
              select c.run_id, c.controller_generation, a.lifecycle_version, a.status as agent_status,
                r.environment_id, r.task_id, p.id as plugin_id
              from coordinator c cross join bound_run r cross join bound_agent a cross join bound_plugin p
              where r.status = 'running' and r.lease_status = 'active' and r.environment_id is not null and r.task_id is not null and r.result_json->'startupCancellation' is null
                and not coalesce(r.result_json->'nativeCancellation'->>'scope' = 'run'
                  and r.result_json->'nativeCancellation'->>'dispatchState' in ('pending', 'acknowledged'), false)
                and a.lifecycle_state = 'ready' and a.status not in ('paused', 'terminated', 'pending_approval')
                and a.lifecycle_required_plugin_ids @> jsonb_build_array(p.id::text)
                and (a.runtime_mutation is null or coalesce((a.runtime_mutation->>'expiresAt')::timestamptz, 'infinity') <= clock_timestamp())
                and p.status = 'ready'
                and (not (p.runtime_mutations ? '*') or coalesce((p.runtime_mutations->'*'->>'expiresAt')::timestamptz, 'infinity') <= clock_timestamp())
                and (not (p.runtime_mutations ? ${scope.companyId}) or coalesce((p.runtime_mutations->${scope.companyId}->>'expiresAt')::timestamptz, 'infinity') <= clock_timestamp())
                and (c.admission_owner is null or c.admission_finished_at is not null or c.admission_expires_at <= clock_timestamp())
                and clock_timestamp() < ${new Date(expiresAtMs).toISOString()}::timestamptz
            ), claimed as (
              update native_run_finalizations f set admission_owner = ${id}, admission_expires_at = ${new Date(expiresAtMs).toISOString()}::timestamptz, admission_finished_at = null
              from eligible e where f.run_id = e.run_id and f.lease_owner = ${scope.leaseOwner}
                and f.controller_generation = e.controller_generation
              returning e.plugin_id as "pluginId", e.task_id as "taskId", e.environment_id as "environmentId", e.controller_generation as "controllerGeneration",
                e.lifecycle_version as "lifecycleVersion", e.agent_status as "agentStatus"
            ) select (select row_to_json(c) from claimed c) as admission,
              not (exists(select 1 from coordinator) and exists(select 1 from bound_run where status = 'running' and lease_status = 'active')
                and exists(select 1 from bound_agent where lifecycle_state = 'ready' and status not in ('paused', 'terminated', 'pending_approval'))
                and exists(select 1 from bound_plugin p cross join bound_agent a where p.status = 'ready'
                  and a.lifecycle_required_plugin_ids @> jsonb_build_array(p.id::text))) as blocked,
              exists(select 1 from bound_agent where status in ('paused', 'terminated')
                or lifecycle_state in ('pausing', 'terminating', 'cleaning_up')) as cancelled
          `);
          assertDeadline();
          if (result?.admission) {
            await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, expiresAtMs - Date.now()))}, true)`);
            assertDeadline();
            const [fresh] = await tx.execute<{ revision: string; enabled: boolean | null }>(sql`
              select coalesce((select v.id::text from resource_lifecycle_events v where v.company_id = ${scope.companyId}
                and v.resource_type = 'agent_runtime' and v.resource_id = ${scope.agentId} order by v.id desc limit 1), '0') as revision,
                s.enabled from environment_leases l join plugins p on p.id = ${result.admission.pluginId}
              left join plugin_company_settings s on s.plugin_id = p.id and s.company_id = ${scope.companyId}
              where l.id = ${scope.leaseId} and l.company_id = ${scope.companyId} and l.heartbeat_run_id = ${scope.runId}
                and l.status = 'active' and l.provider_lease_id = ${result.admission.taskId}
                and l.environment_id = ${result.admission.environmentId} and l.metadata->>'pluginId' = p.id::text
                and coalesce(l.metadata->>'runnerTaskRetiring', 'false') != 'true'
                and (l.expires_at is null or l.expires_at > clock_timestamp())
            `);
            assertDeadline();
            if (!fresh || fresh.enabled === false) throw new Error("native_task_admission_blocked");
            return { ...scope, ...result.admission, runtimeRevision: fresh.revision, id, expiresAtMs };
          }
          if (result?.cancelled) throw new Error("native_task_admission_cancelled");
          if (result?.blocked) throw new Error("native_task_admission_blocked");
          return null;
        });
        if (admission) return admission;
      } catch (error) {
        const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
        if (code !== "55P03") throw error;
      }
      assertDeadline();
      if (changed) { changed = false; continue; }
      await new Promise<void>(resolve => {
        const waiting = setTimeout(resolve, Math.min(50, expiresAtMs - Date.now()));
        wake = () => { clearTimeout(waiting); resolve(); };
      });
      changed = false;
    }
  })();
  try {
    const admission = await Promise.race([acquisition, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("native_task_admission_expired")); },
        Math.max(0, expiresAtMs - Date.now()));
    })]);
    assertDeadline();
    permits.add(admission);
    return admission;
  } catch (error) {
    void acquisition.then(late => finishNativeTaskAdmission(db, late)).catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer); unsubscribe(); }
}

export async function assertNativeTaskAdmissionCurrent(db: Db, admission: NativeTaskAdmission): Promise<void> {
  assertNativeTaskAdmissionPermit(admission, admission);
  const [current] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(environmentLeases, and(eq(environmentLeases.id, admission.leaseId), eq(environmentLeases.companyId, admission.companyId),
      eq(environmentLeases.heartbeatRunId, admission.runId), eq(environmentLeases.environmentId, admission.environmentId),
      eq(environmentLeases.providerLeaseId, admission.taskId),
      eq(environmentLeases.status, "active"), sql`coalesce(${environmentLeases.metadata}->>'runnerTaskRetiring', 'false') != 'true'`,
      sql`(${environmentLeases.expiresAt} is null or ${environmentLeases.expiresAt} > clock_timestamp())`,
      sql`${environmentLeases.metadata}->>'pluginId' = ${admission.pluginId}`))
    .where(and(
    eq(nativeRunFinalizations.companyId, admission.companyId), eq(nativeRunFinalizations.runId, admission.runId),
    eq(nativeRunFinalizations.admissionOwner, admission.id), eq(nativeRunFinalizations.leaseOwner, admission.leaseOwner),
    sql`${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp()`,
    eq(nativeRunFinalizations.controllerGeneration, admission.controllerGeneration), isNull(nativeRunFinalizations.admissionFinishedAt),
    sql`${nativeRunFinalizations.admissionExpiresAt} > clock_timestamp()`,
  ));
  assertNativeTaskAdmissionPermit(admission, admission);
  if (!current) throw new Error("native_task_admission_lost");
}

export async function finishNativeTaskAdmission(db: Db, admission: NativeTaskAdmission): Promise<void> {
  if (workerCalls.get(admission)?.size) return;
  try {
    await db.transaction(async tx => {
      await notifyDeliveryWork(tx as unknown as Db, DELIVERY_QUEUES.agentLifecycle);
      await tx.update(nativeRunFinalizations).set({ admissionFinishedAt: sql`clock_timestamp()` }).where(and(
        eq(nativeRunFinalizations.companyId, admission.companyId), eq(nativeRunFinalizations.runId, admission.runId),
        eq(nativeRunFinalizations.admissionOwner, admission.id),
        eq(nativeRunFinalizations.controllerGeneration, admission.controllerGeneration), isNull(nativeRunFinalizations.admissionFinishedAt),
      ));
    });
  } finally { permits.delete(admission); }
}

export async function pendingNativeTaskAdmissionDeadline(db: Db, companyId: string, agentIds: readonly string[]): Promise<Date | null> {
  if (!agentIds.length) return null;
  const [pending] = await db.select({ deadline: sql<string | null>`min(${nativeRunFinalizations.admissionExpiresAt})` })
    .from(nativeRunFinalizations).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.companyId, companyId), inArray(heartbeatRuns.agentId, [...agentIds]),
      isNull(nativeRunFinalizations.admissionFinishedAt), sql`${nativeRunFinalizations.admissionOwner} is not null`,
      sql`${nativeRunFinalizations.admissionExpiresAt} > clock_timestamp()`));
  return pending?.deadline ? new Date(pending.deadline) : null;
}

export async function waitForNativeTaskAdmissions(db: Db, companyId: string, agentIds: readonly string[]): Promise<void> {
  let wake = () => {}, changed = false;
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, () => { changed = true; wake(); });
  try {
    for (;;) {
      const deadline = await pendingNativeTaskAdmissionDeadline(db, companyId, agentIds);
      if (!deadline) return;
      if (changed) { changed = false; continue; }
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.min(250, Math.max(1, deadline.getTime() - Date.now())));
        wake = () => { clearTimeout(timer); resolve(); };
      });
      changed = false;
    }
  } finally { unsubscribe(); }
}
