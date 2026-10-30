import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";

const stop = vi.hoisted(() => vi.fn(async () => true));
const pendingAdmission = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../../services/heartbeat.js", () => ({ heartbeatService: () => ({ stopInvocationsForAgents: stop }) }));
vi.mock("../../../services/agent-harness-verification.js", () => ({ agentHarnessVerificationService: () => ({ verify: vi.fn() }) }));
vi.mock("../../../services/native-runtime/native-task-admission.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../../services/native-runtime/native-task-admission.js")>(),
  pendingNativeTaskAdmissionDeadline: pendingAdmission,
}));
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";

describe("lifecycle host stop scope", () => {
  it("pauses only the requested agent without loading its company peers", async () => {
    const db = { select: vi.fn(() => { throw new Error("No peer lookup expected"); }) } as unknown as Db;
    const driver = createLifecycleDriver(db, {} as never);
    expect(await driver.runHost({ id: "target", companyId: "company", lifecycleState: "pausing",
      lifecycleVersion: 2, lifecycleRequiredPluginIds: [], lifecycleError: null, lifecycleOperation: null })).toBe("complete");
    expect(stop).toHaveBeenCalledWith(["target"], "Agent lifecycle stop requested");
    expect(pendingAdmission).toHaveBeenCalledWith(db, "company", ["target"]);
    expect(db.select).not.toHaveBeenCalled();
  });
});
