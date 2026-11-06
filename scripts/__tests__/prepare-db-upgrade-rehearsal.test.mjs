import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createManifest, planRehearsal } from "../prepare-db-upgrade-rehearsal.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-offline-rehearsal-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ entries: [
    { idx: 0, tag: "0000_initial", when: 1 }, { idx: 1, tag: "0001_next", when: 2 },
  ] }));
  writeFileSync(join(dir, "0000_initial.sql"), "CREATE TABLE fixture(id int);");
  writeFileSync(join(dir, "0001_next.sql"), "ALTER TABLE fixture ADD COLUMN title text;");
  return dir;
}
const revision = "a".repeat(40);
function withManifest(run) {
  const dir = fixture();
  try { run(createManifest(dir, revision), dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const rows = (manifest) => manifest.migrations.map((entry, index) => ({ id: index + 1, hash: entry.sha256, created_at: String(entry.when) }));

test("plans actual extension by hash without timestamp or ID-order inference", () => withManifest((next) => {
  const base = { ...next, migrations: next.migrations.slice(0, 1) };
  const applied = rows(base).map((row) => ({ ...row, id: 99, created_at: "999999999" }));
  const result = planRehearsal(base, next, applied);
  assert.equal(result.status, "prepared-not-executed");
  assert.deepEqual(result.pending.map((entry) => entry.tag), ["0001_next"]);
  assert.equal(result.executed, false);
}));
test("blocks rewritten history even when all deployed hashes are present", () => withManifest((base) => {
  const next = structuredClone(base); next.migrations[0].sha256 = "b".repeat(64);
  assert.ok(planRehearsal(base, next, rows(base)).blockers.includes("historical-migration-rewritten-or-reordered"));
}));
test("blocks removed history", () => withManifest((base) => {
  const next = { ...base, migrations: base.migrations.slice(0, 1) };
  assert.ok(planRehearsal(base, next, rows(base)).blockers.includes("candidate-removes-migrations"));
}));
test("missing journal is blocked, never treated as a fresh database", () => withManifest((base) => {
  assert.deepEqual(planRehearsal(base, base).blockers, ["deployed-journal-export-required"]);
  assert.ok(planRehearsal(base, base, []).blockers.includes("deployed-artifact-journal-incomplete"));
}));
test("unknown, duplicate and gapped journal evidence blocks preparation", () => withManifest((base) => {
  assert.ok(planRehearsal(base, base, [{ id: 1, hash: "c".repeat(64), created_at: "999999999" }]).blockers.includes("journal-hash-not-in-deployed-artifact"));
  const applied = rows(base);
  assert.ok(planRehearsal(base, base, [...applied, applied[0]]).blockers.includes("duplicate-journal-hash"));
  assert.ok(planRehearsal(base, base, applied.slice(1)).blockers.includes("deployed-artifact-journal-incomplete"));
}));
test("rejects unsafe tags and unjournaled SQL", () => withManifest((_base, dir) => {
  writeFileSync(join(dir, "untracked.sql"), "SELECT 1;");
  assert.throws(() => createManifest(dir, revision), /Unjournaled/);
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ entries: [{ idx: 0, tag: "../outside", when: 1 }] }));
  assert.throws(() => createManifest(dir, revision), /Invalid migration tag/);
}));
test("rejects extra potentially sensitive journal fields", () => withManifest((base) => {
  assert.throws(() => planRehearsal(base, base, rows(base).map((row) => ({ ...row, token: "do-not-echo" }))), /metadata/);
}));
test("CLI rejects DB URLs without echoing credentials or invoking a DB", () => {
  const result = spawnSync(process.execPath, ["scripts/prepare-db-upgrade-rehearsal.mjs", "plan", "--database-url", "postgres://do-not-echo"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /do-not-echo/);
});
test("CLI will not overwrite an existing evidence file", () => withManifest((_base, dir) => {
  const file = join(dir, "existing.json"); writeFileSync(file, "preserve me");
  const result = spawnSync(process.execPath, ["scripts/prepare-db-upgrade-rehearsal.mjs", "manifest", "--migrations-dir", dir, "--source-revision", revision, "--output", file], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(file, "utf8"), "preserve me");
}));

test("preserves historical non-contiguous and tied idx metadata", () => withManifest((base, dir) => {
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8"));
  journal.entries.forEach((entry) => { entry.idx = 178; });
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  const manifest = createManifest(dir, revision);
  assert.deepEqual(manifest.migrations.map((entry) => entry.idx), [178, 178]);
  assert.equal(planRehearsal(manifest, manifest, rows(manifest)).status, "prepared-not-executed");
}));

test("rejects duplicate migration numbers accepted under distinct tags", () => withManifest((base, dir) => {
  const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8"));
  journal.entries.push({ idx: 2, tag: "0001_duplicate", when: 3 });
  writeFileSync(join(dir, "0001_duplicate.sql"), "SELECT 123;");
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify(journal));
  assert.throws(() => createManifest(dir, revision), /migration number/);
}));

test("blocks impossible duplicate primary IDs in an otherwise complete journal export", () => withManifest((base) => {
  const applied = rows(base).map((row) => ({ ...row, id: 1 }));
  assert.ok(planRehearsal(base, base, applied).blockers.includes("duplicate-journal-id"));
}));
