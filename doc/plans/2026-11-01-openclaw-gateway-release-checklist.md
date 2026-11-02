# OpenClaw Gateway release gate and device-key protection

Status: **HOLD**. This is a development-only proposal on `fix/openclaw-device-private-key-secrecy`; it is separate from Gateway lifecycle PR #1. Nothing here has been deployed, paired, or merged.

## Candidate components

| Component | Reference | Release-gate state |
| --- | --- | --- |
| Lifecycle probe signed device auth and adapter-specific success-code verification | [PR #1](https://github.com/miketitus2003-cloud/paperclip/pull/1) | Existing separate reviewed Gateway patch; do not alter from this proposal. Prior supplied evidence: focused 80 tests and adapter build/typecheck passed; workspace full test gate remains failed (189 failed tests / 684 files in the general-server lane). |
| `bundle-runtime.test.mjs` fixture removal correction | [PR #2](https://github.com/miketitus2003-cloud/paperclip/pull/2) | Separate minimal fixture proposal. Earlier request reported six targeted tests passing in its prepared environment. This branch has not revalidated it. |
| Locked `tsx` CommonJS API compatibility proposal | [PR #3](https://github.com/miketitus2003-cloud/paperclip/pull/3), head `8963a5a9193096cfd37aa2756506e560016d5dfd` | Draft and open, based on PR #1 (`b3bd7fddd7357e9f1b69b252d88c729e4768950e`). PR #3 records Node 24.11.0/pnpm 9.15.4 verification, base/combined recovery comparison, 142/142 recovery tests, builds/typechecks, and affected Gateway tests. Risks include the downgrade from tsx 4.23.15 and no full workspace suite/hosted CI. |
| Device private-key exposure and secret-reference support | [PR #4](https://github.com/miketitus2003-cloud/paperclip/pull/4), head `1b96be82140fb4dfb33d779e5620baa2e127a127` | Separate draft PR based on `master`; targeted checks partial (see below). |

Before any release decision, create one disposable candidate containing the reviewed heads of #1 and #2, the exact `tsx` proposal head, and PR #4's key-protection head. Confirm identities by commit SHA; do not merge the PRs to do so.

## Key behavior proposed

- The OpenClaw adapter schema marks `devicePrivateKeyPem` with `meta.secret: true`. Paperclip's existing adapter-secret pipeline converts saved inline input to a managed `secret_ref` and resolves it for adapter runtime use, so the signer can continue receiving the PEM after resolution.
- Gateway device-key generation stays in Paperclip. A pre-existing `secret_ref` binding is preserved when the config normalizer checks whether a key exists; otherwise an update could generate a second key and break device identity.
- Config and revision snapshots use `redactAgentAdapterConfig`; its secret-field matcher now treats `devicePrivateKeyPem` as secret. The shared text sanitizer also masks synthetic private-key PEM blocks, covering diagnostic/log text that is no longer attached to the structured field.
- Company portability omits the key field entirely, whether it contains a legacy inline value or a secret reference. Import therefore creates a new Gateway device identity; pairing is an operator action and is outside this proposal.
- These redactions and export omissions **do not provide at-rest protection**. They do not remove existing inline values from stored records or backups until those records are safely normalized/migrated.

## At-rest and backup requirements

Use the existing `local_encrypted` secret provider for the normalized reference. Protect database access and the secret-encryption key as separate privileged assets. If `PAPERCLIP_SECRETS_MASTER_KEY` is configured, back it up separately from the database with equivalent access controls; database backups alone cannot restore secrets. If the local key file is used, retain it with the database backup under restrictive file permissions (0600) and protect both backup copies. Encrypt backups, limit/record administrator access, and prove a restore can resolve a synthetic secret before considering the device key protected at rest. Confirm the deployed provider and backup/restore procedure with the operator; this proposal has not inspected a live key or backup.

Existing records that still contain inline PEM require a controlled save/normalization migration or an equivalent reviewed migration before claiming at-rest protection. Do not log, export, or display the value during that process.

## Verification evidence in this checkout

- Node 24.11.0 `vitest run server/src/__tests__/company-portability.test.ts --reporter=dot`: **115/115 passed**, including inline and secret-reference export omission.
- Node 24.11.0 `vitest run packages/adapter-utils/src/command-redaction.test.ts server/src/__tests__/redaction.test.ts packages/adapters/openclaw-gateway/src/server/config-schema.test.ts --reporter=dot`: **66 passed**. This evidence predates only the new integration test.
- Node 24.11.0 targeted run of `agents-service-secret-bindings.test.ts -t "resolves an OpenClaw device secret for signing without disclosing it"`: **blocked before test execution** when embedded PostgreSQL could not bind its local listener (`listen EPERM: operation not permitted 127.0.0.1`). Do not interpret this as a product assertion failure.
- Node 24.11.0 `tsc --noEmit -p server/tsconfig.json` and `tsc --noEmit -p packages/adapters/openclaw-gateway/tsconfig.json`: **both exit 0** on the final source tree.
- `git diff --check`: **pass**.
- No workspace/full-suite retry was run. PR #1 remains unchanged. No live private key was read or generated.

## Remaining release gates

| Gate | State | Evidence needed / owner |
| --- | --- | --- |
| Device config and revision reads redact key | Partial | Synthetic config and revision-snapshot redaction assertions pass. Revision endpoints call the same `redactAgentAdapterConfig` function; an end-to-end revision route response remains unverified. |
| Logs/diagnostics redact PEM | Pass (focused) | Synthetic PEM tests in adapter-utils and server redaction passed in the 66 focused tests. |
| Export omits inline key and secret reference | Pass (focused) | `company-portability.test.ts` passed 115/115 under Node 24.11.0, including inline PEM and secret-reference omission. |
| Runtime adapter signing with resolved secret | Blocked | Synthetic Ed25519 integration regression is written, but embedded PostgreSQL cannot start because sandbox loopback bind is denied. Run it in an approved loopback-capable test runner; no real key is needed. |
| Secret normalization and at-rest/backup controls | Partial | Existing `meta.secret` resolver found in `server/src/services/secrets.ts`; operator must confirm deployed provider, key custody, backup separation, permissions, and restore evidence. |
| Six fixture tests and full workspace tests | Pending / gated | Revalidate #2 first in its prepared environment. Run at most one full workspace attempt only after that passes and known build/toolchain fixes are present. |
| Deployed image stamp and Paperclip-to-Gateway connectivity | Pending | No authorized runtime execution context is available in this session. The runtime operator must record the current deployed image digest/source stamp and perform a credential-free connectivity probe from the Paperclip adapter context. No direct-port substitute. |
| Pairing, deployment, merge | Not authorized | Keep on HOLD until all gates pass and separately approved. |

Rollback: revert this separate key-protection commit. Existing legacy inline configurations will continue working through the old path; secret refs need the supported Paperclip secret provider and configured encryption key to resolve. Do not revert/alter PR #1 as part of this rollback.
