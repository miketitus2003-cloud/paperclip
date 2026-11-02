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
    ],
  };
}
