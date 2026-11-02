#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly BASE_CANDIDATE="968b62447626274a79360334c69b54da7ce76896"
readonly TEST_FILE="server/src/__tests__/device-secret-backup-restore.test.ts"
readonly EXPECTED_TEST_BLOB="9d592e87a34a89f56ff0a197f3358a3632cf79e9"
NODE24="${NODE24:-/tmp/paperclip-test-tools/node_modules/node/bin/node}"
PNPM_CLI="${PNPM_CLI:-/tmp/paperclip-workspace-tools/node_modules/pnpm/bin/pnpm.cjs}"
PNPM_STORE="${PNPM_STORE:-/tmp/paperclip-pnpm-store}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
NODE_BIN="$(dirname "$NODE24")"
WORK_ROOT="$(mktemp -d /tmp/paperclip-secret-backup-restore-work.XXXXXX)"
LOG_DIR="${LOG_DIR:-$(mktemp -d /tmp/paperclip-secret-backup-restore-logs.XXXXXX)}"
SCRATCH="$WORK_ROOT/scratch"
LAUNCHER_DIR="$WORK_ROOT/bin"
mkdir -p "$SCRATCH/home" "$SCRATCH/tmp" "$SCRATCH/cache" \
  "$SCRATCH/paperclip-home" "$LAUNCHER_DIR" "$LOG_DIR"
export NODE24 PNPM_CLI PNPM_STORE

cleanup() { rm -rf "$WORK_ROOT"; }
trap cleanup EXIT

if [[ ! -x "$NODE24" ]] || [[ "$("$NODE24" --version)" != "v24.11.0" ]]; then
  echo "BLOCKED: expected Node 24.11.0 at $NODE24" >&2
  exit 2
fi
if [[ ! -f "$PNPM_CLI" ]] || [[ ! -d "$PNPM_STORE" ]]; then
  echo "BLOCKED: prepared pnpm CLI/store is missing; no network install will be attempted." >&2
  exit 2
fi
if ! git merge-base --is-ancestor "$BASE_CANDIDATE" HEAD; then
  echo "BLOCKED: checkout is not based on candidate $BASE_CANDIDATE" >&2
  exit 2
fi
if [[ ! -f "$TEST_FILE" ]] || [[ "$(git hash-object "$TEST_FILE")" != "$EXPECTED_TEST_BLOB" ]]; then
  echo "BLOCKED: synthetic backup/restore regression differs from reviewed blob $EXPECTED_TEST_BLOB" >&2
  exit 2
fi

cat > "$LAUNCHER_DIR/pnpm" <<'PNPM'
#!/usr/bin/env bash
exec "$NODE24" "$PNPM_CLI" "$@"
PNPM
chmod 700 "$LAUNCHER_DIR/pnpm"
PATH_CLEAN="$LAUNCHER_DIR:$NODE_BIN:/usr/bin:/bin"

cat > "$WORK_ROOT/sanitize.mjs" <<'SANITIZER'
import fs from "node:fs";
import readline from "node:readline";

function scrub(value) {
  return String(value)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(x-openclaw-token|authorization|api[_-]?key|password|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1$2[REDACTED]")
    .replace(/synthetic-[A-Za-z0-9._~-]+/g, "[SYNTHETIC VALUE REDACTED]");
}

const mode = process.argv[2];
if (mode === "stream") {
  for await (const line of readline.createInterface({ input: process.stdin })) console.log(scrub(line));
} else if (mode === "report") {
  const file = process.argv[3];
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const clean = (value) => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,clean(v)]));
    return value;
  };
  const safe = clean(report);
  fs.writeFileSync(file, JSON.stringify(safe, null, 2) + "\n", { mode: 0o600 });
  const tests = safe.testResults.flatMap((file) => file.assertionResults);
  const exact = tests.filter((test) => test.fullName === "synthetic encrypted device secret backup and restore restores encrypted secret metadata and resolves the same synthetic Ed25519 identity");
  const passed = exact.length === 1 && exact[0].status === "passed"
    && safe.numTotalTests === 1 && safe.numPassedTests === 1
    && safe.numFailedTests === 0 && safe.numPendingTests === 0;
  console.log(`exact_test_matches=${exact.length}`);
  console.log(`exact_test_status=${exact.map((test) => test.status).join(",") || "missing"}`);
  console.log(`report_total=${safe.numTotalTests} passed=${safe.numPassedTests} failed=${safe.numFailedTests} pending=${safe.numPendingTests}`);
  process.exit(passed ? 0 : 1);
} else {
  console.error("Unknown sanitizer mode");
  process.exit(2);
}
SANITIZER

clean_env() {
  env -i \
    HOME="$SCRATCH/home" \
    PATH="$PATH_CLEAN" \
    TMPDIR="$SCRATCH/tmp" \
    XDG_CACHE_HOME="$SCRATCH/cache" \
    PAPERCLIP_HOME="$SCRATCH/paperclip-home" \
    NODE24="$NODE24" \
    PNPM_CLI="$PNPM_CLI" \
    PNPM_STORE="$PNPM_STORE" \
    CI=1 \
    GIT_TERMINAL_PROMPT=0 \
    "$@"
}

run_logged() {
  local log_file="$1"; shift
  local -a status
  set +e
  "$@" 2>&1 | "$NODE24" "$WORK_ROOT/sanitize.mjs" stream | tee "$log_file"
  status=( "${PIPESTATUS[@]}" )
  set -e
  if (( status[1] != 0 || status[2] != 0 )); then
    echo "BLOCKED: log sanitizer/tee failed (${status[*]})" >&2
    return 125
  fi
  return "${status[0]}"
}

run_step() {
  local name="$1"; shift
  local status=0
  if run_logged "$LOG_DIR/$name.log" "$@"; then status=0; else status=$?; fi
  if (( status != 0 )); then
    echo "BLOCKED: $name failed with status $status; later steps were not started." >&2
    exit "$status"
  fi
}

echo "candidate_base=$BASE_CANDIDATE"
echo "test_file=$TEST_FILE exact_test_blob=$EXPECTED_TEST_BLOB"
echo "node=$($NODE24 --version)"
echo "sanitized_logs=$LOG_DIR"

run_step loopback-preflight clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 10s "$NODE24" -e '
  const net=require("node:net"), server=net.createServer();
  server.once("error",e=>{console.error(`loopback unavailable: ${e.code||e.message}`);process.exit(1)});
  server.listen(0,"127.0.0.1",()=>server.close(()=>console.log("loopback listener available")));
'

run_step pnpm-version clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 30s pnpm --version
grep -Fxq "9.15.4" "$LOG_DIR/pnpm-version.log" || { echo "BLOCKED: prepared pnpm CLI did not report 9.15.4" >&2; exit 2; }
run_step frozen-install clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=15s 600s pnpm install --frozen-lockfile --offline --store-dir "$PNPM_STORE"
run_step plugin-sdk-build clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=15s 600s pnpm --filter @paperclipai/plugin-sdk build
run_step plugin-sdk-entry clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=5s 30s "$NODE24" -e '
  const fs=require("node:fs"), path=require("node:path");
  const dir=path.resolve("packages/plugins/sdk"), manifest=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));
  const entry=manifest.exports?.["."]?.import;
  if(typeof entry!=="string"||!entry.startsWith("./")||!fs.statSync(path.resolve(dir,entry)).isFile()) throw new Error("plugin SDK ESM entry artifact missing");
  console.log(`plugin_sdk_entry=present (${entry})`);
'

report="$WORK_ROOT/vitest.report.json"
test_status=0
if run_logged "$LOG_DIR/database-backup-restore.log" \
  clean_env "$TIMEOUT_BIN" --signal=TERM --kill-after=10s 150s \
  pnpm --filter @paperclipai/server exec vitest run "$TEST_FILE" \
    --reporter=json --outputFile="$report"; then
  test_status=0
else
  test_status=$?
fi

check_status=1
if [[ -s "$report" ]]; then
  if clean_env "$NODE24" "$WORK_ROOT/sanitize.mjs" report "$report" >"$LOG_DIR/database-backup-restore.report-check.log" 2>&1; then
    cp "$report" "$LOG_DIR/database-backup-restore.report.json"
    check_status=0
  else
    report_check_status=$?
    cp "$report" "$LOG_DIR/database-backup-restore.report.json"
    cat "$LOG_DIR/database-backup-restore.report-check.log"
    check_status=$report_check_status
  fi
else
  echo "report=missing" > "$LOG_DIR/database-backup-restore.report-check.log"
fi
echo "test_command_status=$test_status"
echo "exact_report_check_status=$check_status"
if (( test_status != 0 )); then exit "$test_status"; fi
if (( check_status != 0 )); then exit 1; fi
echo "PASS: one exact database-backed backup/restore test passed; no broader suite was run."
