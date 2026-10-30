const readline = require("node:readline");
const pending = new Map();
let next = 1;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) {
    const id = pending.get(message.id);
    pending.delete(message.id);
    send({ jsonrpc: "2.0", id, ...(message.error ? { error: message.error } : { result: message.result }) });
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["environmentTask"] } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  if (message.method === "environmentTask") {
    const params = message.params, config = params.config ?? {}, id = "nested-" + next++;
    if (config.ignore) return;
    pending.set(id, message.id);
    send({ jsonrpc: "2.0", id, method: config.hostMethod ?? "agents.getRuntimeIdentity",
      paperclipInvocationId: config.unknownInvocation ? "unknown" : message.paperclipInvocation?.id,
      params: { companyId: config.companyId ?? params.companyId, agentId: config.agentId ?? params.agentId,
        ...(config.environmentId ? { environmentId: config.environmentId } : {}) } });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported fixture method" } });
});
