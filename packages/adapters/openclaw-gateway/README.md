# OpenClaw Gateway Adapter

This document describes how `@paperclipai/adapter-openclaw-gateway` invokes OpenClaw over the Gateway protocol.

## Transport

This adapter always uses WebSocket gateway transport.

- URL must be `ws://` or `wss://`
- Connect flow follows gateway protocol:
1. receive `connect.challenge`
2. send `req connect` (protocol/client/auth/device payload)
3. send `req agent`
4. wait for completion via `req agent.wait`
5. stream `event agent` frames into Paperclip logs/transcript parsing

## Auth Modes

Gateway credentials can be provided in any of these ways:

- `authToken` / `token` in adapter config
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth` (legacy)
- `password` (shared password mode)
- `deviceToken` (device token mode)

When a token is present and `authorization` header is missing, the adapter derives `Authorization: Bearer <token>`.

## Device Auth

By default the adapter sends a signed `device` payload in `connect` params.

- set `disableDeviceAuth=true` to omit device signing
- set `devicePrivateKeyPem` to pin a stable signing key
- without `devicePrivateKeyPem`, the adapter generates an ephemeral Ed25519 keypair per run
- when `autoPairOnFirstConnect` is enabled (default), the adapter handles one initial `pairing required` by calling `device.pair.list` + `device.pair.approve` over shared auth, then retries once.

## Environment test

The environment test sends only `connect`. It uses the configured token, password,
device token, client fields, role, scopes, and signed device identity. Device signing
is enabled by default, as it is for execution. A configured `devicePrivateKeyPem`
reuses the execution identity; otherwise each test generates an ephemeral key.
Configured signing keys must be Ed25519. Unsupported keys and signing/send errors
return a sanitized probe failure.

The test does not approve device pairing or run an agent. A gateway that requires
pairing must accept the configured identity before the test can succeed. A rejected
connect remains a warning and does not supply successful lifecycle verification.
An accepted connect supplies `openclaw_gateway_probe_ok`; lifecycle verification
recognizes that result only for the `openclaw_gateway` adapter, even when an
unrelated environment warning remains.
This proves the connect handshake, not task execution or a full request/receipt loop.

## Session Strategy

The adapter supports the same session routing model as HTTP OpenClaw mode:

- `sessionKeyStrategy=issue|fixed|run`
- `sessionKey` is used when strategy is `fixed`

Resolved session key is sent as `agent.sessionKey`.

## Payload Mapping

The agent request is built as:

- required fields:
  - `message` (wake text plus optional `payloadTemplate.message`/`payloadTemplate.text` prefix)
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey` (resolved strategy)
- optional additions:
  - all `payloadTemplate` fields merged in
  - `agentId` from config if set and not already in template

## Timeouts

- `timeoutSec` controls adapter-level request budget
- `waitTimeoutMs` controls `agent.wait.timeoutMs`

If `agent.wait` returns `timeout`, adapter returns `openclaw_gateway_wait_timeout`.

Set `strictReceiptExpectedResponse` to opt into strict task receipts. The adapter
then requires the `agent` acceptance to include a run ID, calls `agent.wait`
even if the acceptance status is `ok`, and requires the wait response to carry
the same run ID and terminal `status: "ok"`. It also requires assistant text
streamed for that exact run to equal the configured marker byte-for-byte. A
missing, conflicting, or different value returns a failed receipt. Leave the
field unset to retain the existing behavior for ordinary callers.

## Log Format

Structured gateway event logs use:

- `[openclaw-gateway] ...` for lifecycle/system logs
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` for `event agent` frames

UI/CLI parsers consume these lines to render transcript updates.

## No-remote-git contract

Like every Paperclip adapter, this one must treat the local execution-workspace
cwd as the only persistence boundary across runs — no `git push` from runtime
code, no assuming a `git remote` exists. The gateway transport here doesn't
touch the workspace directly, but if you extend the adapter to ship code to
the OpenClaw side, use the round-trip helpers in `@paperclipai/adapter-utils`
(`prepareWorkspaceForSshExecution` → `restoreWorkspaceFromSshExecution`)
rather than reaching for a git remote. See
[`packages/adapters/AUTHORING.md`](../AUTHORING.md#no-remote-git-contract-cross-run-persistence)
for the full contract and the pinning test at
[`packages/adapter-utils/src/ssh-fixture.test.ts`](../../adapter-utils/src/ssh-fixture.test.ts).
