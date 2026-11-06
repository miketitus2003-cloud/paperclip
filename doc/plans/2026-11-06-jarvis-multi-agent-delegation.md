# Jarvis, Vision and Codex delegation — 2026-11-06

## Outcome and scope

Implemented a concrete OpenClaw routing correction in the adapter, the owner of
Gateway protocol details. Independent Paperclip agents and single-assignee issues
already exist. No new scheduler, permission, budget exception, schema, or API was
needed. No production configuration, pairing, key, task, schedule, deployment,
remote, or publication was changed. This is a source fix with synthetic acceptance
evidence; installed Jarvis/Vision/Codex workers are still unverified.

## Source trace and findings

| Boundary | Evidence and contract |
| --- | --- |
| Assignment | `packages/shared/src/validators/issue.ts` supports `parentId` and one `assigneeAgentId`. `server/src/routes/issues.ts` calls `queueIssueAssignmentWakeup` on create/update. `server/src/services/issue-assignment-wakeup.ts` wakes that exact assignee with the issue ID, skipping unassigned/backlog issues. |
| Checkout | `server/src/services/issues.ts`, `checkout`, checks assignable agent/company and blockers/holds, then conditionally updates assignee, status, checkout run and execution run in a transaction. The conditions prevent another worker/run taking the same issue. |
| Dispatch | `server/src/services/heartbeat/queue.ts`, `startNextQueuedRunForAgent`, locks by agent, checks invokability, counts that agent's running work, and selects its queued runs. Budget admission and pre-invocation checks remain there. `server/src/services/heartbeat-policy.ts` owns wake-on-demand policy. |
| Adapter routing | `server/src/services/heartbeat/runtime-execution.ts` invokes the selected adapter with the admitted `agent`, `run.id`, effective config and run context. `packages/adapters/openclaw-gateway/src/server/execute.ts` maps those into Gateway `agent` and `agent.wait` requests. |
| Worker/session defect | Previously `payloadTemplate.agentId` could override config, while `resolveSessionKey` used only config's ID. Template-only IDs did not prefix sessions. Already-prefixed keys naming another worker were accepted. These give the Gateway contradictory routing inputs; no claim is made about which input every Gateway version would prioritize. |
| Callback identity | Adapter `buildWakePayload`, `buildPaperclipEnvForWake`, and `buildWakeText` advertise the Paperclip agent/company/run and the configured claimed-key path. `server/src/middleware/auth.ts` derives identity from the bearer key or signed JWT, not the OpenClaw display name; JWT run headers must agree. `server/src/middleware/agent-run-authentication.ts` scopes run reads by run/company/agent. Issue route run attribution and checkout retain their existing ownership checks. Sharing a claimed-key file is therefore an operator configuration hazard. |
| Terminal receipt | Adapter `execute.ts` tracks accepted Gateway run IDs and filters events by them. Strict receipt mode requires a matching `agent.wait` run ID, terminal `ok`, and exact assistant text for that run. Gateway acceptance alone and successful connect alone do not establish completed issue work. |

The correction resolves config/template IDs consistently, rejects conflicting or
non-string IDs and conflicting selected session prefixes before connection, and
normalizes the request ID as well as the session prefix. It returns
`openclaw_gateway_routing_invalid` without dispatch. Legacy default-agent routing
remains compatible but now logs a warning when neither worker ID nor routed
session prefix is supplied. This deliberately does not make every legacy agent
record invalid. Conflicting template overrides are an intentional compatibility
change: make both IDs agree or remove the redundant template ID.

## Actionable setup after the deployment hold is lifted

These examples describe supported fields, not changes performed by this task.
Review existing records first; reuse the correct records rather than creating
new duplicates. `GET /api/companies/{companyId}/agents` lists Paperclip records
under authorized access. Record the three UUIDs and their adapter types.

| Paperclip record | `adapterType` | `adapterConfig.agentId` | `adapterConfig.claimedApiKeyPath` |
| --- | --- | --- | --- |
| Jarvis | `openclaw_gateway` | actual installed Jarvis worker ID, for example `jarvis` | absolute remote path to Jarvis's own claimed key JSON |
| Vision | `openclaw_gateway` | actual installed Vision worker ID, for example `vision` | separate remote path to Vision's own claimed key JSON |
| Codex via OpenClaw | `openclaw_gateway` | actual installed Codex worker ID, for example `codex` | separate remote path to Codex's own claimed key JSON |

Names above are examples, not evidence that those IDs exist. A Paperclip UUID is
not an OpenClaw worker ID. Verify the installed worker inventory through approved
read-only access. Do not substitute `main` for a missing worker. A display name,
role, or `reportsTo` organizes records; it does not provision execution workers.

Example non-secret configuration fragment for an existing Vision record:

```json
{
  "adapterType": "openclaw_gateway",
  "adapterConfig": {
    "url": "wss://gateway.example.invalid",
    "agentId": "vision",
    "sessionKeyStrategy": "issue",
    "claimedApiKeyPath": "/remote/vision/paperclip-claimed-api-key.json",
    "paperclipApiUrl": "https://paperclip.example.invalid",
    "autoPairOnFirstConnect": false,
    "timeoutSec": 120,
    "waitTimeoutMs": 120000
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "intervalSec": 0,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 1
    }
  }
}
```

Gateway credentials and stable device identity must use the existing approved
secret workflow; this fragment supplies neither. Preserve current scopes and
approval controls. Do not copy key contents into config examples or reports.
`paperclipApiUrl` must be reachable from each remote worker; Gateway `url` must
be reachable from the Paperclip server. Claimed-key paths are remote worker
filesystem paths read by the worker, not server paths provisioned by the adapter.
The shared default `~/.openclaw/workspace/paperclip-claimed-api-key.json` is unsuitable
for workers sharing that filesystem. Each file must authenticate as its intended
Paperclip record; check `/api/agents/me` after separately authorized provisioning.

`runtimeConfig.heartbeat.enabled=false` disables timer heartbeats, while
`wakeOnDemand=true` allows assignment/on-demand admission, subject to all normal
gates. `maxConcurrentRuns` is per Paperclip record: three distinct records can
run concurrently with one slot each. `sessionKeyStrategy="issue"` yields
`agent:vision:paperclip:issue:<issue UUID>`; `"run"` yields a new run-scoped key.
`"fixed"` shares a worker session, and `"issue"` without an issue falls back to
`sessionKey`/`paperclip`. Prefer run strategy for concurrent issue-less work.
Do not aim several records at the same OpenClaw worker and call that isolation.

For independent work, use `POST /api/companies/{companyId}/issues`, one request
per child, under authorized company context. Supported body fields include:

```json
{
  "title": "Vision: inspect the delegated component",
  "description": "Bounded task, expected evidence, and completion criteria",
  "parentId": "<parent issue UUID>",
  "assigneeAgentId": "<Vision Paperclip UUID>",
  "status": "todo"
}
```

Use actual UUIDs, distinct child scopes and separate execution workspaces when
workers edit code. A backlog issue does not wake its assignee through the normal
assignment helper. Workers must honor checkout conflicts and use their own
run header on mutations. Creating real records/tasks and executing this example
remain held; no API request above was sent by this task.

Existing `codex_local` or other supported adapters can already be separate
Paperclip records with independent issues. `codex_local` runs in its configured
execution environment; it does not select an OpenClaw worker named Codex. An
OpenClaw `agentId` neither installs a CLI nor registers a remote runtime. Adding
an unsupported remote worker requires an appropriate installed adapter/plugin
or supported Runner environment and its own qualification. This change only
repairs routing for existing OpenClaw Gateway adapter records.

## Verification and reproducibility

Dependencies were reused via ignored `node_modules` symlinks to the frozen
installed dependency tree in `/tmp/paperclip-release-candidate-pr1-pr4`. No
installation, frozen checkout source/index edit, Docker build, or live model
call was performed. Compilation output went to `/tmp/paperclip-delegation-build`.

Commands run from this worktree unless noted:

```sh
node node_modules/vitest/vitest.mjs run --config packages/adapters/openclaw-gateway/vitest.config.ts packages/adapters/openclaw-gateway/src/server/execute-dispatch.test.ts
node node_modules/vitest/vitest.mjs run --config packages/adapters/openclaw-gateway/vitest.config.ts packages/adapters/openclaw-gateway/src
node node_modules/typescript/bin/tsc --noEmit -p packages/adapters/openclaw-gateway/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/adapters/openclaw-gateway/tsconfig.json --outDir /tmp/paperclip-delegation-build
git diff --check
df -h .
```

The initial new dispatch regressions failed **4 tests, with 6 passing** against
the original source (`/tmp/delegation-red.log`). After correction, the focused
final run passed **23/23** (`/tmp/delegation-final-focused.log`). The complete
adapter run before the final warning regression passed **64/64** across seven
files (`/tmp/delegation-adapter.log`). The complete final suite passed **65/65**
across seven files, exit 0, in 8.38 seconds
(`/tmp/delegation-adapter-final.log`). Typecheck and compilation both exited 0;
`git diff --check` passed. `df -h .` reported **17 GiB available**, above the
8 GiB required headroom.

Additional existing server regressions were run from `server/`:

```sh
timeout 150s node ../node_modules/vitest/vitest.mjs run src/__tests__/agent-run-authentication.test.ts src/__tests__/issues-checkout-wakeup.test.ts src/__tests__/heartbeat-direct-adapter-native-isolation.test.ts src/__tests__/openclaw-gateway-adapter.test.ts
```

With loopback binding allowed, **19/19 tests across four files passed**, exit 0,
in 69.11 seconds (`/tmp/delegation-server-unrestricted.log`). Disposable embedded
PostgreSQL exercised run/company/agent identity filtering and existing heartbeat
adapter separation. These are existing regression tests; frozen dependency
workspace exports can resolve to the candidate checkout, so direct adapter tests
above are the evidence for the changed adapter source. Runtime tool-delivery
warnings were emitted by the synthetic fixtures. The earlier sandbox server run
failed three files (4 failed tests, 8 passed, 7 skipped, 4 uncaught errors) because
loopback binding was denied, with downstream timeout and failed-setup cleanup
errors (`/tmp/delegation-server.log`). No remaining source failure was observed
in the unrestricted targeted rerun.

`multi-agent-isolation.test.ts` uses real ephemeral loopback WebSocket connections
and a synthetic Gateway. All three workers must reach `agent.wait` before any
completion response. Responses arrive in reverse order; foreign-run events are
injected on every socket. It verifies request worker IDs, sessions, idempotency
keys, Paperclip identity prompts, per-worker key paths, and isolated failure of
Vision's deliberately wrong receipt. Both cases passed. The initial sandbox
attempt failed with `listen EPERM`; the same test passed with local binding
allowed. This is a retained environment failure, not a hidden successful retry.

ChatGPT separately reported 2/2 loopback cases and 64/64 adapter tests passing
through its Desktop Commander terminal (transient `CHATGPT-VERIFICATION.md`).
Those observations corroborate synthetic local behavior only. Its read-only live
inspection found the running container but an unauthenticated company-list query
returned `403 Board access required`; installed agent records remain unverified.
No auth bypass or repeated unauthenticated inspection is required.

Full repository `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` were not run:
`pnpm` is absent from this shell, and the bounded adapter change was validated
with direct installed tools. This is not a claim of a complete PR-ready repo
verification. No UI changes or map behavior/API changes were made.

## Git provenance and handoff

Worktree: `/home/storm25/Projects/paperclip-delegation`.
Branch: `jarvis/multi-agent-delegation-20261106`.
Starting commit: `df0961ab97d09ca3fcaac42cfc93925d944b4a48`.
`git status --short` was empty at the start. Read-only `git remote -v` and
`git config --get remote.origin.url` both identify origin as the local repository
`/tmp/paperclip-tsx-dependency-proposal`, not GitHub. `git log -8 --oneline`
shows `df0961a` (strict receipt redaction), `450582f` (strict receipts), and
`968b624` (prior candidate merge). None of those existing commits was rewritten.
No checkout's remote configuration was changed; no push, merge or force-push
was attempted. The qualified candidate checkout and homelab checkout were not
edited. ChatGPT retains publishing to known `miketitus2003-cloud/paperclip`
after review; do not publish to a guessed remote or treat local origin as it.
The scoped commit contains adapter source/tests/docs and this plan only.
`DELEGATION-RESULT.md` and ChatGPT's transient coordination file stay uncommitted.

## Remaining live gates

After explicit release authorization, inspect the actual three records and
installed worker IDs, credential identity categories, reachable callback URLs,
and worker filesystem/workspace separation. A connect probe does not verify
worker existence, task dispatch, callback authorization, or completion. Current
routing conflict validation runs on execution, not the connect-only probe.

Separately authorize one bounded issue per worker and concurrent execution;
verify `/api/agents/me` matches each intended Paperclip record, distinct task/run
attribution and checkout, matching remote receipts, durable issue evidence and
terminal status, plus budget/Stop behavior as appropriate. An exact marker may
be used with `strictReceiptExpectedResponse` for a qualification task; do not
leave a fixed marker on ordinary tasks whose answers should vary. No live task,
key provisioning, pairing, scope grant, scheduling or deployment is authorized
by this source handoff. Existing CT404/VM200 deployment holds remain.
