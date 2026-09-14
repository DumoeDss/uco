# uco CLI protocol reference

This page documents the machine-facing contract of the `uco` CLI: the
`--json` stream layout, the canonical error envelope, and the exit-code map.
The [bridge cookbook](bridge-cookbook.md) shows the same contract end-to-end.

## JSON mode stream layout

With `--json`:

- **stdout** carries at most one JSON document — the success result. On any
  failure stdout contains **no bytes**.
- **stderr** carries all diagnostics: the canonical error object (one JSON
  document), and info messages in pretty mode.
- The human-mode `Retry:` hint is a pretty-mode stderr convenience; it never
  appears on stdout in any mode.

This is a tested contract (see `tests/cli-json-protocol.test.ts`): success,
transport failure, confirmation-required, tool-reported failure, and help
output all assert one-or-zero stdout documents and one-or-zero stderr error
objects.

## Canonical error envelope

Every JSON-mode failure is:

```json
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "message": "…",
    "retryable": false,
    "requestId": "t-42",
    "details": {
      "retryWith": {
        "requestID": "t-42",
        "control": { "version": 1, "callId": "…", "confirm": true, "confirmation": { … } }
      }
    }
  }
}
```

- `error.code`, `error.message`, and `error.retryable` are always present.
  Optional members differ per source but the shape is uniform.
- When a failure is confirmation-retryable, `error.requestId` and
  `error.details.retryWith` (with `requestID` and the `control` payload accepted
  by `--request-id` / `--control`, or the `--confirm` / `--confirmation`
  shorthand) are always present, redaction-bounded, and size-capped. A wrapper
  resumes the operation by re-invoking the same command with those two values —
  no human-text parsing.
- Non-retryable failures set `retryable: false` and omit `retryWith`.

## Exit-code map

Every uco command conforms to this map:

| Code | Meaning | Sources |
| ---- | ------- | ------- |
| 0 | Success | command succeeded; tool payload reported success; `--wait` reached terminal `succeeded` |
| 1 | Unexpected error | internal errors; local usage/validation errors (e.g. malformed `--control` JSON) |
| 2 | Connection refused | transport could not connect (server not running) |
| 3 | Timeout | transport timeout; `wait-for-ready` timeout; `--wait` / `--wait-until-idle` timeout; controlled-call `deadline_exceeded` |
| 4 | HTTP-level server rejection | the server rejected the call: `confirmation_required`, `invalid_control`, `identity_mismatch`, `identity_unavailable`, `editor_not_ready`, `operation_capacity_exceeded`, `middleware_rejected`, `authoring_transaction_failed`, … |
| 5 | Tool-reported failure | tool payload reported failure (`ok`/`Ok` false, `isError` true, failure-vocabulary `status`, wrapper-position `error`); `--wait` reached terminal `failed` |
| 6 | Cancelled | controlled call cancelled by the caller; `--wait` reached terminal `cancelled` |
| 7 | Interrupted | `--wait` reached terminal `interrupted` (e.g. domain reload broke the operation) |

Note for scripts upgrading from older uco versions: codes 6 and 7 are new
distinct codes — cancelled and interrupted calls previously exited 1. Detected
inner failures (`ok=false` inside a forwarded payload) previously exited 0 in
some shapes and now exit 5; scripts that read success from those payloads were
reading a bug.

## Post-call idle gate

Mutating tool commands (`call`, `exec`, and every generated tool command)
accept:

- `--wait-until-idle` — after the tool call returns, poll the readiness stages
  and the read-only editor probe until the Editor reports **not compiling, not
  updating, not importing, not domain-reloading, and no play-mode transition**,
  then print the result. Reuses the same stage logic as `uco wait-for-ready`.
- `--idle-timeout-ms <ms>` — bound for the idle wait (default 120000). On
  timeout the command fails with `idle-wait-timeout` (exit 3) naming the last
  blocking stage and cause.

## Durable-operation terminal wait

Tool commands that return a durable operation handle (e.g. `tests-run`,
`build-player`) accept:

- `--wait` — poll the operation's authoritative record until a terminal status.
- `--wait-timeout-ms <ms>` — bound for the wait (default 600000). On timeout
  the command exits 3 (`operation-wait-timeout`) reporting the operation id and
  the last observed status/phase so polling can resume.

Terminal states map onto the exit-code table above (`succeeded` → 0, `failed`
→ 5, `cancelled` → 6, `interrupted` → 7). A response that already carries a
terminal status maps directly; a response with no durable handle prints with a
polling hint (exit 0) instead of failing — the tool call itself succeeded, the
wait protocol just does not apply to it.

## Async calls and the durable call record

Every forwarded tool call creates a bounded server-side call record. An
observed transport timeout never means the tool did not run — the CLI timeout
envelope states `resultUnknown: true` and names the call id when the caller
sent one; resolve the actual outcome with:

- `uco call get <callId>` — fetch one record; `--wait`/`--wait-timeout-ms`
  poll it to a terminal state (succeeded → 0, failed → 5, cancelled → 6,
  still non-terminal at the bound → 3 `call-wait-timeout`).
- `uco call list [--limit N] [--state <s>]` — recent records, newest first.

Records are process-local and bounded (256 entries / 30 minutes). States:
`pending`, `processing`, `succeeded`, `failed`, `cancelled`, `abandoned`. A
record is `abandoned` (`server-wait-timeout` or `caller-disconnect`) when the
server stopped waiting; a completion that arrives afterwards still flips it
terminal with `lateCompletion: true`.

`uco exec --async` dispatches fire-and-forget: the server answers
`202 {status:"processing", callId, requestId, queryHint}` once the call was
sent to the plugin, and the forward continues updating the record in the
background. The HTTP request is intentionally not linked to the plugin call —
closing the connection does not cancel it — so an async call cannot be
cancelled through the bridge; track it with `call get --wait`. (The opposite
holds for synchronous calls: when the CLI times out and closes the connection,
plugins that advertise `cancel-tool-call-v1` receive an active cancellation.)

A tool literally named `get` or `list` is unreachable via `uco call <tool>`;
invoke it through its generated command instead.

## Retryability

A tool-level failure (the tool decided the call is invalid — compile errors,
unsaved-scene preconditions, filter mismatches) is reported `retryable: false`
with the tool's message; retrying cannot change the outcome. Only genuine
forwarding/bridge failures (no eligible connection, transport hiccups) are
`retryable: true`.

## Identity constraints

`call`, `exec`, generated tool commands, and `wait-for-ready` accept:

- `--expected-project-path <path>` — fail closed unless the routed Editor
  reports this project path (case-insensitive on Windows).
- `--expected-instance-id <id>` — fail closed unless the routed Editor reports
  this stable instance id (exact).
- `--expected-pid <pid>` — fail closed unless the routed Editor runs under this
  process id (exact; the Editor process, never the Node server process).

A mismatch or an unavailable member rejects the call before it is forwarded
(exit 4, `identity_mismatch` / `identity_unavailable`) with the expected and
observed tuples in `error.details`.

A success response carries `servedBy` — the identity tuple (`instanceId`,
`projectPath`, `editorPid`, `unityVersion`, `generation`) of the Editor
connection that actually served it — whenever the serving connection reported
any identity member (i.e. the plugin advertised `bridge-identity-v1`). Older
plugins that do not report identity echo nothing.
