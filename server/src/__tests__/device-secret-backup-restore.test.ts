import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  ensurePostgresDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@paperclipai/db";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function ed25519Fingerprint(privateKeyPem: string): string {
  const publicKeyDer = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" });
  return createHash("sha256").update(publicKeyDer).digest("hex");
}

function expectSameDeviceIdentity(expectedPrivateKeyPem: string, restoredPrivateKey: unknown) {
  expect(typeof restoredPrivateKey).toBe("string");
  const resolvedPem = restoredPrivateKey as string;
  expect(ed25519Fingerprint(resolvedPem)).toBe(ed25519Fingerprint(expectedPrivateKeyPem));

  const message = Buffer.from("synthetic backup restore device identity verification");
  const signature = sign(null, message, createPrivateKey(resolvedPem));
  expect(verify(null, message, createPublicKey(createPrivateKey(expectedPrivateKeyPem)), signature)).toBe(true);
}

async function runCleanup(actions: Array<() => Promise<unknown> | unknown>, label: string) {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${label} cleanup failed`);
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping synthetic secret backup/restore test: ${embeddedPostgresSupport.reason ?? "embedded Postgres unavailable"}`);
}

describeEmbeddedPostgres("synthetic encrypted device secret backup and restore", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let sourceConnectionString = "";
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretStoreDir = path.join(os.tmpdir(), `paperclip-secret-restore-key-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretStoreDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretStoreDir, "synthetic-master.key");
    const started = await startEmbeddedPostgresTestDatabase("paperclip-secret-restore-source-");
    stopDb = started.cleanup;
    sourceConnectionString = started.connectionString;
    db = createDb(sourceConnectionString);
  }, 20_000);

  afterAll(async () => {
    await runCleanup([
      () => db?.$client.end({ timeout: 1 }),
      () => stopDb?.(),
      () => {
        if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
        else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      },
      () => rmSync(secretStoreDir, { recursive: true, force: true }),
    ], "synthetic secret database");
  });

  it("restores encrypted secret metadata and resolves the same synthetic Ed25519 identity", async () => {
    const companyId = randomUUID();
    const agentName = `Synthetic device secret restore ${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic backup restore company",
      issuePrefix: `B${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const generated = generateKeyPairSync("ed25519");
    const syntheticPrivateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const createdAgent = await createAgentLifecycle(db).requestHire(companyId, {
      name: agentName,
      role: "engineer",
      status: "idle",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://gateway.invalid:18791",
        devicePrivateKeyPem: syntheticPrivateKeyPem,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    const [sourceAgent] = await db.select().from(agents).where(eq(agents.id, createdAgent.id));
    const sourceConfig = sourceAgent.adapterConfig as Record<string, unknown>;
    expect(sourceConfig.devicePrivateKeyPem).toMatchObject({ type: "secret_ref", version: "latest" });
    expect(JSON.stringify(sourceConfig)).not.toContain(syntheticPrivateKeyPem);

    const backupDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-synthetic-secret-backup-"));
    const targetName = `paperclip_restore_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(sourceConnectionString);
    adminUrl.pathname = "/postgres";
    const targetUrl = new URL(sourceConnectionString);
    targetUrl.pathname = `/${targetName}`;
    const adminDb = createDb(adminUrl.toString());
    let restoredDb: ReturnType<typeof createDb> | null = null;

    try {
      const backup = await runDatabaseBackup({
        connectionString: sourceConnectionString,
        backupDir,
        backupEngine: "javascript",
        retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
      });
      await ensurePostgresDatabase(adminUrl.toString(), targetName);
      await runDatabaseRestore({ connectionString: targetUrl.toString(), backupFile: backup.backupFile });

      restoredDb = createDb(targetUrl.toString());
      const [restoredAgent] = await restoredDb.select().from(agents).where(eq(agents.id, createdAgent.id));
      expect(restoredAgent).toBeDefined();
      const restoredConfig = restoredAgent.adapterConfig as Record<string, unknown>;
      expect(restoredConfig.devicePrivateKeyPem).toEqual(sourceConfig.devicePrivateKeyPem);
      expect(JSON.stringify(restoredConfig)).not.toContain(syntheticPrivateKeyPem);

      const resolved = await secretService(restoredDb).resolveAdapterConfigForRuntime(
        companyId,
        restoredConfig,
        { consumerType: "agent", consumerId: createdAgent.id },
        { adapterType: "openclaw_gateway" },
      );
      expectSameDeviceIdentity(syntheticPrivateKeyPem, resolved.config.devicePrivateKeyPem);
    } finally {
      await runCleanup([
        () => restoredDb?.$client.end({ timeout: 1 }),
        () => adminDb.$client.unsafe(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`),
        () => adminDb.$client.end({ timeout: 1 }),
        () => rmSync(backupDir, { recursive: true, force: true }),
      ], "synthetic backup/restore target");
    }
  }, 90_000);
});
