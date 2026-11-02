import { describe, expect, it } from "vitest";
import {
  assertLegacyAgentInviteAdapterType,
  buildJoinDefaultsPayloadForAccept,
  canReplayOpenClawGatewayInviteAccept,
  mergeJoinDefaultsPayloadForReplay,
  normalizeAgentDefaultsForJoin,
} from "../routes/access.js";

describe("assertLegacyAgentInviteAdapterType", () => {
  it("rejects native runner for new and pending agent-invite onboarding", () => {
    expect(() => assertLegacyAgentInviteAdapterType("paperclip_runner")).toThrow(
      "Paperclip Runner is not available through agent invite onboarding.",
    );
    expect(() => assertLegacyAgentInviteAdapterType("claude_local")).not.toThrow();
    expect(() => assertLegacyAgentInviteAdapterType(null)).not.toThrow();
  });
});

describe("canReplayOpenClawGatewayInviteAccept", () => {
  it("allows replay only for openclaw_gateway agent joins in pending or approved state", () => {
    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "pending_approval",
        },
      }),
    ).toBe(true);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "approved",
        },
      }),
    ).toBe(true);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "agent",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "rejected",
        },
      }),
    ).toBe(false);

    expect(
      canReplayOpenClawGatewayInviteAccept({
        requestType: "human",
        adapterType: "openclaw_gateway",
        existingJoinRequest: {
          requestType: "agent",
          adapterType: "openclaw_gateway",
          status: "pending_approval",
        },
      }),
    ).toBe(false);
  });
});

describe("mergeJoinDefaultsPayloadForReplay", () => {
  it("merges replay payloads and allows gateway token override", () => {
    const merged = mergeJoinDefaultsPayloadForReplay(
      {
        url: "ws://old.example:18789",
        paperclipApiUrl: "http://host.docker.internal:3100",
        headers: {
          "x-openclaw-token": "old-token-1234567890",
          "x-custom": "keep-me",
        },
      },
      {
        paperclipApiUrl: "https://paperclip.example.com",
        headers: {
          "x-openclaw-token": "new-token-1234567890",
        },
      },
    );

    const normalized = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: merged,
      inboundOpenClawAuthHeader: null,
    }) as Record<string, unknown>;

    expect(normalized.url).toBe("ws://old.example:18789");
    expect(normalized.paperclipApiUrl).toBe("https://paperclip.example.com");
    expect(normalized.headers).toMatchObject({
      "x-openclaw-token": "new-token-1234567890",
      "x-custom": "keep-me",
    });
  });

  it("preserves managed keys and unwraps legacy plain keys through accept preparation", () => {
    const commonDefaults = {
      url: "ws://gateway.example:18789",
      headers: { "x-openclaw-token": "gateway-token-1234567890" },
      disableDeviceAuth: false,
    };
    const secretRef = {
      type: "secret_ref",
      secretId: "c0a80100-0000-4000-8000-000000000001",
      version: "latest",
    };
    const key = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-LEGACY-IDENTITY\n-----END PRIVATE KEY-----";

    for (const [devicePrivateKeyPem, expected] of [
      [secretRef, secretRef],
      [{ type: "plain", value: key }, key],
    ] as const) {
      const merged = mergeJoinDefaultsPayloadForReplay(
        { ...commonDefaults, devicePrivateKeyPem },
        { url: "ws://gateway-updated.example:18789" },
      );
      const prepared = buildJoinDefaultsPayloadForAccept({
        adapterType: "openclaw_gateway",
        defaultsPayload: merged,
      });
      const normalized = normalizeAgentDefaultsForJoin({
        adapterType: "openclaw_gateway",
        defaultsPayload: prepared,
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      });
      expect(normalized.fatalErrors).toEqual([]);
      expect(normalized.normalized?.devicePrivateKeyPem).toEqual(expected);
    }
  });

  it("rejects malformed device-key bindings instead of generating a replacement identity", () => {
    const prepared = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://gateway.example:18789",
        headers: { "x-openclaw-token": "gateway-token-1234567890" },
        devicePrivateKeyPem: { type: "secret_ref", secretId: "not-a-uuid" },
      },
    });
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "openclaw_gateway",
      defaultsPayload: prepared,
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toContain(
      "agentDefaultsPayload.devicePrivateKeyPem must be a string, plain binding, or company secret reference",
    );
    expect(normalized.normalized?.devicePrivateKeyPem).toBeUndefined();
    expect(normalized.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "openclaw_gateway_device_key_binding_invalid" }),
    ]));
  });
});
