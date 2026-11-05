import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenClawGatewayConfig } from "../ui/build-config.js";

const expectedRunId = "gateway-pilot-run-42";
const expectedResponse = "JARVIS_PILOT_OK";
const task = "Reply exactly JARVIS_PILOT_OK and nothing else.";

const gateway = vi.hoisted(() => ({
  requests: [] as Array<{ id: string; method: string; params?: Record<string, unknown> }>,
  authorization: "",
  acceptedStatus: "accepted",
  acceptedRunId: "gateway-pilot-run-42" as string | undefined,
  acceptedExtra: {} as Record<string, unknown>,
  waitStatus: "ok" as string | undefined,
  waitError: undefined as string | undefined,
  waitRunId: "gateway-pilot-run-42" as string | undefined,
  eventRunId: "gateway-pilot-run-42" as string | undefined,
  lifecyclePhase: undefined as string | undefined,
  conflictingAssistantText: undefined as string | undefined,
  responseText: "JARVIS_PILOT_OK",
  waitExtra: {} as Record<string, unknown>,
  assistantEventTiming: "before_wait_response" as "before_wait_response" | "after_wait_response" | "missing",
  agentError: undefined as string | undefined,
}));

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");

  class MockGatewaySocket extends EventEmitter {
    static readonly OPEN = 1;
    readonly readyState = MockGatewaySocket.OPEN;

    constructor(_url: string, options: { headers?: Record<string, string> } = {}) {
      super();
      gateway.authorization = options.headers?.authorization ?? "";
      queueMicrotask(() => {
        this.emit("open");
        this.emit("message", JSON.stringify({
          type: "event", event: "connect.challenge", payload: { nonce: "synthetic-pilot-nonce" },
        }));
      });
    }

    send(raw: string) {
      const request = JSON.parse(raw) as { id: string; method: string; params?: Record<string, unknown> };
      gateway.requests.push(request);
      let payload: Record<string, unknown>;
      let assistantEvent: (() => void) | undefined;
      if (request.method === "connect") {
        payload = { protocol: 4 };
      } else if (request.method === "agent") {
        if (gateway.agentError) {
          queueMicrotask(() => this.emit("message", JSON.stringify({
            type: "res", id: request.id, ok: false, error: { message: gateway.agentError },
          })));
          return;
        }
        payload = {
          status: gateway.acceptedStatus,
          ...(gateway.acceptedRunId ? { runId: gateway.acceptedRunId } : {}),
          ...gateway.acceptedExtra,
        };
      } else if (request.method === "agent.wait") {
        if (gateway.waitError) {
          queueMicrotask(() => this.emit("message", JSON.stringify({
            type: "res", id: request.id, ok: false, error: { message: gateway.waitError },
          })));
          return;
        }
        assistantEvent = () => {
          if (gateway.lifecyclePhase) {
            this.emit("message", JSON.stringify({
              type: "event",
              event: "agent",
              payload: { runId: gateway.eventRunId, stream: "lifecycle", data: { phase: gateway.lifecyclePhase } },
            }));
          }
          this.emit("message", JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              ...(gateway.eventRunId ? { runId: gateway.eventRunId } : {}),
              stream: "assistant",
              data: { text: gateway.responseText, ...(gateway.conflictingAssistantText ? { delta: gateway.conflictingAssistantText } : {}) },
            },
          }));
        };
        payload = {
          ...(gateway.waitStatus === undefined ? {} : { status: gateway.waitStatus }),
          ...(gateway.waitRunId ? { runId: gateway.waitRunId } : {}),
          ...gateway.waitExtra,
        };
      } else {
        throw new Error(`Unexpected mocked Gateway method: ${request.method}`);
      }

      if (assistantEvent && gateway.assistantEventTiming === "before_wait_response") {
        queueMicrotask(assistantEvent);
      }
      queueMicrotask(() => this.emit("message", JSON.stringify({
        type: "res", id: request.id, ok: true, payload,
      })));
      if (assistantEvent && gateway.assistantEventTiming === "after_wait_response") {
        setTimeout(assistantEvent, 10);
      }
    }

    close() {}
  }

  return { WebSocket: MockGatewaySocket };
});

import { execute } from "./execute.js";

function context(): AdapterExecutionContext {
  const { privateKey } = generateKeyPairSync("ed25519");
  const paperclipValues = {
    adapterType: "openclaw_gateway",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "ws://127.0.0.1:18789",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: false,
    intervalSec: 0,
    authToken: "synthetic-gateway-token",
    scopes: "operator.read",
    autoPairOnFirstConnect: false,
    timeoutSec: 2,
    waitTimeoutMs: 1_000,
    strictReceiptExpectedResponse: expectedResponse,
  } satisfies CreateConfigValues;
  const paperclipBuiltConfig = buildOpenClawGatewayConfig(paperclipValues);
  return {
    runId: "paperclip-pilot-run-42",
    agent: {
      id: "jarvis-agent-fixture", companyId: "synthetic-company", name: "Jarvis fixture",
      adapterType: "openclaw_gateway", adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      ...paperclipBuiltConfig,
      devicePrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      scopes: ["operator.read"],
      payloadTemplate: { message: task },
    },
    context: { taskId: "synthetic-task-42", issueId: "synthetic-task-42", wakeReason: "manual_task" },
    onLog: async () => {},
  };
}

function verifySyntheticSignedConnect(request: (typeof gateway.requests)[number]): void {
  expect(request.method).toBe("connect");
  const params = request.params!;
  const device = params.device as { id: string; publicKey: string; signature: string; signedAt: number; nonce: string };
  expect(params.auth).toEqual({ token: "synthetic-gateway-token" });
  expect(device.nonce).toBe("synthetic-pilot-nonce");
  const rawKey = Buffer.from(device.publicKey, "base64url");
  expect(device.id).toBe(createHash("sha256").update(rawKey).digest("hex"));
  const client = params.client as { id: string; mode: string; platform: string; deviceFamily?: string };
  const scopes = params.scopes as string[];
  const signedPayload = ["v3", device.id, client.id, client.mode, params.role, scopes.join(","),
    String(device.signedAt), "synthetic-gateway-token", device.nonce, client.platform, client.deviceFamily ?? ""].join("|");
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
    format: "der", type: "spki",
  });
  expect(verify(null, Buffer.from(signedPayload), publicKey, Buffer.from(device.signature, "base64url"))).toBe(true);
}

function validatePilotReceipt(
  result: AdapterExecutionResult,
  requests: typeof gateway.requests,
  expectedId = expectedRunId,
): void {
  const agentRequests = requests.filter((request) => request.method === "agent");
  expect(agentRequests).toHaveLength(1);
  expect(agentRequests[0]!.params?.idempotencyKey).toBe("paperclip-pilot-run-42");
  const message = String(agentRequests[0]!.params?.message ?? "");
  expect(message.split(task)).toHaveLength(2);

  expect(gateway.acceptedRunId).toBe(expectedId);
  const waitRequest = requests.find((request) => request.method === "agent.wait");
  expect(waitRequest).toBeDefined();
  expect(waitRequest!.params?.runId).toBe(expectedId);
  expect(gateway.waitRunId).toBe(expectedId);
  expect(gateway.waitStatus).toBe("ok");
  expect(result.exitCode).toBe(0);
  expect(result.summary).toBe(expectedResponse);
}

describe("Jarvis pilot smoke harness through the OpenClaw adapter entry point", () => {
  beforeEach(() => {
    gateway.requests = [];
    gateway.authorization = "";
    gateway.acceptedStatus = "accepted";
    gateway.acceptedRunId = expectedRunId;
    gateway.acceptedExtra = {};
    gateway.waitStatus = "ok";
    gateway.waitError = undefined;
    gateway.waitRunId = expectedRunId;
    gateway.eventRunId = expectedRunId;
    gateway.lifecyclePhase = undefined;
    gateway.conflictingAssistantText = undefined;
    gateway.responseText = expectedResponse;
    gateway.waitExtra = {};
    gateway.assistantEventTiming = "before_wait_response";
    gateway.agentError = undefined;
  });

  afterEach(() => vi.useRealTimers());

  it("accepts one authenticated, signed task only with matching run ID, terminal success, and exact response", async () => {
    gateway.acceptedStatus = "ok";
    const result = await execute(context());
    expect(gateway.authorization).toBe("Bearer synthetic-gateway-token");
    verifySyntheticSignedConnect(gateway.requests[0]!);
    validatePilotReceipt(result, gateway.requests);
    expect(gateway.requests.map((request) => request.method)).toEqual(["connect", "agent", "agent.wait"]);
    expect(result.resultJson).toMatchObject({ receipt: { verified: true, gatewayRunId: expectedRunId, terminalStatus: "ok", responseMatched: true } });
    expect(context().config.autoPairOnFirstConnect).toBe(false);
    expect(context().config.strictReceiptExpectedResponse).toBe(expectedResponse);
  });

  it("accepts the matching final assistant event when it arrives after terminal agent.wait success", async () => {
    gateway.assistantEventTiming = "after_wait_response";
    const result = await execute(context());
    validatePilotReceipt(result, gateway.requests);
  });

  it("returns only receipt metadata when the Gateway wait payload contains secret-like fields", async () => {
    gateway.waitExtra = {
      authToken: "SYNTHETIC_RECEIPT_SECRET_SENTINEL",
      providerDebug: { privateKey: "SYNTHETIC_PRIVATE_KEY_SENTINEL" },
    };
    const result = await execute(context());

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe(expectedResponse);
    expect(JSON.stringify(result.resultJson)).not.toContain("SYNTHETIC_RECEIPT_SECRET_SENTINEL");
    expect(JSON.stringify(result.resultJson)).not.toContain("SYNTHETIC_PRIVATE_KEY_SENTINEL");
    expect(result.resultJson).toEqual({
      receipt: {
        verified: true,
        gatewayRunId: expectedRunId,
        terminalStatus: "ok",
        responseMatched: true,
      },
    });
  });

  it("returns a redacted failed receipt when agent.wait errors after an accepted response", async () => {
    gateway.acceptedExtra = { authToken: "SYNTHETIC_ACCEPTED_PAYLOAD_SECRET" };
    gateway.waitError = "synthetic wait failure";
    const result = await execute(context());

    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.resultJson)).not.toContain("SYNTHETIC_ACCEPTED_PAYLOAD_SECRET");
    expect(result.resultJson).toEqual({ receipt: { verified: false, reason: "gateway_request_failed" } });
  });

  it("preserves legacy behavior when the optional strict marker is empty", async () => {
    gateway.acceptedStatus = "ok";
    const ctx = context();
    ctx.config.strictReceiptExpectedResponse = "";
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(gateway.requests.map((request) => request.method)).toEqual(["connect", "agent"]);
  });

  it("rejects a mismatched Gateway run ID", async () => {
    gateway.waitRunId = "gateway-pilot-run-from-another-request";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_run_id_mismatch" });
  });

  it("rejects initial ok followed by missing terminal status", async () => {
    gateway.acceptedStatus = "ok";
    gateway.waitStatus = undefined;
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_terminal_status_missing" });
    expect(gateway.requests.map((request) => request.method)).toEqual(["connect", "agent", "agent.wait"]);
  });

  it("rejects a missing accepted Gateway run ID", async () => {
    gateway.acceptedRunId = undefined;
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_run_id_missing" });
    expect(gateway.requests.map((request) => request.method)).toEqual(["connect", "agent"]);
  });

  it("rejects a missing run ID in the wait response", async () => {
    gateway.waitRunId = undefined;
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_wait_run_id_missing" });
  });

  it("rejects failed terminal status", async () => {
    gateway.waitStatus = "error";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_wait_error" });
  });

  it("rejects a response that differs from the exact requested string", async () => {
    gateway.responseText = "JARVIS_PILOT_OK with extra text";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_response_mismatch" });
  });

  it("rejects response text with leading or trailing whitespace", async () => {
    gateway.responseText = " JARVIS_PILOT_OK\n";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_response_mismatch" });
  });

  it("does not accept the expected text from a different run", async () => {
    gateway.eventRunId = "unrelated-gateway-run";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_response_missing" });
  });

  it("fails closed when no matching final assistant event arrives before the bounded deadline", async () => {
    gateway.assistantEventTiming = "missing";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_response_missing" });
    expect(gateway.requests.filter((request) => request.method === "agent")).toHaveLength(1);
  });

  it("does not resubmit after a post-dispatch pairing error, even if auto-pair is misconfigured on", async () => {
    gateway.agentError = "pairing required for this device";
    const ctx = context();
    // The pilot configuration remains off. This override only proves that the
    // adapter's post-dispatch guard prevents accidental retry if misconfigured.
    ctx.config.autoPairOnFirstConnect = true;
    const result = await execute(ctx);
    expect(result.exitCode).toBe(1);
    expect(gateway.requests.filter((request) => request.method === "agent")).toHaveLength(1);
    expect(gateway.requests.map((request) => request.method)).toEqual(["connect", "agent"]);
  });

  it("rejects contradictory failure lifecycle evidence for the same run", async () => {
    gateway.lifecyclePhase = "error";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_lifecycle_conflict" });
  });

  it("rejects conflicting assistant text and delta evidence", async () => {
    gateway.conflictingAssistantText = "JARVIS_PILOT_OK ";
    const result = await execute(context());
    expect(result).toMatchObject({ exitCode: 1, errorCode: "openclaw_gateway_receipt_response_ambiguous" });
  });
});
