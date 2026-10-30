import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { agents, plugins, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { pendingNativeTaskAdmissionDeadline } from "./native-task-admission.js";

const mutationTimeoutMs = 60_000;
type Mutation = { owner: string; expiresAt: string };
type Mutations = Record<string, Mutation>;

function liveMutations(value: Mutations, now: Date): Mutations {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (!entry.owner || !Number.isFinite(Date.parse(entry.expiresAt))) throw conflict("Plugin runtime mutation state is invalid");
    return Date.parse(entry.expiresAt) > now.getTime();
  }));
}

export async function withPluginRuntimeMutation<T>(
  db: Db, pluginId: string, companyId: string | null, write: (tx: Db) => Promise<T>,
): Promise<T> {
  const owner = randomUUID(), key = companyId ?? "*", deadline = performance.now() + mutationTimeoutMs;
  let claimed = false, wake = () => {}, changed = false;
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, () => { changed = true; wake(); });
  const remaining = () => {
    const milliseconds = Math.floor(deadline - performance.now());
    if (milliseconds <= 0) throw conflict("Plugin runtime mutation timed out; retry the same change");
    return milliseconds;
  };
  const wait = async (until: Date | null) => {
    if (changed) { changed = false; return; }
    const milliseconds = Math.min(remaining(), until ? Math.min(250, Math.max(1, until.getTime() - Date.now())) : 50);
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, milliseconds);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    changed = false;
  };
  try {
    while (!claimed) {
      remaining();
      let blockedUntil: Date | null = null;
      try {
        claimed = await db.transaction(async tx => {
          const [row] = await tx.select({ mutations: plugins.runtimeMutations,
            now: sql<Date>`clock_timestamp()`.mapWith(plugins.updatedAt) }).from(plugins)
            .where(eq(plugins.id, pluginId)).for("update", { noWait: true });
          if (!row) throw notFound("Plugin not found");
          const mutations = liveMutations(row.mutations, row.now);
          const blocker = mutations["*"] ?? mutations[key];
          if (blocker) { blockedUntil = new Date(blocker.expiresAt); return false; }
          await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
          await tx.update(plugins).set({ runtimeMutations: { ...mutations, [key]: {
            owner, expiresAt: new Date(row.now.getTime() + remaining()).toISOString(),
          } } }).where(eq(plugins.id, pluginId));
          return true;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03" && (error as { cause?: { code?: string } }).cause?.code !== "55P03") throw error;
      }
      if (!claimed) await wait(blockedUntil);
    }

    const owners = await db.select({ id: agents.id, companyId: agents.companyId }).from(agents)
      .where(and(companyId ? eq(agents.companyId, companyId) : undefined,
        sql`${agents.lifecycleRequiredPluginIds} @> ${JSON.stringify([pluginId])}::jsonb`))
      .orderBy(asc(agents.companyId), asc(agents.id));
    const companies = new Map<string, string[]>();
    for (const agent of owners) companies.set(agent.companyId, [...companies.get(agent.companyId) ?? [], agent.id]);
    for (;;) {
      remaining();
      const deadlines = await Promise.all([...companies].map(([company, ids]) => pendingNativeTaskAdmissionDeadline(db, company, ids)));
      if (key === "*") {
        const [row] = await db.select({ mutations: plugins.runtimeMutations,
          now: sql<Date>`clock_timestamp()`.mapWith(plugins.updatedAt) }).from(plugins).where(eq(plugins.id, pluginId));
        if (!row || row.mutations[key]?.owner !== owner) throw conflict("Plugin runtime mutation ownership changed");
        for (const [scope, entry] of Object.entries(liveMutations(row.mutations, row.now))) {
          if (scope !== key) deadlines.push(new Date(entry.expiresAt));
        }
      }
      const active = deadlines.filter((value): value is Date => value !== null);
      if (!active.length) break;
      await wait(new Date(Math.min(...active.map(value => value.getTime()))));
    }

    return await db.transaction(async transaction => {
      remaining();
      await transaction.execute(sql`select set_config('statement_timeout', ${String(remaining())}, true)`);
      const [row] = await transaction.select({ mutations: plugins.runtimeMutations,
        now: sql<Date>`clock_timestamp()`.mapWith(plugins.updatedAt) }).from(plugins)
        .where(eq(plugins.id, pluginId)).for("update");
      remaining();
      if (!row || row.mutations[key]?.owner !== owner || Date.parse(row.mutations[key].expiresAt) <= row.now.getTime()) {
        throw conflict("Plugin runtime mutation ownership expired");
      }
      const expiresAt = Date.parse(row.mutations[key].expiresAt);
      const result = await write(transaction as unknown as Db);
      const [clock] = await transaction.execute<{ now: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as now`);
      remaining();
      if (Number(clock.now) >= expiresAt) throw conflict("Plugin runtime mutation ownership expired");
      return result;
    });
  } finally {
    unsubscribe();
    if (claimed) await db.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle);
      await tx.update(plugins).set({ runtimeMutations: sql`${plugins.runtimeMutations} - ${key}` })
        .where(and(eq(plugins.id, pluginId), sql`${plugins.runtimeMutations}->${key}->>'owner' = ${owner}`));
    });
  }
}
