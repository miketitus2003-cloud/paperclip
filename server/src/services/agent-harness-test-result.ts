import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "@paperclipai/shared";

export function assertHarnessTestPassed(result: AdapterEnvironmentTestResult) {
  const verified = result.checks.some(check => check.level === "info" && (
    /hello_probe_(passed|succeeded)$/.test(check.code)
    || check.code === "ai_connection_api_key_reverified"
    || check.code === "copilot_metadata_verified"
    || (result.adapterType === "openclaw_gateway" && check.code === "openclaw_gateway_probe_ok")
  ));
  const authenticationFailed = result.checks.some(check =>
    check.code === ADAPTER_AUTH_MISSING_CHECK_CODE || check.code === "COPILOT_AUTH_REQUIRED" || /_hello_probe_auth_required$/.test(check.code));
  const incomplete = !verified && (result.status === "warn" || result.checks.some(check => check.code.includes("hello_probe")));
  if (result.status === "fail" || authenticationFailed || incomplete) {
    const has = (suffix: string) => result.checks.some(check => check.code.endsWith(suffix));
    const code = result.checks.some(check => check.level === "error" && check.retryable === true) ? "test_environment_unavailable"
      : authenticationFailed ? "harness_auth_failed"
      : has("_hello_probe_model_unavailable") || has("_model_invalid") ? "harness_model_unavailable"
      : has("_command_unresolvable") ? "harness_command_unavailable"
      : has("_cwd_invalid") ? "harness_cwd_invalid"
      : has("_hello_probe_timed_out") ? "harness_probe_timed_out"
      : has("_hello_probe_unexpected_output") ? "harness_probe_unexpected_output"
      : "harness_test_failed";
    throw Object.assign(new Error("The harness test failed"), { code });
  }
}
