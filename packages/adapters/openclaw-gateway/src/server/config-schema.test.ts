import { describe, expect, it } from "vitest";
import { getConfigSchema } from "./config-schema.js";

describe("OpenClaw Gateway config schema", () => {
  it("marks the stable device signing key as a Paperclip-managed secret", () => {
    expect(getConfigSchema().fields).toContainEqual(expect.objectContaining({
      key: "devicePrivateKeyPem",
      meta: { secret: true },
    }));
  });

  it("exposes strict Gateway receipt verification as an optional exact marker", () => {
    expect(getConfigSchema().fields).toContainEqual(expect.objectContaining({
      key: "strictReceiptExpectedResponse",
      type: "text",
    }));
  });
});
