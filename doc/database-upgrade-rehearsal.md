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
