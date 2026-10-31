import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { buildDeviceAuthPayloadV3, resolveDeviceIdentity, signDevicePayload, type GatewayDeviceIdentity } from "./device-auth.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

async function probeGateway(input: {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  password: string | null;
  deviceToken: string | null;
  deviceIdentity: GatewayDeviceIdentity | null;
  clientId: string;
  clientMode: string;
  clientVersion: string;
  deviceFamily: string | null;
  role: string;
  scopes: string[];
  timeoutMs: number;
}): Promise<"ok" | "challenge_only" | "failed"> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    let completed = false;
    let connectId: string | null = null;
    const timeout = setTimeout(() => finish("failed"), input.timeoutMs);

    const finish = (status: "ok" | "challenge_only" | "failed" | "error") => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      if (status === "error") reject(new Error("Gateway probe failed"));
      else resolve(status);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish("failed");
          return;
        }

        if (connectId) return;
        connectId = randomUUID();
        try {
          const signedAtMs = Date.now();
          const device = input.deviceIdentity;
          const devicePayload = device ? buildDeviceAuthPayloadV3({
            deviceId: device.deviceId,
            clientId: input.clientId,
            clientMode: input.clientMode,
            role: input.role,
            scopes: input.scopes,
            signedAtMs,
            token: input.authToken,
            nonce,
            platform: process.platform,
            deviceFamily: input.deviceFamily,
          }) : null;
          ws.send(
            JSON.stringify({
              type: "req",
              id: connectId,
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                  id: input.clientId,
                  version: input.clientVersion,
                  platform: process.platform,
                  mode: input.clientMode,
                  ...(input.deviceFamily ? { deviceFamily: input.deviceFamily } : {}),
                },
                role: input.role,
                scopes: input.scopes,
                ...(device && devicePayload ? {
                  device: {
                    id: device.deviceId,
                    publicKey: device.publicKeyRawBase64Url,
                    signature: signDevicePayload(device.privateKeyPem, devicePayload),
                    signedAt: signedAtMs,
                    nonce,
                  },
                } : {}),
                ...(input.authToken || input.password || input.deviceToken
                  ? {
                      auth: {
                        ...(input.authToken ? { token: input.authToken } : {}),
                        ...(input.password ? { password: input.password } : {}),
                        ...(input.deviceToken ? { deviceToken: input.deviceToken } : {}),
                      },
                    }
                  : {}),
              },
            }),
          );
        } catch {
          finish("error");
        }
        return;
      }

      if (event?.type === "res" && connectId && event.id === connectId && typeof event.ok === "boolean") {
        if (event.ok === true) {
          finish("ok");
        } else {
          finish("challenge_only");
        }
      }
    });

    ws.on("error", () => {
      finish("failed");
    });

    ws.on("close", () => {
      if (!completed) finish("failed");
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "openclaw_gateway_url_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires a WebSocket URL.",
      hint: "Set adapterConfig.url to ws://host:port (or wss://).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "openclaw_gateway_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "ws:" && url.protocol !== "wss:") {
    checks.push({
      code: "openclaw_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use ws:// or wss://.",
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_gateway_url_valid",
      level: "info",
      message: `Configured gateway URL: ${url.toString()}`,
    });

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "openclaw_gateway_plaintext_remote_ws",
        level: "warn",
        message: "Gateway URL uses plaintext ws:// on a non-loopback host.",
        hint: "Prefer wss:// for remote gateways.",
      });
    }
  }

  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers);
  if (authToken && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
    headers.authorization = /^bearer\s+/i.test(authToken) ? authToken : `Bearer ${authToken}`;
  }
  const password = nonEmpty(config.password);
  const deviceToken = nonEmpty(config.deviceToken);
  const role = nonEmpty(config.role) ?? "operator";
  const scopes = toStringArray(config.scopes);

  if (authToken || password || deviceToken) {
    checks.push({
      code: "openclaw_gateway_auth_present",
      level: "info",
      message: "Gateway credentials are configured.",
    });
  } else {
    checks.push({
      code: "openclaw_gateway_auth_missing",
      level: "warn",
      message: "No gateway credentials detected in adapter config.",
      hint: "Set authToken/password or headers.x-openclaw-token for authenticated gateways.",
    });
  }

  if (url && (url.protocol === "ws:" || url.protocol === "wss:")) {
    try {
      // The probe signs with the execution identity but never approves pairing or starts an agent.
      const disableDeviceAuth = config.disableDeviceAuth === true ||
        (typeof config.disableDeviceAuth === "string" && ["true", "1"].includes(config.disableDeviceAuth.trim().toLowerCase()));
      const deviceIdentity = disableDeviceAuth ? null : resolveDeviceIdentity(config);
      const probeResult = await probeGateway({
        url: url.toString(),
        headers,
        authToken,
        password,
        deviceToken,
        deviceIdentity,
        clientId: nonEmpty(config.clientId) ?? "gateway-client",
        clientMode: nonEmpty(config.clientMode) ?? "backend",
        clientVersion: nonEmpty(config.clientVersion) ?? "paperclip",
        deviceFamily: nonEmpty(config.deviceFamily),
        role,
        scopes: scopes.length > 0 ? scopes : ["operator.admin"],
        timeoutMs: 3_000,
      });

      if (probeResult === "ok") {
        checks.push({
          code: "openclaw_gateway_probe_ok",
          level: "info",
          message: "Gateway connect probe succeeded.",
        });
      } else if (probeResult === "challenge_only") {
        checks.push({
          code: "openclaw_gateway_probe_challenge_only",
          level: "warn",
          message: "Gateway challenge was received, but connect probe was rejected.",
          hint: "Check gateway credentials, scopes, role, and device-auth requirements.",
        });
      } else {
        checks.push({
          code: "openclaw_gateway_probe_failed",
          level: "warn",
          message: "Gateway probe failed.",
          hint: "Verify network reachability and gateway URL from the Paperclip server host.",
        });
      }
    } catch {
      checks.push({
        code: "openclaw_gateway_probe_error",
        level: "warn",
        message: "Gateway probe failed. Check gateway URL and device signing configuration.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
