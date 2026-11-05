import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "devicePrivateKeyPem",
        label: "Gateway device private key",
        type: "text",
        hint: "Paperclip generates and stores this as an encrypted secret reference for signed Gateway device authentication. Do not export or share the key.",
        meta: { secret: true },
      },
      {
        key: "strictReceiptExpectedResponse",
        label: "Strict Gateway receipt marker",
        type: "text",
        hint: "Optional. When set, require a matching Gateway run ID, agent.wait status ok, and an exact assistant response for that run.",
      },
    ],
  };
}
