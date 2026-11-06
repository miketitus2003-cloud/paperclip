import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { execute } from "./execute.js";

// Real loopback sockets, synthetic Gateway responses, no provider or Paperclip API calls.
describe("concurrent OpenClaw worker isolation", () => {
  it.each([false, true])("keeps worker receipts separate (Vision receipt mismatched=%s)", async (mismatchVision) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const workers = ["jarvis", "vision", "codex"];
    const requests: Record<string, unknown>[] = [];
    const waiting: Array<{ socket: WebSocket; id: string; worker: string }> = [];
    const problems: string[] = [];
    server.on("connection", (socket) => {
      let worker = "";
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "synthetic" } }));
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString());
        if (request.method === "connect") {
          send({ type: "res", id: request.id, ok: true, payload: { protocol: 3 } });
        } else if (request.method === "agent") {
          requests.push(request.params);
          worker = request.params.agentId;
          send({ type: "res", id: request.id, ok: true, payload: { status: "accepted", runId: `remote-${worker}` } });
        } else if (request.method === "agent.wait") {
          if (request.params.runId !== `remote-${worker}`) problems.push("wait crossed worker boundary");
          waiting.push({ socket, id: request.id, worker });
          // All three executions must be in flight before any receives completion.
          if (waiting.length !== 3) return;
          for (const entry of [...waiting].reverse()) {
            // Foreign events on each socket must not satisfy or contaminate its receipt.
            for (const eventWorker of workers.filter((value) => value !== entry.worker).concat(entry.worker)) {
              entry.socket.send(JSON.stringify({ type: "event", event: "agent", payload: {
                runId: `remote-${eventWorker}`, stream: "assistant", data: { text: `OK_${eventWorker}` },
              } }));
            }
            entry.socket.send(JSON.stringify({ type: "res", id: entry.id, ok: true, payload: {
              status: "ok", runId: mismatchVision && entry.worker === "vision" ? "remote-jarvis" : `remote-${entry.worker}`,
            } }));
          }
        } else {
          problems.push(`unexpected method ${request.method}`);
        }
      });
    });
    try {
      const results = await Promise.all(workers.map((worker, index) => execute({
        runId: `run-${worker}`,
        agent: { id: `paperclip-${worker}`, companyId: "synthetic-company", name: worker,
          adapterType: "openclaw_gateway", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
          disableDeviceAuth: true, autoPairOnFirstConnect: false, timeoutSec: 3, waitTimeoutMs: 2_000,
          strictReceiptExpectedResponse: `OK_${worker}`,
          claimedApiKeyPath: `/synthetic/keys/${worker}.json`,
          ...(index === 1 ? { payloadTemplate: { agentId: worker } } : { agentId: worker }),
        },
        context: { issueId: `issue-${worker}`, taskId: `issue-${worker}` },
        onLog: async () => {},
      } satisfies AdapterExecutionContext)));
      expect(problems).toEqual([]);
      expect(waiting).toHaveLength(3);
      expect(results.map((result) => result.exitCode)).toEqual([0, mismatchVision ? 1 : 0, 0]);
      if (mismatchVision) expect(results[1]?.errorCode).toBe("openclaw_gateway_receipt_run_id_mismatch");
      for (const worker of workers) {
        const request = requests.find((value) => value.agentId === worker)!;
        expect(request).toMatchObject({ agentId: worker,
          sessionKey: `agent:${worker}:paperclip:issue:issue-${worker}`, idempotencyKey: `run-${worker}` });
        expect(request.message).toContain(`paperclip-${worker}`);
        expect(request.message).toContain(`/synthetic/keys/${worker}.json`);
        for (const other of workers.filter((value) => value !== worker)) {
          expect(request.message).not.toContain(`paperclip-${other}`);
          expect(request.message).not.toContain(`/synthetic/keys/${other}.json`);
        }
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
