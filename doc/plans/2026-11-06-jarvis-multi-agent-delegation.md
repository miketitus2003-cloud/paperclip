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


## Additive rollout preparation — 2026-11-06

PR7 now contains delegation source commit
`615224c525ab4f1ace0c19437b5640bb962b5668`, published by ChatGPT. This follow-up
changes documentation only; it neither reruns passing checks nor publishes Git.

**Legitimate operator authentication.** `doc/CLI.md` documents browser-approved
Board authentication. `ui/src/api/client.ts` uses `credentials: "include"`, so
an already signed-in operator can use that instance's existing browser UI without
exporting cookies. For self-hosted authenticated instances the operator signs in
at `/auth` using their existing account; Cloud-managed instances use their Cloud
sign-in redirect (`doc/DEPLOYMENT-MODES.md`, `ui/src/pages/Auth.tsx`). A 403 from
an unauthenticated command does not establish missing membership or missing keys.
No authenticated browser or CLI surface was established by this source-only pass.
The required interaction is the operator opening the correct instance in their
browser and signing in, not an invented infrastructure permission gate.

CLI `resolveCommandContext` (`cli/src/commands/client/common.ts`) reuses its
stored Board credential for the exact normalized API base automatically. Explicit
or environment-provided agent keys take precedence; do not substitute an agent
key for Board access or print those environment values. With the existing local
CLI, the supported read is:

```sh
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts auth whoami --api-base <instance-url>
```

This command contacts the instance and can trigger interactive auth recovery in a
TTY; it was not run here. If no valid stored credential exists, an operator may
separately choose `auth login --api-base <instance-url> --no-browser` through the
same direct CLI entrypoint, open the printed approval link in their browser,
sign in and review/approve the requested Board access. `loginBoardCli` creates a
ten-minute challenge and stores a credential only after approval and identity
verification (`cli/src/client/board-auth.ts`). This is credential issuance, not
read-only diagnostics, and was not initiated. It does not require extracting
browser cookies or `--instance-admin`. Do not use bootstrap-ceo on an existing
instance as a diagnostic shortcut. `agent list --company-id <company-uuid>` can
then use that supported CLI credential; report identity/configuration categories
rather than dumping agent config or auth stores. `doctor` is not a pure read-only
auth probe: it reads local configuration/secrets, probes services and can create
storage directories even without `--repair` (`cli/src/commands/doctor.ts`,
`cli/src/checks/storage-check.ts`), so it was not run under this scope.

**Derived image finding.** Production starts `node server/dist-runtime/index.mjs`
(`Dockerfile`); `server/scripts/bundle-runtime.mjs` bundles `@paperclipai/*`,
including the static OpenClaw imports in `server/src/adapters/registry.ts`.
Workspace package exports point at adapter `src/*.ts`; `publishConfig.exports`
points published packages at `dist`, but is not the workspace runtime export map.
Therefore copying `/tmp/paperclip-delegation-build` over adapter dist alone is
ineffective for the existing production bundle. A sound candidate must regenerate
the bundle as well. Base qualification evidence in the existing local artifact
package records a production startup and the immutable local image ID
`sha256:2b2a8e43d46e9d2f5418374c64d6756339c527ac0bd31ead00cc5a3d8a0e9a02`;
this is an image ID, not a registry manifest digest.

Prepared `/tmp/paperclip-delegation-derived-615224c/` (under 1 MiB): a guarded
Dockerfile, committed adapter source overlay, prior verified tsc output,
`BASE-SHA256SUMS`, `OVERLAY-SHA256SUMS`, `provenance.json`, build wrapper and
qualification instructions. All overlay checksum entries passed locally. The
recipe checks base source/package/bundler bytes and stamp, copies only the adapter
overlay, then uses the base's existing esbuild and bundler to regenerate runtime
chunks. Guards stop unsupported base layouts instead of pretending a dist-only
patch works. Patch labels retain both commits and the exact base image ID; the
base build stamp remains df0961a. This is explicitly a derived patch candidate,
never a clean full rebuild of 615224c. The wrapper checks local base ID/platform/CMD,
uses no network or pulls, and monitors user-available disk with an 8 GiB stop
threshold and 180-second limit. Available space remained 17 GiB during preparation.

No Docker build was performed. ChatGPT may run the prepared wrapper locally and
must qualify the resulting immutable image ID with exact overlay/runtime byte
checks and isolated production startup plus synthetic adapter acceptance. The old
base-pinned qualification harness/report cannot qualify or be relabeled as this
new image. Base loader/tool presence is guarded but not yet observed in a patch
build. No existing deployment hold is lifted; live operator sign-in, actual
worker inventory/identity, derived-image qualification and separate rollout
review remain outstanding.

## ChatGPT-observed derived image qualification — 2026-11-06

ChatGPT completed the local build and exact-ID qualification; the following are
its reported observations, not additional Codex test runs. Source commit
`615224c525ab4f1ace0c19437b5640bb962b5668` was published by ChatGPT in draft PR7.
That publication is separate from Codex's earlier no-push statements, which
remain accurate for Codex's actions.

The review-only derived image is
`sha256:0f7b8f2a9602f3d438d85d516c9694a644d14423b56985432a70457156543d4e`,
tagged `paperclip-jarvis-derived:615224c-review`. It uses the prepared recipe at
`/tmp/paperclip-delegation-derived-615224c`, the qualified base image
`sha256:2b2a8e43d46e9d2f5418374c64d6756339c527ac0bd31ead00cc5a3d8a0e9a02`,
and patch source `615224c`. It deliberately inherits the df0961a base build
stamp and is **not a clean full source rebuild** of the patch commit.

ChatGPT's build result at
`/home/storm25/Projects/paperclip-delegation-image-review/build-result.json`
records a 10.0-second build with network disabled and no pull, minimum
user-available space of 17,553,133,568 bytes, a regenerated 2,637-input runtime
bundle, and the routing-invalid marker found in that new bundle.

Its exact-ID qualification report at
`/home/storm25/Projects/paperclip-delegation-image-review/evidence/image-qualification.json`
records production startup health HTTP 200/status ok, UI HTTP 200, JavaScript
HTTP 200, passing overlay/runtime manifest byte checks, and source receipt bytes
matching the overlay. All **65/65 adapter tests passed, with zero failures or
skips**. Qualification used network none, no host mounts and no published ports;
container cleanup was PASS. These are synthetic adapter tests and isolated
production startup evidence, not live worker acceptance. This new derived-image
qualification is distinct from the historical base image's 39-case qualification.
The earlier source compilation/API verification remains recorded above; no
additional investigation or tests were run by Codex for this documentation update.

ChatGPT also reported read-only live CT404 metadata: build
`1b4c803816e82b0265c8422e1a804327a7ed8c54`, version
`v2026.1005.0-330-g1b4c80381`, embedded PostgreSQL 18, and `local_encrypted`
provider. Initial config-only/root probes misleadingly reported a missing key or
`PROCESS_NOT_FOUND` because of root HOME/UID context. The actual metadata-only
key-file probe, executed as application UID:GID `1000:1000`, reported the key
file present, mode `0600`, owner `1000:1000`, readable yes, exit 0. No key bytes
were read or exposed. This establishes file presence/readability only, not
backup custody or restore readiness.

No live mutation, model/task execution, deployment or authentication change
occurred in this reported work. The image remains review-only. Live rollout,
operator Board sign-in, actual agent/worker identity verification and live
acceptance remain pending; existing deployment holds are unchanged.

## Research-lab execution plan and database rehearsal preparation — 2026-11-06

Build toward the AI research lab in gated increments:

1. Establish a dependable IT/network/Linux/security foundation: known hosts and
   service owners, supported authenticated access, least privilege, reachable
   worker callback paths, monitored capacity, and recoverable encrypted data.
   Keep sensitive material in the established secret system and record only
   non-secret identity, health and custody evidence.
2. Qualify multiple real workers as separate company-scoped agent records,
   each mapped to its actual runtime and identity. Verify independent assignment,
   checkout, callbacks and terminal evidence before claiming lab readiness.
3. Execute bounded task loops with explicit scope, cost/time limits, checks,
   durable work products and a stopping condition. A successful tool response is
   not completion evidence; preserve failures and identify the next owner/action.
4. Express parallel research and implementation as task graphs: one assignee per
   child issue, explicit prerequisites, isolated editing workspaces, and a parent
   that integrates reviewed results. Human decisions and blocked dependencies
   pause the relevant graph rather than creating unbounded polling loops.
5. Require final human approval for impactful release after exact-artifact
   verification, database upgrade/rollback rehearsal and operational review.
   Source commits and local rehearsal preparation do not authorize deployment.

ChatGPT owns the concurrent live authenticated-access investigation. Codex's next
slice is local-only database rehearsal preparation: compare deployed-to-candidate
migration artifacts, inspect the existing backup/restore harness, and add narrowly
tested offline tooling where needed. No production data, backup creation, live
models, grants, schedules or deployment are part of this slice.

### Offline database preparation outcome

Added `scripts/prepare-db-upgrade-rehearsal.mjs`, focused Node tests and bounded
read-only journal SQL templates; the actionable procedure is
`doc/database-upgrade-rehearsal.md`. The planner accepts local manifests and
metadata-only journal exports, computes exact SQL SHA256s, rejects rewritten or
removed history, unknown/duplicate/incomplete applied hashes, unsafe file tags
and DB URL arguments, and refuses evidence overwrites. Its best successful state
is `prepared-not-executed`; it cannot connect, migrate, back up or restore.

Local inspection found **417 executable journal entries** ending in
`0418_curved_lady_mastermind`. The historical indices contain gaps/ties, so the
initial planner's contiguous-index assumption failed against real artifacts;
it was corrected to preserve historical metadata, with regression coverage.
A Git export of df0961a and the candidate 615224c have identical migration
history (**zero additions**). That comparison concerns the qualified base and
patch, **not the deployed build**. `git cat-file -t` for deployed commit
`1b4c803816e82b0265c8422e1a804327a7ed8c54` failed because the object is absent.
Actual deployed artifact SQL/journal and read-only applied journal export are
still required; no pending-migration count for production is claimed.

Verification: `node scripts/__tests__/prepare-db-upgrade-rehearsal.test.mjs`
passed **10/10**, including rewritten history, metadata gaps/ties, unknown and
partial hashes, secret-bearing extra fields, safe CLI rejection and no overwrite.
The real-artifact manifest smoke passed with 417 entries; the comparison report
at `/tmp/paperclip-db-offline-preparation.json` correctly reports `blocked` with
`deployed-journal-export-required` (planner exit 2). Input manifests are
`/tmp/paperclip-base-migrations-df0961a.json` and
`/tmp/paperclip-candidate-migrations-615224c.json`; these are offline preparation
artifacts, not live journal evidence. No adapter/image suites were repeated.
No database was connected, backup created or rehearsal executed. The new procedure
separates old-code-on-upgraded-schema compatibility from independently restoring
the pre-upgrade snapshot, and records key custody/filesystem restore as separate
obligations. ChatGPT retains live access investigation; no homelab files changed.


### Concurrent handoff closes the source-revision gap

Before finishing, ChatGPT fetched the exact deployed source object with no branch
or checkout change and notified Codex via transient
`DEPLOYED-REVISION-AVAILABLE.md`. A local Git archive of
`1b4c803816e82b0265c8422e1a804327a7ed8c54` now yields **332** migration entries
through `0333_normal_wild_pack`. The offline planner compared it with candidate
615224c's **417** entries and found **85 additions**, from
`0334_rare_slipstream` through `0418_curved_lady_mastermind`, with an unchanged
historical prefix. This supersedes the earlier source-object blocker while
preserving that failed initial lookup in the record.

The new report is `/tmp/paperclip-db-deployed-to-candidate-preparation.json`;
its deployed manifest is `/tmp/paperclip-deployed-migrations-1b4c8038.json`.
The planner returned exit 2 / `blocked` solely because the applied journal export
is still absent. The additions have 21 destructive-keyword,
37 data-change-keyword and 33
transaction-boundary review hints (categories overlap; lexical hints are not
SQL safety review). All 85 SQL changes still require actual migration review and
an isolated upgrade/recovery rehearsal. Source artifact additions are not a
measurement of pending migrations in the live DB. Deployed image/source byte
correlation and applied journal remain separate requirements.

ChatGPT also reports its independent live OpenClaw inventory contains only worker
`main`; no separate Vision/Codex IDs were present. This is attributed read-only
inventory evidence, not Codex live access. Earlier example IDs remain examples;
provisioning/qualifying real additional workers requires its own authorized step.
No live work, keys, grants, backups, deployments or schedules were changed.
