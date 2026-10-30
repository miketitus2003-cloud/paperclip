import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { pendingNativeTaskAdmissionDeadline } from "./native-task-admission.js";

type Mutation = { db: Db; agentId: string; companyId: string; owner: string; deadline: number; active: boolean };
const mutations = new AsyncLocalStorage<Mutation>();
const timeoutMs = 60_000;

export async function assertAgentRuntimeMutation(tx: Db, companyId: string): Promise<void> {
  const mutation = mutations.getStore();
  if (!mutation) return;
  if (!mutation.active || mutation.companyId !== companyId || performance.now() >= mutation.deadline) {
    throw conflict("Agent configuration mutation expired");
  }
  await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(mutation.deadline - performance.now())))}, true)`);
  const [agent] = await tx.select({ pending: agents.runtimeMutation,
    now: sql<Date>`clock_timestamp()`.mapWith(agents.updatedAt) }).from(agents)
    .where(and(eq(agents.id, mutation.agentId), eq(agents.companyId, companyId))).for("update");
  if (!agent || agent.pending?.owner !== mutation.owner || Date.parse(agent.pending.expiresAt) <= agent.now.getTime()) {
    throw conflict("Agent configuration mutation ownership expired");
  }
}

export async function withAgentRuntimeMutation<T>(db: Db, agentId: string, write: () => Promise<T>): Promise<T> {
  const owner = randomUUID(), deadline = performance.now() + timeoutMs;
  let mutation: Mutation | undefined, claimed = false, wake = () => {}, changed = false;
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, () => { changed = true; wake(); });
  const remaining = () => {
    const value = Math.floor(deadline - performance.now());
    if (value <= 0) throw conflict("Agent configuration mutation timed out; retry the same change");
    return value;
  };
  const wait = async (until: Date | null) => {
    if (changed) { changed = false; return; }
    const delay = Math.min(remaining(), until ? Math.min(250, Math.max(1, until.getTime() - Date.now())) : 50);
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, delay); wake = () => { clearTimeout(timer); resolve(); }; });
    changed = false;
  };
  try {
    while (!claimed) {
      remaining();
      let blockedUntil: Date | null = null;
      try {
        claimed = await db.transaction(async tx => {
          const [agent] = await tx.select({ companyId: agents.companyId, pending: agents.runtimeMutation,
            now: sql<Date>`clock_timestamp()`.mapWith(agents.updatedAt) }).from(agents).where(eq(agents.id, agentId))
            .for("update", { noWait: true });
          if (!agent) return true;
          if (agent.pending && Date.parse(agent.pending.expiresAt) > agent.now.getTime()) {
            blockedUntil = new Date(agent.pending.expiresAt); return false;
          }
          await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
          await tx.update(agents).set({ runtimeMutation: { owner, expiresAt: new Date(agent.now.getTime() + remaining()).toISOString() } })
            .where(eq(agents.id, agentId));
          mutation = { db, agentId, companyId: agent.companyId, owner, deadline, active: true };
          return true;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03" && (error as { cause?: { code?: string } }).cause?.code !== "55P03") throw error;
      }
      if (!claimed) await wait(blockedUntil);
    }
    if (!mutation) return write();
    for (;;) {
      remaining();
      const pending = await pendingNativeTaskAdmissionDeadline(db, mutation.companyId, [agentId]);
      if (!pending) break;
      await wait(pending);
    }
    remaining();
    return await mutations.run(mutation, write);
  } finally {
    if (mutation) mutation.active = false;
    unsubscribe();
    if (mutation && claimed) await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
      await tx.update(agents).set({ runtimeMutation: null }).where(and(eq(agents.id, agentId),
        eq(agents.companyId, mutation!.companyId), sql`${agents.runtimeMutation}->>'owner' = ${owner}`));
    });
  }
}
