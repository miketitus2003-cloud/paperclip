# Runner launch preparation

Core selects the provider, model, instructions, tools, and task permissions.
The execution environment supplies executable paths and filesystem locations.

The built-in TypeScript implementation constructs the provider descriptor in
`createRunnerProviderLaunch`. The transport sends this descriptor with
`run.prepare`. Provider backends keep their existing validation and session rules.

By default, the SDK prepares local files. It stages remote files through the
existing execution driver.

## Environment-owned preparation

An execution driver can supply `prepareLaunch`.
The callback receives `RunnerProviderLaunchRequirements`.
It returns `PreparedRunnerProviderLaunch`.

Requirements contain the selected provider, model, policy, run identity, and
runtime context. They do not contain task text, process callbacks, provider
credentials, or controller executable choices. Resource paths identify source
locations. They do not grant filesystem access on the execution host.

The environment resolves its resources and prepares the provider descriptor.
It can use `bindRunnerLaunchResources` to replace registered context locations.
It can use `createRunnerProviderLaunch` for the existing descriptor projection.
The transport does not perform its built-in file preparation in this mode.
The process owner supplies the Runner artifact and process lifecycle.

The result contains a configuration ID, a requirements digest, and a provider
descriptor. The transport checks Core's selected profile and policy before
registration and launch. Core still supplies authorized tools and completion
criteria through PRP. A failed preparation does not enable a fallback launch.

### Codex probe policy

Core can select `settings.disableCodexProjectInstructions` for a hello probe.
Preparation must preserve it as `project_doc_max_bytes=0` before `app-server`,
after any environment-supplied overrides. Core validates this setting alongside
`disableCodexWebSearch`. Ordinary tasks retain project instructions when the
setting is absent or false. This does not change the selected filesystem policy.

### Working directory

In this mode the environment chooses the provider working directory. Core does
not supply one. The backend uses `workingDirectoryAuthority:
"runner_prepared_launch"`, and its controller environment stays empty.

- Core authorizes the agent, task, projects, and workspace binding.
- The environment resolves that assignment into mounts and the descriptor's
  `cwd`. For a projectless task it selects its own default directory.
- The transport accepts only a normalized absolute `cwd` that is not a
  filesystem root. Runnerd validates the directory on its own filesystem.
- The transport reports that `cwd` to the driver. The driver records it in
  session context, snapshots, and recovery, and ignores the caller's directory.
- Recovery and run attachment must keep the same `cwd`. A runner snapshot or
  recovered thread that reports another directory fails recovery. Core does not
  substitute a controller-local or temporary directory.

`remote_runner` remains the mode in which Core assigns the remote directory
through `PAPERCLIP_WORKSPACE_CWD`.

The transport saves the exact requirements and prepared configuration in its
private `launch-preparation.json` file. The file holds at most two records.
A new attachment keeps the active run's record. Runner commands contain the
provider descriptor once. They do not contain these recovery records.

Recovery within the same run must return the same configuration. This rule also
applies during an interrupted warm attachment. A new run uses its current
requirements. For a new run, `runtimeContext: null` removes the assigned context.
Only an omitted context can reuse the previous context.
Provider session compatibility checks remain in their existing
backends. Close waits for preparation within its deadline. A timeout retains an
unsettled checkpoint and prevents reuse.

## Plugin task protocol

The [environment task API](plugins/PLUGIN_ENVIRONMENT_TASKS.md#launch-preparation)
defines the plugin preparation exchange. The [native plugin integration](plugins/PLUGIN_RUNNER_EXECUTION.md)
connects the callback to task execution. A Launcher implementation remains the
execution owner's responsibility.

### Bounded retained task admission

Core sends `lease.metadata.runnerTaskAdmissionSupported: 1` as a transient host
capability. A plugin can return `admissionSnapshotVersion: 1` in a description
only when this flag is present and the plugin supports the admission contract.
An older host receives the original description shape. An older plugin ignores
the flag and keeps its existing preparation path.

For a proven retained Codex or Claude task, Core can reserve one admission with
a 30-second deadline. The deadline starts before the reservation queries. It
covers task preparation, project authentication, provider attachment, and the
authenticated Runner connection. It is not restarted by each RPC. Fresh setup,
probes, recovery, and other providers keep their existing budgets.

The reservation uses the existing native run coordinator. Short transactions
record its owner, expiry, and completion. The transaction acquires coordinator
and run locks before non-waiting agent and plugin locks. A separate read captures
fresh policy and runtime revision after those locks. Core does not hold a
transaction across plugin or provider network calls. This also supports a
transaction-pooled runtime database connection.

An accepted admission retains its ready lifecycle version, runtime revision,
agent status, and selected computer binding for this interval. Core-managed
agent configuration and Launcher-binding mutations wait for the reservation.
A Pause records its intent immediately and blocks new admissions. An admitted
startup can finish or fail before the existing cancellation and lifecycle
cleanup continue. A direct run Stop remains a cancellation operation.

The plugin receives an opaque admission ID and its fixed deadline in transient
lease metadata. Core binds the actual permit to the worker invocation. An ID
copied from another request, persisted metadata, or a previous Core process
does not grant admission. The snapshot remains private to the attempt and ends
on completion, failure, or expiry. The plugin must stop new requests at expiry
and combine the deadline with each outbound request timeout.

Expiry does not prove that the provider or a pending resource transaction has
stopped. Lifecycle changes still require the existing Stop and termination
confirmation before changing the VM or its binding. An already accepted
resource transaction can finish after its client disconnects. Operator plugin
restart, upgrade, uninstall, and out-of-band VM administration remain explicit
interruptions.

`run.attach` can initialize a provider process before task inference starts.
Core publishes the session and checks current run cancellation before it sends
`turn.start`. A late startup handle is cancelled when Stop or the admission
deadline has already won. Starting a provider process alone is not evidence of
a model request or token usage.

## Managed Git helper interpreter

`githubLauncherSource({ interpreterPath })` can select an absolute Node interpreter
owned by the execution environment. Without this option, generated helpers retain
`#!/usr/bin/env node`. The option changes only the shebang; it does not change PATH,
command discovery, credential handling, or helper behavior. Interpreter paths must
be absolute and contain no whitespace or NUL bytes.
