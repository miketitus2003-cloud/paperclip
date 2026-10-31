import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { testEnvironment } from "./test.js";

// Only synthetic credentials and fresh, disposable keys are used here.
async function probe(
  config: Record<string, unknown>,
  respond: (request: any, send: (response: unknown) => void) => void = (request, send) => {
    send({ type: "res", id: request.id, ok: true, payload: { type: "hello-ok" } });
  },
  nonce: unknown = "fixture-nonce",
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const requests: any[] = [];
  let authorization: string | undefined;
  server.on("connection", (socket, upgrade) => {
    authorization = upgrade.headers.authorization;
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce } }));
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      respond(request, (response) => socket.send(JSON.stringify(response)));
    });
  });
  try {
    const result = await testEnvironment({
      companyId: "fixture-company",
      adapterType: "openclaw_gateway",
      config: { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, ...config },
    });
    return { result, requests, authorization };
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function expectSignedConnect(params: any) {
  const device = params.device;
  expect(device).toBeDefined();
  const raw = Buffer.from(device.publicKey, "base64url");
  expect(raw.length).toBe(32);
  expect(device.id).toBe(createHash("sha256").update(raw).digest("hex"));
  expect(device.nonce).toBe("fixture-nonce");
  expect(Math.abs(Date.now() - device.signedAt)).toBeLessThan(5_000);
  // Construct the wire payload independently, without the production signer.
  const payload = ["v3", device.id, params.client.id, params.client.mode, params.role,
    params.scopes.join(","), String(device.signedAt), params.auth?.token ?? "",
    device.nonce, params.client.platform, params.client.deviceFamily ?? ""].join("|");
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der", type: "spki",
  });
  expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(device.signature, "base64url"))).toBe(true);
  expect(verify(null, Buffer.from(payload.replace("fixture-nonce", "wrong-nonce")), publicKey,
    Buffer.from(device.signature, "base64url"))).toBe(false);
}

function expectSuccess(result: Awaited<ReturnType<typeof testEnvironment>>) {
  expect(result.checks).toContainEqual(expect.objectContaining({ code: "openclaw_gateway_probe_ok", level: "info" }));
}

describe("OpenClaw Gateway connect probe", () => {
  it("signs the challenge with an ephemeral device by default and only sends connect", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token" });
    expectSuccess(result);
    expect(requests.map((request) => request.method)).toEqual(["connect"]);
    expectSignedConnect(requests[0].params);
  });

  it.each([
    [{ authToken: "fixture-token" }, "Bearer fixture-token"],
    [{ headers: { "X-OpenClaw-Token": "fixture-header-token" } }, "Bearer fixture-header-token"],
    [{ authToken: "fixture-token", headers: { Authorization: "Bearer fixture-proxy-token" } }, "Bearer fixture-proxy-token"],
  ] as const)("uses the execution authorization-header policy for %j", async (config, expected) => {
    const { result, authorization } = await probe(config);
    expectSuccess(result);
    expect(authorization).toBe(expected);
  });

  it("bounds an unresponsive connect and does not report success", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token" }, () => {});
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_failed")).toBe(true);
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(false);
    expect(requests.map((request) => request.method)).toEqual(["connect"]);
  });

  it("uses the configured device identity and client fields", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const { result, requests } = await probe({
      headers: { "x-openclaw-token": "fixture-header-token" },
      devicePrivateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      clientId: "custom-client", clientMode: "backend", clientVersion: "fixture-version",
      deviceFamily: "fixture-family", role: "operator", scopes: "operator.read, operator.write",
    });
    expectSuccess(result);
    const params = requests[0].params;
    expectSignedConnect(params);
    expect(params.device.publicKey).toBe(publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"));
    expect(params.client).toMatchObject({ id: "custom-client", mode: "backend", version: "fixture-version", deviceFamily: "fixture-family" });
    expect(params.scopes).toEqual(["operator.read", "operator.write"]);
  });

  it.each([
    { password: "fixture-password" },
    { deviceToken: "fixture-device-token" },
    { authToken: "fixture-token", password: "fixture-password", deviceToken: "fixture-device-token" },
  ])("forwards configured connect authentication %j", async (auth) => {
    const { result, requests } = await probe(auth);
    expectSuccess(result);
    expect(requests[0].params.auth).toEqual({
      ...("authToken" in auth ? { token: auth.authToken } : {}),
      ...("password" in auth ? { password: auth.password } : {}),
      ...("deviceToken" in auth ? { deviceToken: auth.deviceToken } : {}),
    });
    expectSignedConnect(requests[0].params);
    expect(result.checks.some((check) => check.code === "openclaw_gateway_auth_missing")).toBe(false);
  });

  it("retains the existing explicit unsigned compatibility option", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token", disableDeviceAuth: true });
    expectSuccess(result);
    expect(requests[0].params.device).toBeUndefined();
  });

  it("does not approve pairing after a rejected connect", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token" }, (request, send) => {
      send({ type: "res", id: request.id, ok: false, error: { message: "pairing required" } });
    });
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(false);
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_challenge_only")).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(["connect"]);
  });

  it("ignores unrelated successful responses before a rejected connect", async () => {
    const { result } = await probe({ authToken: "fixture-token" }, (request, send) => {
      send({ type: "res", id: "unrelated-request", ok: true });
      send({ type: "res", id: request.id, ok: false });
    });
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(false);
  });

  it("rejects a malformed challenge without sending connect", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token" }, undefined, null);
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(false);
    expect(requests).toEqual([]);
  });

  it("reports an invalid device key without leaking its value or connecting", async () => {
    const { result, requests } = await probe({ authToken: "fixture-token", devicePrivateKeyPem: "invalid-fixture-key" });
    expect(result.checks.some((check) => check.code === "openclaw_gateway_probe_ok")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("invalid-fixture-key");
    expect(requests).toEqual([]);
  });
});
