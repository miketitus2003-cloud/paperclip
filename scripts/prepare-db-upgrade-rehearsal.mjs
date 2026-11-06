#!/usr/bin/env node
/** Offline artifact planner only: never opens a DB, runs SQL, or creates a backup. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const revisionPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const tagPattern = /^\d{4}_[a-z0-9_]+$/;
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function validateManifest(manifest) {
  if (manifest?.format !== 1 || !revisionPattern.test(manifest.sourceRevision) || !Array.isArray(manifest.migrations)) {
    throw new Error("Expected versioned manifest with exact source revision");
  }
  const tags = new Set(), hashes = new Set(), numbers = new Set();
  for (const entry of manifest.migrations) {
    if (!Number.isSafeInteger(entry.idx) || entry.idx < 0 || !tagPattern.test(entry.tag) || !hashPattern.test(entry.sha256)
      || !Number.isSafeInteger(entry.when) || entry.when < 0 || tags.has(entry.tag) || hashes.has(entry.sha256)) {
      throw new Error("Invalid or ambiguous migration manifest history");
    }
    if (Object.keys(entry).some((key) => !["idx", "tag", "when", "sha256", "reviewHints"].includes(key))
      || !Array.isArray(entry.reviewHints) || entry.reviewHints.some((hint) => !["destructive-keyword", "data-change-keyword", "transaction-boundary-keyword"].includes(hint))) {
      throw new Error("Unexpected migration manifest fields");
    }
    const number = entry.tag.slice(0, 4);
    if (numbers.has(number)) throw new Error("Duplicate migration number");
    numbers.add(number);
    tags.add(entry.tag); hashes.add(entry.sha256);
  }
  if (!manifest.migrations.length) throw new Error("Empty migration manifest is not deployed history");
}

export function createManifest(directory, sourceRevision) {
  const journal = readJson(resolve(directory, "meta/_journal.json"));
  if (!Array.isArray(journal.entries)) throw new Error("Missing migration journal entries");
  const migrations = journal.entries.map(({ idx, tag, when }) => {
    if (!tagPattern.test(tag)) throw new Error("Invalid migration tag");
    const sql = readFileSync(resolve(directory, `${tag}.sql`));
    // Review hints only. SQL parsing and execution are deliberately out of scope.
    const reviewHints = [];
    if (/\b(DROP|TRUNCATE)\b/i.test(sql.toString())) reviewHints.push("destructive-keyword");
    if (/\b(UPDATE|DELETE|INSERT)\b/i.test(sql.toString())) reviewHints.push("data-change-keyword");
    if (/\b(CONCURRENTLY|COMMIT)\b/i.test(sql.toString())) reviewHints.push("transaction-boundary-keyword");
    return { idx, tag, when, sha256: createHash("sha256").update(sql).digest("hex"), reviewHints };
  });
  const listed = new Set(migrations.map(({ tag }) => `${tag}.sql`));
  if (readdirSync(directory).some((file) => file.endsWith(".sql") && !listed.has(file))) {
    throw new Error("Unjournaled SQL files require review");
  }
  const manifest = { format: 1, sourceRevision, migrations };
  validateManifest(manifest);
  return manifest;
}

export function planRehearsal(baseline, candidate, appliedRows) {
  validateManifest(baseline); validateManifest(candidate);
  const blockers = [];
  if (baseline.migrations.length > candidate.migrations.length) blockers.push("candidate-removes-migrations");
  if (baseline.migrations.some((entry, index) => {
    const next = candidate.migrations[index];
    return !next || ["idx", "tag", "when", "sha256"].some((field) => next[field] !== entry[field]);
  })) blockers.push("historical-migration-rewritten-or-reordered");
  const pending = [];
  if (appliedRows === undefined) blockers.push("deployed-journal-export-required");
  else {
    if (!Array.isArray(appliedRows)) throw new Error("Expected journal row array");
    const hashes = new Set(), ids = new Set();
    for (const row of appliedRows) {
      if (!row || Object.keys(row).some((key) => !["id", "hash", "created_at"].includes(key))
        || !hashPattern.test(row.hash) || !Number.isSafeInteger(row.id) || row.id < 1
        || (row.created_at !== null && !/^\d+$/.test(String(row.created_at)))) {
        throw new Error("Expected only id/hash/created_at journal metadata");
      }
      if (hashes.has(row.hash)) blockers.push("duplicate-journal-hash");
      if (ids.has(row.id)) blockers.push("duplicate-journal-id");
      ids.add(row.id);
      hashes.add(row.hash);
    }
    const baselineHashes = new Set(baseline.migrations.map(({ sha256 }) => sha256));
    if ([...hashes].some((hash) => !baselineHashes.has(hash))) blockers.push("journal-hash-not-in-deployed-artifact");
    if (baseline.migrations.some(({ sha256 }) => !hashes.has(sha256))) blockers.push("deployed-artifact-journal-incomplete");
    for (const entry of candidate.migrations) if (!hashes.has(entry.sha256)) pending.push(entry);
  }
  return {
    format: 1, kind: "offline-rehearsal-preparation", baselineRevision: baseline.sourceRevision,
    candidateRevision: candidate.sourceRevision, blockers: [...new Set(blockers)],
    status: blockers.length ? "blocked" : "prepared-not-executed",
    candidateAdditions: candidate.migrations.slice(baseline.migrations.length), pending,
    rollback: "Restore pre-upgrade snapshot into a separate empty database and boot pinned deployed artifact; no automatic down migrations",
    requiredEvidence: ["exact-artifact-identities", "read-only-deployed-journal", "separately-authorized-backup-and-key-custody",
      "isolated-restore-baseline", "candidate-upgrade-and-data-invariants", "old-code-on-upgraded-db-assessment",
      "independent-pre-upgrade-restore-and-old-artifact-startup", "cleanup-and-final-release-approval"],
    executed: false,
  };
}

function main(args) {
  const [mode, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || !rest[index + 1] || Object.hasOwn(options, rest[index])) throw new Error("Expected unique --option value pairs");
    options[rest[index]] = rest[index + 1];
  }
  const allowed = mode === "manifest" ? ["--migrations-dir", "--source-revision", "--output"]
    : mode === "plan" ? ["--baseline", "--candidate", "--applied-journal", "--output"] : [];
  if (!allowed.length || Object.keys(options).some((key) => !allowed.includes(key))) throw new Error("Use manifest or plan with documented file options; no database URLs accepted");
  let report;
  if (mode === "manifest") {
    if (!options["--migrations-dir"] || !options["--source-revision"]) throw new Error("Manifest requires directory and exact source revision");
    report = createManifest(options["--migrations-dir"], options["--source-revision"]);
  } else {
    if (!options["--baseline"] || !options["--candidate"]) throw new Error("Plan requires baseline and candidate manifests");
    report = planRehearsal(readJson(options["--baseline"]), readJson(options["--candidate"]),
      options["--applied-journal"] ? readJson(options["--applied-journal"]) : undefined);
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options["--output"]) writeFileSync(options["--output"], json, { flag: "wx", mode: 0o600 });
  else process.stdout.write(json);
  if (report.status === "blocked") process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Offline rehearsal input rejected; verify documented manifests, paths and metadata format. No database action performed."); process.exitCode = 1; }
}
