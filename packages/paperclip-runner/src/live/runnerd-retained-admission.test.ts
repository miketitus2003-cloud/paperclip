import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";

it("retains an expired admission failure before attach or a later turn can start", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runner-retained-admission-"));
  const admission = vi.fn(async (_work: () => Promise<void>) => { throw new Error("native_task_admission_expired"); });
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory, withRetainedRunAdmission: admission });
  try {
    await expect(bundle.transport.attachRun!({ runId: "run", turnId: "turn", itemId: "item" }))
      .rejects.toThrow("native_task_admission_expired");
    await expect(bundle.transport.attachRun!({ runId: "late-run", turnId: "late-turn", itemId: "late-item" }))
      .rejects.toThrow("native_task_admission_expired");
    await expect(bundle.transport.request("turn/start", { input: [{ type: "text", text: "Fixture task" }] }))
      .rejects.toThrow("native_task_admission_expired");
    expect(admission).toHaveBeenCalledOnce();
    expect(bundle.evidence().runnerPid).toBeNull();
  } finally { await bundle.transport.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});

it("keeps unrelated preparation failures outside the admission expiry fence", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runner-retained-admission-error-"));
  const admission = vi.fn(async (_work: () => Promise<void>) => { throw new Error("fixture preparation rejected"); });
  const bundle = createCapabilityRunnerdCodexTransport({ stateDirectory, withRetainedRunAdmission: admission });
  try {
    for (const runId of ["first", "retry"]) {
      await expect(bundle.transport.attachRun!({ runId, turnId: "turn", itemId: "item" }))
        .rejects.toThrow("fixture preparation rejected");
    }
    expect(admission).toHaveBeenCalledTimes(2);
    expect(bundle.evidence().runnerPid).toBeNull();
  } finally { await bundle.transport.close(); await rm(stateDirectory, { recursive: true, force: true }); }
});
