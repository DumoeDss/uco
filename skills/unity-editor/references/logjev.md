# Optional LogJev advice

> Archived development reference (2026-09-24): the UCO Skill, installer, runtime refresh, and npm package no longer distribute or recommend this helper. Commands below describe the retained standalone experiment source; they are not instructions for a normal UCO installation. The measured native-Agent long-log comparison found no net gain over the same deterministic prefilter.

This is a `kind: chat` LogJev client, not an execution gateway. It does not call
Unity tools, change project files, start services, or install hooks.

## When to use it

Use a known tool ID, exact object path, short readable log, or clear screenshot
directly. Request advice when it replaces unresolved semantic search/triage or the
user asks for a second opinion. Preparing a model question after you already know
the answer adds work. Reuse the returned schema and original evidence; do not fetch
unchanged Unity state again just because advice was requested. Refresh when state
may have changed or the normal pre-mutation checks require it.

## Configuration and data boundary

Use only the user's chosen service/provider and data they permit sending. Loopback
may forward inputs to a cloud model. Exclude secrets and unrelated project data;
never read credential files, auto-configure a provider, or start/reconfigure services.

```powershell
$env:UCO_LOGJEV_URL = 'http://127.0.0.1:8013'
$env:UCO_LOGJEV_PROVIDER = 'deepseek'
```

Both are required; missing configuration returns `fallback/not_configured` with
no network. HTTPS is required off loopback; localhost resolves to IPv4. Optional:
`UCO_LOGJEV_MODEL`, `UCO_LOGJEV_API_KEY` (bridge Bearer key, not upstream key; environment
only), `UCO_LOGJEV_TIMEOUT_MS` (100–60000, default 10000). No redirects or retries.
Timeout does not cancel already-started upstream billing. Model versions are not
auto-pinned; recheck representative cases when service configuration changes.

Earlier development bundles installed this at `.uco/agent-runtime/scripts/logjev.mjs`.
Current init/setup-skills/update do not install or refresh it, and old copies are
left untouched. A standalone test must supply its own adjacent catalog where needed.

## Historical direct-command examples (only if an old copy exists)

```bash
node .uco/agent-runtime/scripts/logjev.mjs tools --task "Find the tool for the unresolved operation" --compact
node .uco/agent-runtime/scripts/logjev.mjs vision --image screenshot.png --check "Is an ERROR message visibly present?" --compact
node .uco/agent-runtime/scripts/logjev.mjs logs --source console.json --task "Investigate the saving failure" --compact --limit 8
node .uco/agent-runtime/scripts/logjev.mjs logs --source console.json --task "Investigate the saving failure" --compact --long-triage --limit 40 --deterministic
```

Paths are examples, not files the helper creates or permission to access them.
For noisy Console output, save an explicitly scoped UCO response without first
loading its full text into model context, then pass that file. Retyping logs you
already read does not save context. The helper does not capture or archive data.

- **tools:** reads the installed index; enabled tools only. Optional `--domain`
  narrows its existing domain. Up to two requests: group then tool, with 47 candidates
  plus none per group. Inconclusive group selection stops immediately. Top-3 ranking
  is within the selected group, not globally calibrated. The CLI attaches the exact
  locally selected `schema`, `schemaStatus`, and `schemaSource`, including nested
  definitions. Read it instead of another identical tool-info call. Missing/conflicting
  schema needs normal discovery/refresh, not guessed arguments. Snapshot metadata is
  not live permission; retain normal target/availability/confirmation checks.
- **vision:** repeat `--check` up to eight self-contained yes/no questions; q1, q2,
  etc. retain question text and include insufficient-evidence. Supply 1–2 explicit
  PNG/JPEG paths, up to 4 MiB each; order is BEFORE then AFTER. No URL fetching or
  paths inferred from model output. Ask about visible text/presence/color/position,
  not hidden causes or execution permission. Each question costs upstream input in
  this chat bridge; multiple questions are not free shared inference.
- **logs:** `--source` parses the UCO Console `structured.result.Entries` response
  (plus supported explicit aliases), deriving IDs and zero-based `sourceIndex`.
  Message, timestamp, stack and operation identifiers remain evidence. `source`
  reports original-byte SHA-256, path, entry count and dropped/truncated counts.
  Invalid UTF-8, conflicting payloads and tool failures are errors, not empty logs.
  Empty sources return full fallback. By default, over-30-entry sources also return
  full fallback without a model request. Up to 30 entries use the original per-entry
  relevance path, concurrency at most two and one total deadline. Explicit
  `--long-triage` with `--source --compact` opts into a shared deterministic lexical
  ranking and exact-content deduplication that selects
  at most `--limit` distinct candidates (default 8, maximum 40). The Jev path
  asks one `choice` question over that same pool; the bridge performs one upstream
  inference for that question. `--deterministic` requires `--long-triage` and
  returns the identical preselection with zero model requests for comparison or
  normal use. It does not need Jev configuration. Both paths include every original
  Error, Warning, Exception, Assert and Fatal entry in the compact view, even if
  it was not selected for the model pool. Normal entries outside the pool remain
  recoverable from the original-byte source path and hash. `screenedOutCount`,
  `repeatedCandidateCount`, `displayedCount` and `omittedCount` describe different
  stages; none are UCO export loss. A choice is advisory and the lexical pool has
  no recall guarantee. On missing configuration, malformed answer, timeout or
  inconclusive choice, the full parsed original is returned with fallback status.
- **compact:** tools/vision avoid repeating the request. File-backed select returns
  only the selected original candidate plus decision metadata and a recovery pointer
  (see below). Logs show the top
  `--limit` entries (default 8), all errors/warnings/unknown severities, and every
  relevance >0.1 or missing score for short logs. For long logs, D shows the shared
  candidate pool plus all severe entries; J shows the chosen original entry plus all
  severe entries. Only ordinary Log/Info entries may be omitted from either preview.
  Displayed/omitted counts and full source pointer remain; files are never changed.
  This is not a calibrated recall guarantee.
  Read original evidence if the diagnosis is uncertain. Dropped/truncated source
  entries are distinct from preview omissions. Any fallback retains the full input.

## Custom JSON and compatibility

The existing `--input file.json` interface keeps its full-original default output.
Input/source files must be regular UTF-8 JSON files of at most 1 MiB.
Do not combine it with direct `--task`, `--domain`, `--source`, or `--check` flags.
Examples for each mode:

```json
{"task":"Find a camera inspection tool","domain":"visuals"}
{"task":"Choose the scene button, not the prefab","candidates":[{"id":"scene-17","description":"Scene: Canvas/Play, Button"},{"id":"asset-42","description":"Prefab: Assets/UI/Play.prefab"}]}
{"questions":{"position":{"instructions":"Where is OPTIONS relative to image center?","criteria":{"above":"Above","below":"Below","absent":"Not visible"}}}}
{"task":"Investigate save failure","entries":[{"id":"log-1","severity":"Error","message":"Scene save failed: disk full"}]}
```

Each line is a separate input example, not one JSON document. Select accepts 1–47
unique real candidate IDs/descriptions; never invent references. Map a returned ID
to the original result and recheck before mutation. Custom vision accepts 1–8
questions, each with 1–47 labelled criteria plus automatic none; still pass explicit
`--image`. Curated logs accept 1–30 unique entry IDs and optional severity/message.
Their non-compact result retains all entries; errors sort first, then relevance.

For an unresolved choice whose candidates are already saved in that select JSON
format, run this **before reading the long file into model context**:

```bash
node .uco/agent-runtime/scripts/logjev.mjs select --input candidates.json --compact
```

On `suggested`, `candidate` is the exact selected object from the parsed file,
including its original description and extra evidence fields; `sourceIndex` is its
zero-based position. The full `original` list is omitted. `selected`, confidence,
top-three IDs/probabilities, provider/model and usage metadata remain. `source`
contains the absolute path, original-byte SHA-256, byte length, `candidatesPath`
(`candidates`) and `candidateCount`; displayed/omitted counts describe the preview.
To recover omitted evidence, read that explicit file and verify its hash first;
a changed file is not the same evidence. Paths inside candidate text are not read.
Fallback retains the full original input and source pointer. Input errors retain
parsed input when available or the explicit absolute input path, never a successful
partial selection. Without `--compact`, output is unchanged; `advise()` still keeps
the original object reference. This only changes evidence delivery, adds no requests,
and does not establish actual main-Agent token savings. Do not reconstruct a file
from candidates already read or request advice after resolving the task.

## Independent checks in one batch

Collect checks whose inputs are already available and independent, invoke one
batch, then inspect its single ordered summary. Use one `vision` job for several
questions about the same image. A job cannot consume another job's output; split
dependent work or checks spanning Unity state changes into separate stages.

```json
{"jobs":[
  {"id":"screen-a","args":["vision","--image","screen-a.png","--check","Is an ERROR message visible?"]},
  {"id":"screen-b","args":["vision","--image","screen-b.png","--check","Is the PLAY label visible?"]},
  {"id":"console","args":["logs","--source","console.json","--task","Investigate the save failure"]}
]}
```

```bash
node .uco/agent-runtime/scripts/logjev.mjs batch --input batch.json --compact --concurrency 2
```

A manifest contains 1–8 jobs with unique IDs. Each `args` array uses the existing
single-job argument parser; it is never a shell command. Nested batches and invalid
invocations are rejected before HTTP. Relative `--input`, `--source`, and `--image`
paths resolve beside the manifest. Per-job file/input errors and service failures
remain beside successful peers, in manifest order, with their IDs and recovery
paths. No failed job is retried. Inspect every job's status.

`--concurrency` accepts 1–4 (default 2). One shared HTTP queue covers every job,
including logs' internal workers and both tool-routing stages. The batch's total
`UCO_LOGJEV_TIMEOUT_MS` deadline includes preparation and queue wait; expired queue
entries are not sent. Missing or invalid configuration sends no requests. A timeout
stops client waiting, but already-started upstream work may still run or be billed.

The summary reports `hostInvocation: 1` for this helper invocation,
`bridgeRequestsDispatched`, `logicalQuestionCount` in dispatched payloads,
`peakInFlight`, `queuedExpiredCount`, reported usage, and elapsed time. Each job has
its own status, usage and `dispatch` counts. Existing per-job `requestCount` counts
advice transport attempts and can include queued requests that expired; the root
`adviceRequestAttempts` makes that distinction explicit. None of these counters
proves an upstream billing count, token saving, or fewer main-Agent turns.

Batch `--compact` applies the same successful tools/select/vision/logs views;
each select job keeps its own input-file source pointer and selected original
candidate. A job can also request `--compact` in its args independently.
The manifest source path/hash permits recovery of the job list.
Fallback and per-job errors keep their original evidence or explicit file paths;
failed output is never hidden by compact mode. The helper prints one JSON only.

Codex can already group independent calls in one execution cell, and other hosts
may offer similar orchestration. This batch interface is a portable convenience;
it does not establish an advantage over equally grouped independent calls.

## Interpreting results

`status: suggested` is validated advice, never permission. `fallback` means continue
normal UCO work with original evidence. `error` exits 2 for invalid input/invocation;
suggested/fallback exit 0, so inspect status. Choice falls back for none, confidence
<0.8, or top-two gap <0.1; any inconclusive vision judgment makes the overall result
fallback. These heuristics do not guarantee correctness or solve prompt injection.

Results include advisoryOnly, promptVersion, provider/model, requests, usage and
wall time. Usage covers successful validated responses, not billing or backend retries.
The advise() API retains original-input identity; compact is only a CLI view.
No image base64 or credentials are printed. All execution, authorization, callId,
retry, compilation-wait and task-completion checks remain in the UCO workflow.
