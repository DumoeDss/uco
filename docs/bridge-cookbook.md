# uco bridge cookbook

End-to-end recipes for driving the Unity Editor through the uco bridge
safely: identity-verified connections, waiting out compilation, provably fresh
test runs, correlation-scoped console reads, and sandboxed script execution.

Each recipe lists copy-pasteable commands, the JSON shape to expect, the exit
codes, and which calls compile, require confirmation, or can mutate scenes.
Every command and flag here is validated against the shipped CLI by
`tests/bridge-cookbook-validation.test.ts` — recipes cannot drift into
fictional flags.

Conventions:

- All examples assume `--json` (machine output; see the
  [CLI protocol reference](cli.md) for the stream contract and exit-code map).
- `--url http://localhost:PORT` overrides server discovery; drop it inside a
  Unity project directory.
- Tool arguments go through `uco call <tool> --args '<json>'`. After running
  `uco gen` against your server, most arguments are also available as typed
  flags (`uco tests-run --test-mode EditMode`).

Plugin floor: identity constraints and correlation-tagged console entries need
the `bridge-identity-v1` plugin (uco ≥ 0.74 line with this change); older
plugins reject constrained calls with `identity_unavailable` instead of
guessing — that rejection is the safety working.

---

## Recipe 1 — Connect to a chosen project and verify the Editor identity

Problem: a reachable server does not prove the right Editor is connected
(COCli-01). Multiple Editors, stale servers, and reconnecting sockets can share
a port.

```sh
# One atomic answer: server, Editor, project, version, pid, instance id.
uco wait-for-ready --json \
  --expected-project-path "D:/work/ProjectA" \
  --expected-instance-id "ProjectA@abcd1234" \
  --expected-pid 4212
```

Expected result (exit 0) — the `connection` block carries the full identity
tuple of the Editor that satisfied readiness:

```json
{
  "ok": true,
  "ready": true,
  "connection": {
    "id": "c3",
    "instanceId": "ProjectA@abcd1234",
    "identityAvailable": true,
    "projectPath": "D:\\work\\ProjectA",
    "editorPid": 4212,
    "unityVersion": "6000.5.6f1",
    "pluginGeneration": 12
  }
}
```

A pinned identity that does not match fails the wait immediately with both
tuples (exit 4, `identity_mismatch`), never after a timeout:

```json
{
  "ok": false,
  "error": {
    "code": "identity_mismatch",
    "details": {
      "expected": { "editorPid": 4212 },
      "observed": { "editorPid": 9051, "projectPath": "D:\\work\\ProjectB" }
    }
  }
}
```

Per-call pinning (recommended for writes) rides the tool-call control metadata:

```sh
uco call scene-save --args '{"scenePath":"Assets/Main.unity"}' \
  --expected-project-path "D:/work/ProjectA" \
  --expected-pid 4212 \
  --call-id save-main-1
```

A mismatched or unavailable member rejects the call **before** it is forwarded
(exit 4; `identity_mismatch` / `identity_unavailable`) — the wrong Editor never
receives the request. Paths compare case-insensitively on Windows; instance
ids and PIDs compare exactly. Never treat `ping` or port reachability as
identity.

Compile: no. Confirm: only what the tool itself requires. Mutate: no.

---

## Recipe 2 — Wait for compilation and domain reload to finish

Problem: after editing scripts or triggering an asset refresh, immediate
follow-up calls hit old assemblies or a reconnecting socket (COCli-05).

```sh
# Trigger the refresh/compile, then hold until the Editor is idle again.
uco call assets-refresh --args '{}' \
  --wait-until-idle --idle-timeout-ms 300000 --json
```

The command returns only when the Editor reports **not compiling, not
updating, not importing, not domain-reloading, and no play-mode transition**
(same stage logic as `wait-for-ready`). A timeout fails with the last blocking
stage (exit 3):

```json
{
  "ok": false,
  "error": {
    "code": "idle-wait-timeout",
    "message": "Editor did not become idle within 300.0s; last blocking stage: editor (compiling).",
    "retryable": true,
    "details": { "stage": "editor", "cause": "compiling" }
  }
}
```

For a standalone gate (CI chain entry point):

```sh
uco wait-for-ready --timeout-ms 300000 --json
```

Compile: triggers it (`assets-refresh`, any script edit). Confirm: no. Mutate:
no (an import can re-import assets but does not dirty scenes).

---

## Recipe 3 — Fresh EditMode test run, waited to its terminal state

Problem: `tests-run` is async; callers hand-rolled polling and feared cached
results (COCli-03).

```sh
# Record the console boundary first (recipe 4 uses it).
# Linux/macOS: date +%s%3N   PowerShell: [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

uco call tests-run \
  --args '{"testMode":"EditMode","testNamespace":"MyTests","includeMessages":true}' \
  --wait --wait-timeout-ms 1800000 \
  --expected-project-path "D:/work/ProjectA" \
  --json
```

`--wait` polls the durable operation to a terminal state and prints the
terminal envelope (exit 0):

```json
{
  "OperationId": "3f2c1b9e8a7d4f60b1c2d3e4f5a6b7c8",
  "Status": "succeeded",
  "Phase": "completed",
  "Execution": "fresh",
  "SourceRevision": "compile:1a2b3c4d5e6f:14",
  "CreatedAtUtc": "2026-09-08T11:00:02.1130000Z",
  "StartedAtUtc": "2026-09-08T11:00:04.9800000Z",
  "CompletedAtUtc": "2026-09-08T11:00:31.2040000Z",
  "ResultJson": "{\"Summary\":{\"Status\":\"Passed\",\"PassedTests\":11}}"
}
```

Guarantees and exit codes:

- **Every run is fresh.** `Execution` is always `"fresh"` — there is no
  filter-keyed cache; an identical filter rerun always executes a new distinct
  operation with its own `OperationId`, timestamps, and `SourceRevision`
  (domain generation + script-compilation epoch of the code it executed).
- Terminal `failed` → exit 5 (`operation-failed`, canonical envelope with the
  terminal record in `error.details`). Terminal `cancelled` → exit 6.
  Terminal `interrupted` (e.g. a reload broke the run) → exit 7. Wait timeout →
  exit 3 (`operation-wait-timeout`) reporting `operationId` + last
  `lastStatus`/`lastPhase` so polling can resume.
- Before terminal, `tests-job-get` / `editor-operation-get` report a
  structured `Blocked` cause — `compilation`, `previous-run-settling`,
  `capacity-admission`, `cancellation-pending` — with `RetryAfterMs`. Blocked
  is never a failure. Interim responses also expose `operationStatus`
  (`operationId`/`state`/`phase`) and `transportStatus: "forwarded"` at stable
  positions.

Dirty user scenes block the run (save first). Sandbox the run instead when
appropriate: add `"sandboxScene": true` to `--args` (recipe 5 semantics).

Compile: refreshes the AssetDatabase first (may compile). Confirm: no. Mutate:
EditMode tests can dirty scenes — the result reports `Mutated` and
`MutatedScenes`.

---

## Recipe 4 — Read only the console errors an operation produced

Problem: infrastructure noise and other operations' logs mixed with the
product errors you actually need (COCli-07).

```sh
# Errors emitted inside one operation's execution window since a boundary:
uco call console-get-logs \
  --args '{"operationId":"3f2c1b9e8a7d4f60b1c2d3e4f5a6b7c8","logTypeFilter":"Error","sinceUnixMs":1760000000000}' \
  --json
```

Expected result (exit 0):

```json
{
  "Entries": [
    {
      "LogType": "Error",
      "Message": "NullReferenceException in CharacterAppearance.Apply",
      "Timestamp": "2026-09-08T11:00:18.402-08:00",
      "Source": "product",
      "CorrelationId": "call-7f9e",
      "OperationId": "3f2c1b9e8a7d4f60b1c2d3e4f5a6b7c8"
    }
  ],
  "DroppedEntries": 0,
  "TruncatedEntries": 1
}
```

- Filters compose: `correlationId`, `operationId`, `source`
  (`product`|`bridge`|`tool`|`unity`), `logTypeFilter` (severity),
  `lastMinutes`/`sinceUnixMs` (time boundary), `maxEntries`. Existing filter
  names are unchanged.
- `Source` classifies the emitter: `product` (your code inside an operation
  window), `unity` (everything Unity forwards), `bridge`/`tool` (the plugin's
  own routing/tool diagnostics — kept out of the Editor Console by default;
  enable mirroring with the Editor pref
  `UnityCopilot.MirrorDiagnosticsToConsole` when diagnosing the bridge itself).
- `DroppedEntries`/`TruncatedEntries` make "no errors" distinguishable from
  "errors were lost to capacity" — an empty `Entries` with
  `DroppedEntries > 0` is not a clean bill of health.
- Threaded product logs outside the main-thread execution window keep
  `source: "unity"` with empty correlation fields (documented limitation).

Compile: no. Confirm: no. Mutate: no.

---

## Recipe 5 — Run a script in a disposable scene and verify restoration

Problem: probes dirtied scenes and leaked GameObjects into product content
(COCli-06).

```sh
uco call script-execute \
  --args '{"csharpCode":"var probe = new UnityEngine.GameObject(\"SceneProbe\"); UnityEngine.SceneManagement.SceneManager.MarkSceneDirty(UnityEngine.SceneManagement.SceneManager.GetActiveScene());","className":"Script","methodName":"Main","isMethodBody":true,"returnType":"void","sandboxScene":true}' \
  --expected-project-path "D:/work/ProjectA" \
  --json
```

Expected result (exit 0):

```json
{
  "Value": null,
  "Mutated": false,
  "MutatedScenes": [],
  "SandboxUsed": true,
  "SandboxRestored": true,
  "SandboxRestoreCause": null
}
```

- The work ran in a new untitled sandbox scene; afterwards the previous scene
  setup, active scene, selection, and dirty state were restored and the
  sandbox scene (with `SceneProbe`) is gone.
- **Without** `sandboxScene`, the same probe reports the honest outcome:

```json
{ "Value": null, "Mutated": true, "MutatedScenes": ["Assets/Main.unity"] }
```

`Mutated` is computed from observed scene state (dirty flags, active scene,
selection) around execution — not from guesses about the code. Check it before
saving: `SandboxRestored: false` (with a cause, e.g.
`sandbox-scene-close-refused`) or `Mutated: true` means the Editor is not in
the state you started from.
- Script failures surface as errors, never as success-with-payload: Roslyn
  compile failures return the diagnostics (exit 5, `tool-reported-failure`);
  a throwing method returns `TargetInvocationException` with type, message,
  and stack in `error.details`.
- `tests-run` accepts `"sandboxScene": true` with the same semantics; user
  scenes that were dirty before the call still block the run.

Compile: the script itself is compiled in-memory (no AssetDatabase compile, no
domain reload). Confirm: risky variants may require confirmation per the
authoring policy. Mutate: contained by the sandbox; reported either way.

---

## Recipe 6 — Run a long script asynchronously and resolve it after a timeout

Problem: a 60s CLI timeout fired while the script was still running; retrying
blindly would repeat side effects (COCli-09).

```sh
# Fire-and-forget: prints the accepted envelope with the call id (exit 0).
uco exec --async --file Tools/UnityValidation/LongRunningProbe.cs --json

# Resolve the actual outcome — polls the durable call record to a terminal
# state (succeeded 0 / failed 5 / cancelled 6 / still pending at the bound 3).
uco call get c-0123456789ab --wait --wait-timeout-ms 600000 --json

# Survey recent calls after an unattributed timeout.
uco call list --limit 20 --json
```

Expected acceptance (exit 0):

```json
{
  "status": "processing",
  "callId": "c-0123456789ab",
  "tool": "script-execute",
  "transportStatus": "accepted",
  "queryHint": "uco call get c-0123456789ab"
}
```

- A synchronous call that times out prints `result unknown` guidance naming the
  call id (when the caller sent one) and exits 3 — never treat it as "did not
  run"; check `uco call get` / `uco call list` before retrying.
- Records are bounded (256 entries / 30 minutes). A record reported
  `abandoned` (`server-wait-timeout`) means the server stopped waiting; a
  completion arriving afterwards flips it terminal with `lateCompletion: true`.
- Async calls are deliberately not cancellable through the bridge: closing the
  CLI does not stop the plugin-side work.

---

## script-execute compile context

What `script-execute` code compiles against, so unsupported snippets are
diagnosable before invocation:

- **Referenced assemblies**: every loaded, non-dynamic assembly of the current
  domain — the same set Editor scripts see (UnityEngine, UnityEditor, package
  assemblies, your asmdefs). Dynamic and location-less assemblies are excluded.
- **Auto-generated usings (body-only mode, `isMethodBody: true`)**:
  `System`, `System.Collections`, `System.Collections.Generic`, `System.Linq`,
  `UnityEngine`, `UnityEngine.UI` (only when the ugui assembly is loaded),
  `UnityEngine.SceneManagement`, `AIGD`, `com.AtelierAI.Unity.Copilot.Runtime.Extensions`,
  `UnityEditor`. Full-code mode (`isMethodBody: false`) gets no injected
  usings — bring your own.
- **Defines**: identical to Editor scripts — `UNITY_EDITOR` is defined and
  Editor-only APIs (`UnityEditor.EditorUtility`, …) are available directly.
  There is no define divergence to work around.
- **Lifetime**: the compiled assembly is `DynamicAssembly`, in-memory only.
  Types and statics vanish at the next domain reload — never store them in
  serialized fields or call them from later snippets after a reload; reference
  data through assets or serialized values instead.

---

## Quick reference: what each call does

| Call | Compiles | Needs confirmation | Can mutate scenes |
| ---- | -------- | ------------------ | ----------------- |
| `wait-for-ready` | no | no | no |
| `ping` | no | no | no |
| `assets-refresh` | triggers compile/import | no | no |
| `tests-run` | refreshes first (may compile) | no | yes (report `Mutated`; sandboxable) |
| `script-execute` | in-memory Roslyn only | possibly (policy) | yes (report `Mutated`; sandboxable) |
| `scene-save` | no | yes (authoring policy) | persists (check `Mutated` first) |
| `console-get-logs` | no | no | no |
