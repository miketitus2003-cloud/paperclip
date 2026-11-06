# Offline preparation for a database upgrade/rollback rehearsal

This procedure prepares a local rehearsal. It opens no database connection and
creates no backup. A prepared report is not migration, restore or release proof.
Use a separate authorized operator path for journal metadata collection; do not
copy connection strings, cookies, tokens or keys into command lines or evidence.

## Pin both artifacts and obtain metadata

Record the exact deployed build and image ID and the candidate image ID/source.
For a derived patch, record the base build stamp and patch source independently.
Export the deployed artifact's executable SQL and `meta/_journal.json` into a
local directory through the approved read-only artifact path. Check those bytes
against a trusted exact source export where available. The planner's
`sourceRevision` is a caller declaration, not proof of image provenance. Do not
substitute the qualified df0961a base for the deployed 1b4c8038 build.

ChatGPT subsequently fetched deployed source commit
`1b4c803816e82b0265c8422e1a804327a7ed8c54` into this worktree's object database.
Its Git migration export has 332 entries through `0333_normal_wild_pack`; candidate
615224c has 417 entries through `0418_curved_lady_mastermind`. The offline exact
prefix comparison found 85 additions (`0334`–`0418`) and no historical prefix
rewrite. Verify deployed image bytes against this source export and obtain the
actual applied journal before calling those additions live pending migrations.
`packages/db/src/client.ts` discovers the `__drizzle_migrations` table, preferring
`drizzle`, then `public`. It supports historical column layouts and can fall back
to timestamps. The offline planner deliberately requires exact hashes and never
infers full history from the highest timestamp, numeric migration suffix or row
ID. A different layout needs explicit review, not journal repair.

[scripts/db-rehearsal-journal-readonly.sql](../scripts/db-rehearsal-journal-readonly.sql)
contains a bounded read-only discovery transaction and a separately commented
export template. An authorized operator runs discovery, confirms schema/columns,
then exports only `id`, `hash`, `created_at` as a JSON array. No query is run by
this tooling. No-table, partial/unknown hashes, duplicate journal hashes or missing
metadata block preparation. `db:migrate` is not a diagnostic: it applies changes
and can reconcile migration history (`packages/db/src/migrate.ts`, `client.ts`).

## Prepare an offline report

Use exact 40-character revisions, trusted extracted migration directories and
new output filenames. No network client, subprocess or database URL is supported
by this script. The file-writing path refuses to overwrite existing evidence.

```sh
node scripts/prepare-db-upgrade-rehearsal.mjs manifest --migrations-dir <deployed-migration-directory> --source-revision <deployed-full-commit> --output <new-deployed-manifest.json>
node scripts/prepare-db-upgrade-rehearsal.mjs manifest --migrations-dir <candidate-migration-directory> --source-revision <candidate-full-commit> --output <new-candidate-manifest.json>
node scripts/prepare-db-upgrade-rehearsal.mjs plan --baseline <deployed-manifest.json> --candidate <candidate-manifest.json> --applied-journal <metadata-only-journal.json> --output <new-report.json>
```

Exit 0 means manifest creation or `prepared-not-executed`; exit 2 means a report
was produced with blockers; exit 1 means input/output rejection. Omit
`--applied-journal` to get a blocked preparation report rather than pretending a
fresh database. Manifest history uses journal array order while preserving the
original `idx` metadata, including historical gaps/ties. Exact prefix comparison
checks tags, hashes, indices and timestamps. Candidate additions/pending entries
include review hints for destructive/data/transaction keywords; these are coarse
review aids, not a SQL safety analysis. Review actual SQL and executor ordering
(`orderMigrationsByJournal`) before any rehearsal execution. The planner does not
emit an apply command or guarantee old-code compatibility.

Focused verification (no DB, backup, socket or model):

```sh
node scripts/__tests__/prepare-db-upgrade-rehearsal.test.mjs
```

## Rehearsal stages requiring separate execution authorization

1. Establish approved snapshot custody and scope. Logical DB dumps include the
   migration journal and plugin schemas, but exclude local encrypted master key,
   uploads and workspace files (`doc/DATABASE.md`, Backups/Secret storage).
   Record custody/permissions and recovery availability without disclosing key
   bytes. File presence/readability alone does not establish recoverability.
2. Restore the approved pre-upgrade snapshot into an owned, empty disposable
   PostgreSQL 18 database, never the live instance or an existing user database.
   Disable external execution, schedules, telemetry, connectors and outbound
   network in the isolated runtime. Use an isolated instance directory; do not
   inherit live environment or production mounts. Allocate bounded disk and
   retain at least 8 GiB user-available headroom.
3. Boot the pinned deployed artifact against that restored baseline, record
   journal metadata and company-scoped data invariants, schema inventory,
   sequence/identity behavior, plugin objects and encrypted-secret recovery via
   the approved key path. Keep values out of reports.
4. Apply the candidate's supported migration executor to the owned clone only;
   record pending SQL hashes and results, lock/statement timeout behavior,
   post-upgrade journal, counts/invariants and candidate startup. The candidate
   image is the qualified derived image, not a claim of a clean source rebuild.
5. Assess old-code startup on the upgraded clone separately. A successful old
   binary on a migrated schema is code rollback compatibility, not data rollback.
6. Prove recovery independently: restore the pre-upgrade snapshot into a second
   empty owned database, boot the pinned deployed artifact, and compare baseline
   invariants and secret recovery. Never run guessed down migrations or assume
   replacing an image reverses SQL/data changes.
7. Retain exact image/source identities, input/output hashes, sanitized checks,
   durations, failures, disk minima and owned-resource cleanup results. Require
   final human release approval; nothing here authorizes production rollout.

## Existing harnesses and limits

`packages/db/src/backup-lib.ts` exports `runDatabaseBackup` and
`runDatabaseRestore`; `backup-lib.test.ts` already exercises synthetic restore
fidelity including migration/plugin schema, triggers and identity/sequence
behavior. Backup execution can prune history according to retention, so never
point a rehearsal at the production backup directory. No such test or backup
was run during this preparation.

`scripts/e2e-update-migrations.sh` installs two refs through GitHub, uses a real
managed service, creates backups and tests payload rollback against the migrated
DB. It is not an offline or container-image rehearsal and must not run in the
current shared environment. Its cleanup removes its managed service/install.
The historical `/tmp/paperclip-secret-backup-restore/server/src/__tests__/device-secret-backup-restore.test.ts`
exercises a synthetic encrypted device secret restore, but is outside this
checkout and not proof for deployed data or this candidate. The historical
homelab image regression runner is pinned to a different image and tests selected
agent onboarding cases, not this upgrade/rollback journey. No external harness
or homelab file was modified or executed.


## Exact 85-migration compatibility review — 2026-11-06

Source-only review of deployed `1b4c803816e82b0265c8422e1a804327a7ed8c54`
through candidate `615224c525ab4f1ace0c19437b5640bb962b5668`: 0334–0418,
85 files. The deployed prefix's SQL/journal is unchanged in the offline comparison.
These are source additions, not a live pending count. No DB, model or live calls
were made. Old-code classifications below are SQL-contract inferences, not tested
binary compatibility or permission to enable new feature data.

**Decision:** do not treat this as an adapter-only database rollout. Require an
isolated upgrade and independent pre-upgrade restore before release. No direct
DROP TABLE, DROP COLUMN or TRUNCATE appears in these files; DROP INDEX/CONSTRAINT
and trigger replacements are real schema/behavior changes, not row deletion.
0376/0377 erase recovery/process fields; 0359 persists permission grants;
0396 commits a cleanup-evidence backfill in batches. Their prior values/intents
are not reconstructed by replacing the image. No SQL rotates/encrypts/decrypts
master key bytes; 0339/0370 change secret ownership and cascade semantics, and
0356 changes invalidation on secret/vault mutations. External archive cleanup
introduced by 0415 is an additional recovery boundary after application activity.

Legend: **A** additive schema/index; **C** constraint/uniqueness/nullability;
**W** immediate data backfill/write; **D** information-erasing write;
**H** installed function/trigger behavior on subsequent writes; **S** security,
secret/authorization ownership semantics (not necessarily a grant).
**I** index/statistics work. Risk is rehearsal priority, not an exploit finding.
Old-code **A** means existing SQL shape appears tolerable in isolation; verify
startup/writes, and retain the global warning about new feature data. **B** means
old writers/readers or recovery logic may diverge: no compatibility assumption.
Every row has a source link and a clone acceptance check. Composite and unique
constraints must be tested against actual restored data; IF NOT EXISTS does not
prove the existing object has the intended definition.

| Migration | Class / priority | SQL effect | Old-code class and required clone check |
| --- | --- | --- | --- |
| [0334_rare_slipstream](../packages/db/src/migrations/0334_rare_slipstream.sql) | A/C · medium | Repository skill snapshots; NOT NULL package_mode default, company FK, restricted version FK, unique content hash. | A: Existing skill versions resolve; company/content uniqueness and snapshot deletion restrictions. |
| [0335_absurd_bulldozer](../packages/db/src/migrations/0335_absurd_bulldozer.sql) | S/C · medium | Slack manager-grant owner uniqueness/status check and company-scoped registration FK; secret references, no token rewrite. | B: Grant owner uniqueness; registration company match; revoked/reauthorize handling. |
| [0336_big_crystal](../packages/db/src/migrations/0336_big_crystal.sql) | C · high | Workspace project_id becomes nullable; project FK changes to RESTRICT; repository ledger and three uniqueness rules. | B: Projectless workspace read/write and deletion; repository identity/path/request duplicates. |
| [0337_exotic_proemial_gods](../packages/db/src/migrations/0337_exotic_proemial_gods.sql) | A/C · medium | Repository-root ownership table with company/root unique key and cascade FK. | A: Root identity collisions and company deletion behavior. |
| [0338_absurd_vengeance](../packages/db/src/migrations/0338_absurd_vengeance.sql) | A/C · medium | Repository-access ledger stores issue/agent/responsible-user provenance; unique company/root/kind/scope. | A: Isolation and retained access provenance; no grants are created by this SQL. |
| [0339_luxuriant_iron_monger](../packages/db/src/migrations/0339_luxuriant_iron_monger.sql) | S/C · high | Secrets gain agent/plugin owners and instance scope; shape check, same-company agent FK, cascade ownership and partial unique key. | B: All existing secret shapes; new instance ownership, plugin/agent deletion cascade; old secret reader behavior. |
| [0340_open_warlock](../packages/db/src/migrations/0340_open_warlock.sql) | C · medium | Lifecycle action check replaced to allow project update/archive/delete and agent pause/resume/terminate. | B: Existing rows validate and old readers tolerate expanded actions. |
| [0341_abnormal_bucky](../packages/db/src/migrations/0341_abnormal_bucky.sql) | C · high | Skill source scheduling/access columns and project sources; drops connection/agent FKs; active-only partial uniqueness replaces full unique indexes. | B: Old upsert conflict inference, removed-source duplicates, retained identity and refresh ownership after deletes. |
| [0342_dry_shen](../packages/db/src/migrations/0342_dry_shen.sql) | A/C · low | Per-company skill import-byte budget table with default and company cascade FK. | A: Budget row uniqueness/default; old code ignores new enforcement. |
| [0343_new_mentor](../packages/db/src/migrations/0343_new_mentor.sql) | W · medium | Backfills null agent created_by_user_id from earliest matching company-scoped human activity. | A: Affected/null counts and earliest-actor provenance; do not mistake creator attribution for execution authority. |
| [0344_wide_blue_marvel](../packages/db/src/migrations/0344_wide_blue_marvel.sql) | S/C · high | Grok bot routines/dispatch ledgers, secret/grant FKs; Dot provider-kind default; attachment grant/session columns. | B: Secret/grant custody and delete cascades; old provider-kind routing with newly created records. |
| [0345_luxuriant_carmella_unuscione](../packages/db/src/migrations/0345_luxuriant_carmella_unuscione.sql) | I · medium | Concurrent non-unique indexes: `heartbeat_runs_company_ctx_paperclip_issue_created_idx`, `heartbeat_runs_company_origin_issue_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0346_cloudy_whiplash](../packages/db/src/migrations/0346_cloudy_whiplash.sql) | I · medium | Non-concurrent Grok assignment/kind index. | A: Measure write-blocking duration and index validity. |
| [0347_flippant_imperial_guard](../packages/db/src/migrations/0347_flippant_imperial_guard.sql) | H/W/C · high | Runtime lifecycle types/checks; agent/activity triggers, notification function and seed runtime events for existing invokable agents. | B: Old agent/file mutations now fire triggers; journal fan-out, locks, UUID activity conversion, event consumer compatibility. |
| [0348_agent_skill_runtime_hooks](../packages/db/src/migrations/0348_agent_skill_runtime_hooks.sql) | H · high | Skill/policy/source/project/privacy/feature-flag triggers invalidate selected agent runtimes. | B: Bulk skill/access updates; lock order/fan-out; old writes trigger new durable events. |
| [0349_oval_dragon_lord](../packages/db/src/migrations/0349_oval_dragon_lord.sql) | S/C · high | Muse credentials (hashes), bindings, mailbox, assignments, operations and external holds; cascade FKs and active/request uniqueness. | B: Company/agent identity, stop holds, grant generation and sequence restore; no pairing is performed by SQL. |
| [0350_friendly_rhodey](../packages/db/src/migrations/0350_friendly_rhodey.sql) | A · medium | Muse qualification/deadline timestamps and contact evidence array/incomplete defaults. | A: Existing contact rows get safe defaults; old workers cannot produce new evidence. |
| [0351_hard_albert_cleary](../packages/db/src/migrations/0351_hard_albert_cleary.sql) | A · low | Muse detector-removal and mailbox signal-attempt/notified columns. | A: Defaults and retry state persistence. |
| [0352_special_warbound](../packages/db/src/migrations/0352_special_warbound.sql) | A · low | Nullable Muse continuation receipt ID. | A: Null/default behavior and receipt attribution. |
| [0353_skinny_gamma_corps](../packages/db/src/migrations/0353_skinny_gamma_corps.sql) | S/C · medium | Muse grant FK SET NULL and active-grant partial uniqueness. | B: Duplicate active grant bindings and grant revocation/deletion. |
| [0354_agent_connection_assignment_hooks](../packages/db/src/migrations/0354_agent_connection_assignment_hooks.sql) | H · high | Replaces runtime hooks with NO KEY UPDATE locks; statement-level connector transitions and flag triggers. | B: Concurrent agent/connector mutations, transactional journal atomicity, unchanged-write suppression. |
| [0355_agent_tool_definition_hooks](../packages/db/src/migrations/0355_agent_tool_definition_hooks.sql) | H/S · high | Tool definition/policy selector parsing and broader statement triggers; ignored credential/health fields in this intermediate definition. | B: Selector intersection, bulk updates and credential-change behavior after final 0356 replacement. |
| [0356_agent_connector_access_hooks](../packages/db/src/migrations/0356_agent_connector_access_hooks.sql) | H/S · high | Connector triggers extend to grants, memberships, secret bindings, routes, identity, voice/email and vault metadata. | B: Old permission/secret writes trigger invalidation; company isolation, grant revocation, credential rotation and lock fan-out. |
| [0357_naive_wolfpack](../packages/db/src/migrations/0357_naive_wolfpack.sql) | S/A · medium | Company observability settings, disabled default, secret credential FK SET NULL. | A: Disabled stays disabled; credential deletion and company isolation; no telemetry/privacy inference from table name. |
| [0358_issue_assignment_status_version](../packages/db/src/migrations/0358_issue_assignment_status_version.sql) | H · high | Assignment change trigger increments issue status_version on assignee changes. | B: Old assignment writes and optimistic concurrency; concurrent assignment/status updates. |
| [0359_commentary_view_human_defaults](../packages/db/src/migrations/0359_commentary_view_human_defaults.sql) | W/S · high | Inserts commentary:view grants for every active human membership, ON CONFLICT DO NOTHING. | B: Review permission expansion, existing scoped grants and exact inserted-row count; snapshot needed to undo selectively. |
| [0360_retained_workspace_recovery_index](../packages/db/src/migrations/0360_retained_workspace_recovery_index.sql) | I · medium | Non-concurrent retained-workspace recovery index. | A: Measure lock/write impact and recovery predicate correctness. |
| [0361_mighty_dracula](../packages/db/src/migrations/0361_mighty_dracula.sql) | C · medium | AI default provider checks replaced, admitting github. | B: Existing provider values and old code on newly introduced provider data. |
| [0362_large_roughhouse](../packages/db/src/migrations/0362_large_roughhouse.sql) | S/C · high | Prompt-injection settings/invocations and budget-source/usage-kind check replacements. | B: Exactly one reservation source; existing budget rows validate; old readers of new usage kinds. |
| [0363_steady_storm](../packages/db/src/migrations/0363_steady_storm.sql) | W/C · high | Conditional case foundation adds handoffs, restrictive issue/agent FKs, pending uniqueness and historical access-source backfill. | B: Empty and preview-ahead schemas; case_handoffs presence must not hide partial foundation; preserve all access boundaries. |
| [0364_clear_maria_hill](../packages/db/src/migrations/0364_clear_maria_hill.sql) | C/I · medium | Case source-run index and unique wakeup-request index. | B: Existing duplicate wakeup IDs; old writers respect new uniqueness. |
| [0365_naive_shatterstar](../packages/db/src/migrations/0365_naive_shatterstar.sql) | C · high | Handoff from-agent FK changes SET NULL to RESTRICT. | B: Historical attribution survives; old agent-purge paths must fail safely. |
| [0366_superb_adam_warlock](../packages/db/src/migrations/0366_superb_adam_warlock.sql) | C · high | Terminal handoffs allow null to_agent_id, add destination/state checks and widen pending uniqueness. | B: Old code on done/null recipients and awaiting_completion; conflicting pending handoffs. |
| [0367_noisy_lilandra](../packages/db/src/migrations/0367_noisy_lilandra.sql) | C · medium | Case-event kind check now includes handoff_completed. | B: Existing checks pass; old event readers handle new kind. |
| [0368_abandoned_bucky](../packages/db/src/migrations/0368_abandoned_bucky.sql) | S/A · medium | Nullable handoff actor_context authorization projection. | B: Legacy null-context transfers fail closed in application; do not synthesize authority on rollback. |
| [0369_late_logan](../packages/db/src/migrations/0369_late_logan.sql) | C/I · high | Concurrent task-retry idempotency unique index plus five recovery/adoption indexes. | B: Duplicate task-retry keys before unique build; retry old writers; interrupted index validity. |
| [0370_flimsy_lord_tyger](../packages/db/src/migrations/0370_flimsy_lord_tyger.sql) | S/C · high | Project-owned instance secrets; owner XOR agent/project, same-company project FK CASCADE and unique project/plugin/key. | B: Secret ownership shapes, old readers and project deletion cascade; no key material transformed. |
| [0371_furry_red_shift](../packages/db/src/migrations/0371_furry_red_shift.sql) | A/C · medium | Workflows and case workflow metadata, nullable links and RESTRICT workflow FK. | B: Deletion behavior and old code ignoring adopted workflow guidance. |
| [0372_mature_the_initiative](../packages/db/src/migrations/0372_mature_the_initiative.sql) | H/C · high | Restore-point ledger and uniqueness; issue tree/status/delete triggers change ancestor restore retention immediately. | B: Old issue edits affect delete_after/review_generation; external restore archives must remain recoverable. |
| [0373_wandering_mongu](../packages/db/src/migrations/0373_wandering_mongu.sql) | A · low | Interaction dismissed timestamp/user fields. | A: Old UI may redisplay dismissed interactions; preserve metadata. |
| [0374_rare_wolfpack](../packages/db/src/migrations/0374_rare_wolfpack.sql) | C · medium | Restore-point uniqueness changes to include checkout_name default empty. | B: Existing rows/default uniqueness and old writers assuming one checkout per generation. |
| [0375_short_mercury](../packages/db/src/migrations/0375_short_mercury.sql) | C · medium | Restore-point uniqueness narrows to pending/active/expiring statuses. | B: Old lookup logic against multiple retained/non-live generations. |
| [0376_clear_committed_native_recovery_state](../packages/db/src/migrations/0376_clear_committed_native_recovery_state.sql) | D/W · high | Clears committed unleased native finalization recovery_state and recovery_request_id. | B: Record affected IDs/counts in clone; cleared values require snapshot to reconstruct; completed work must not rerun. |
| [0377_clear_settled_native_run_process_identity](../packages/db/src/migrations/0377_clear_settled_native_run_process_identity.sql) | D/W · high | Clears stale terminal native process identity only with checkpoint/event and fully proven released remote leases. | B: Verify every lease termination identity guard and excluded local/unfinished cases; snapshot required for cleared PID/time fields. |
| [0378_environment_skill_runtime_hooks](../packages/db/src/migrations/0378_environment_skill_runtime_hooks.sql) | H/S · high | Environment/plugin/default-environment skill hooks join managed resources to invalidate selected agent runtimes. | B: Old plugin/environment updates, manifest shape, locks/fan-out and company-scoped skill access. |
| [0379_white_giant_girl](../packages/db/src/migrations/0379_white_giant_girl.sql) | S/C · medium | Project Git grant/user authorization metadata; grant deletion SET NULL. | B: Null historical grant state, old Git access paths and revocation behavior. |
| [0380_broken_aqueduct](../packages/db/src/migrations/0380_broken_aqueduct.sql) | S/A · medium | Gateway tokens gain nullable responsible_user_id; no backfill. | B: Historical null tokens remain null; new application attribution must fail closed as appropriate. |
| [0381_mean_scream](../packages/db/src/migrations/0381_mean_scream.sql) | I · medium | Concurrent non-unique index: `tool_gateway_sessions_expiry_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0382_narrow_the_executioner](../packages/db/src/migrations/0382_narrow_the_executioner.sql) | I · medium | Concurrent non-unique index: `tool_action_requests_pending_expiry_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0383_tool_review_company_expiry](../packages/db/src/migrations/0383_tool_review_company_expiry.sql) | I · medium | Concurrent non-unique index: `tool_action_requests_company_pending_expiry_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0384_funny_adam_warlock](../packages/db/src/migrations/0384_funny_adam_warlock.sql) | I · medium | Concurrent non-unique index: `tool_action_requests_approved_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0385_open_madame_web](../packages/db/src/migrations/0385_open_madame_web.sql) | I · medium | Concurrent non-unique index: `tool_action_requests_executing_deadline_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0386_steady_epoch](../packages/db/src/migrations/0386_steady_epoch.sql) | I · medium | Concurrent non-unique index: `tool_action_requests_company_interaction_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0387_boring_professor_monster](../packages/db/src/migrations/0387_boring_professor_monster.sql) | I · medium | Concurrent non-unique index: `decision_archive_notification_outbox_delivery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0388_ambitious_micromax](../packages/db/src/migrations/0388_ambitious_micromax.sql) | I · medium | Concurrent non-unique index: `decisions_pending_continuation_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0389_brave_hulk](../packages/db/src/migrations/0389_brave_hulk.sql) | I · medium | Concurrent non-unique index: `decisions_open_expiry_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0390_salty_killraven](../packages/db/src/migrations/0390_salty_killraven.sql) | I · medium | Concurrent non-unique index: `decisions_running_recovery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0391_third_roulette](../packages/db/src/migrations/0391_third_roulette.sql) | I · medium | Concurrent non-unique index: `grok_dispatch_prepared_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0392_small_frightful_four](../packages/db/src/migrations/0392_small_frightful_four.sql) | I · medium | Concurrent non-unique index: `approvals_pending_retention_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0393_open_grandmaster](../packages/db/src/migrations/0393_open_grandmaster.sql) | I · medium | Concurrent non-unique index: `join_requests_pending_retention_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0394_conscious_whizzer](../packages/db/src/migrations/0394_conscious_whizzer.sql) | A/C · medium | Native checkpoints table with run/part PK and composite company/issue/run FK CASCADE. | A: Composite attribution and checkpoint restore; old runtime ignores new saved state. |
| [0395_tranquil_firestar](../packages/db/src/migrations/0395_tranquil_firestar.sql) | I · medium | Concurrent non-unique index: `activity_log_company_user_issue_actor_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0396_tan_paladin](../packages/db/src/migrations/0396_tan_paladin.sql) | W/I · high | Voice provider/cleanup columns, concurrent index; batches mark eligible ended calls cleanup_confirmed_at=updated_at with COMMIT per batch. | B: Compare ended/no-approval or ended-activity proof; interrupt/resume batches; timestamp is historical evidence, not a fresh provider cleanup. |
| [0397_known_madrox](../packages/db/src/migrations/0397_known_madrox.sql) | I · medium | Concurrent non-unique index: `chat_voice_sessions_report_window_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0398_yielding_random](../packages/db/src/migrations/0398_yielding_random.sql) | I · medium | Concurrent non-unique index: `chat_actions_confirmation_recovery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0399_ambitious_onslaught](../packages/db/src/migrations/0399_ambitious_onslaught.sql) | I · medium | Concurrent non-unique index: `chat_actions_continuation_work_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0400_absent_phantom_reporter](../packages/db/src/migrations/0400_absent_phantom_reporter.sql) | I · medium | Concurrent non-unique indexes: `chat_actions_github_ack_work_idx`, `chat_publications_comment_destination_idx`, `fast_response_requests_delivery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0401_yummy_ultimates](../packages/db/src/migrations/0401_yummy_ultimates.sql) | I · medium | Concurrent non-unique index: `chat_actions_github_terminal_work_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0402_ancient_malice](../packages/db/src/migrations/0402_ancient_malice.sql) | I · medium | Concurrent non-unique index: `chat_actions_github_check_work_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0403_natural_cerise](../packages/db/src/migrations/0403_natural_cerise.sql) | I · medium | Concurrent non-unique indexes: `chat_actions_github_stale_head_idx`, `chat_github_reviews_projection_work_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0404_tense_silver_sable](../packages/db/src/migrations/0404_tense_silver_sable.sql) | A/C · low | Instance-wide user workspace preferences with unique user ID. | A: Old UI ignores presentation preference; no execution authority created. |
| [0405_harsh_avengers](../packages/db/src/migrations/0405_harsh_avengers.sql) | A/C · medium | Interaction idempotency alias table, cascade FKs and unique company/issue/key. | B: Conflicting keys and company/task attribution; old creation bypasses alias semantics. |
| [0406_zippy_war_machine](../packages/db/src/migrations/0406_zippy_war_machine.sql) | I · medium | Concurrent non-unique index: `heartbeat_runs_scheduled_retry_cancellation_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0407_greedy_star_brand](../packages/db/src/migrations/0407_greedy_star_brand.sql) | I · medium | Concurrent non-unique index: `agent_instruction_copies_cleanup_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0408_short_red_skull](../packages/db/src/migrations/0408_short_red_skull.sql) | I · medium | Concurrent non-unique index: `agent_instruction_copies_collection_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0409_uneven_zuras](../packages/db/src/migrations/0409_uneven_zuras.sql) | I · medium | Concurrent non-unique index: `heartbeat_runs_cancelled_workspace_preservation_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0410_freezing_kinsey_walden](../packages/db/src/migrations/0410_freezing_kinsey_walden.sql) | I · medium | Concurrent non-unique index: `native_run_finalizations_unsafe_export_recovery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0411_real_scrambler](../packages/db/src/migrations/0411_real_scrambler.sql) | I · medium | Concurrent non-unique indexes: `native_run_finalizations_pending_effect_owner_idx`, `status_decision_effects_pending_delivery_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0412_tearful_squadron_supreme](../packages/db/src/migrations/0412_tearful_squadron_supreme.sql) | I · medium | Concurrent native-response index plus expression statistics and ANALYZE heartbeat_runs. | A: Index validity and statistics/load on large run history; measure ANALYZE time. |
| [0413_tired_kronos](../packages/db/src/migrations/0413_tired_kronos.sql) | I · medium | Concurrent non-unique index: `issue_comments_review_response_receipt_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0414_closed_edwin_jarvis](../packages/db/src/migrations/0414_closed_edwin_jarvis.sql) | I · medium | Concurrent non-unique index: `activity_log_company_entity_created_idx`. | A: Direct session/non-transaction executor; disk/time budget and interrupted-build index validity. |
| [0415_zippy_zemo](../packages/db/src/migrations/0415_zippy_zemo.sql) | H/A · high | Skill package storage/upload/restore metadata and due defaults; deletion/maintenance triggers queue external archive cleanup. | B: No archive deleted by SQL itself; old writes still queue cleanup, and later package conversion/external deletion needs filesystem/object recovery. |
| [0416_salty_domino](../packages/db/src/migrations/0416_salty_domino.sql) | I · high | Drops/rebuilds workspace-preservation index non-concurrently to add restore_invalid_metadata exclusion. | A: Measure blocking; regular transactional index rebuild differs from concurrent predecessor 0409. |
| [0417_chunky_red_hulk](../packages/db/src/migrations/0417_chunky_red_hulk.sql) | A/C · medium | Company-scoped skill mutation receipts and unique company/key. | B: Replay fingerprint consistency and old writers without receipt updates. |
| [0418_curved_lady_mastermind](../packages/db/src/migrations/0418_curved_lady_mastermind.sql) | A/C · medium | Sandbox creation operation ledger, environment FK SET NULL, pending deadline and owner uniqueness. | B: Owned operation identity, environment deletion and duplicate create requests; no sandbox provisioned by SQL. |


### Execution and rollback gates from the review

- **Index/migration execution:** concurrent indexes and 0396's COMMIT require
  the supported reserved-session executor in `packages/db/src/client.ts`
  (`MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS`), not a blanket transaction. Its
  invalid-index retry handling is source evidence only. Confirm `indisvalid`,
  exact predicates, duplicate keys (especially 0364/0369), migration hashes,
  timeouts, lock duration and disk headroom on the clone. 0416 is a regular
  transactional DROP/rebuild and can block writes despite the many concurrent
  indexes before it.
- **Security/data changes:** record pre/post counts and non-secret ownership
  invariants for 0339/0370, membership grants for 0359, creators for 0343,
  case access sources for 0363, cleared fields for 0376/0377, and eligible voice
  calls for 0396. Compare affected record identities inside restricted rehearsal
  evidence; do not publish secrets or raw call payloads. A migration applying
  grants is an impactful change, not authorized by this source-only review.
- **Old-code write paths:** exercise agent/file updates, bulk skill/connector
  changes, permission/secret/vault changes, issue assignment/status/tree edits
  and skill snapshot updates/deletion after all migrations. Triggers survive
  reverting application code and can add locks, durable events and cleanup work.
  Test old skill-source upsert/conflict inference against 0341's partial unique
  indexes; old assumptions about non-null workspace projects (0336), secret
  scope (0339/0370), handoff recipients/states (0366), retry uniqueness (0369)
  and restored-generation uniqueness (0374/0375) are explicit rollback gates.
- **Replay and restoration:** test empty and schema-ahead/partially migrated
  clones, especially conditional 0363 and top-level 0396. A journal row is not
  proof of complete constraints/index validity. Reverting code leaves all
  backfills, grants, new scopes and trigger behavior in place. Use the separate
  pre-upgrade snapshot restore path for data rollback and preserve the matching
  encryption key plus required filesystem/object artifacts. Do not invent down
  migrations or delete history to force old startup.

### Demonstrated offline-planner gaps repaired

The planner accepted two files with distinct tags sharing a numeric migration
prefix, although `packages/db/src/check-migration-numbering.ts` rejects that
history. It also marked a complete hash export with duplicate journal primary
IDs as prepared. Two regressions failed before correction; validation now rejects
duplicate migration numbers and blocks duplicate journal IDs while preserving
historical non-contiguous/tied `idx` values. The focused suite passed **12/12**
(`/tmp/paperclip-migration-planner-red.log` retains the two failures;
`/tmp/paperclip-migration-planner-green.log` records success). No migration SQL or
runtime executor changed. Lexical review hints remain coarse aids; they are not
the classifications above or a substitute for SQL review. No adapter/image suite
was rerun and no restore/upgrade execution was performed.
