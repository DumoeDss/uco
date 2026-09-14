# uco architecture

This document describes the current checked-in implementation. The official Unity CLI behavior was locally verified against `1.0.0-beta.3`; it remains beta, so live help is the command-syntax authority.

## 1. Topology and ownership domains

```text
AI agent
  |
  | shell: uco <command>
  v
+-----------------------------------------------------------+
| uco (185 functional top-level commands)                 |
|                                                           |
|  6 shortcuts   16 active dev-ops   163 generated tools   |
+---------------+---------------------+---------------------+
                |                     |
       lifecycle/build/test           | runtime automation
                |                     |
                v                     v
        official `unity` CLI    plain REST tool server
          or lifecycle Hub       POST /api/tools/{name}
             fallback                    |
                                        | raw WebSocket RPC
                                        v
                                  Unity Editor plugin
```

Commander adds a `help` pseudo-command, so `uco --help` displays 186 command entries. Architecture counts use **185 functional commands** and exclude that pseudo-command.

There are four intentionally complementary domains:

1. Raw official `unity` owns the complete management/auth/license/config/Pipeline surface.
2. uco lifecycle wrappers (`editors`, `install-unity`, `create-project`) use one official-first lifecycle session with an absence-only Hub transition fallback.
3. uco `build` and top-level `test` issue one official CLI operation and never enter Hub routing.
4. uco runtime shortcuts/generated commands control an already-running Editor/server through REST. No MCP protocol or tool schema is registered on this agent-to-uco-to-server path.

The existing `open` command remains uco-owned because it injects the project's connection environment and handles the Unity launch-errors dialog. It waits for the Editor child process to emit `spawn`; the separate `wait-for-ready` command owns staged process/HTTP/WebSocket/handshake/capability/Editor/probe readiness.

## 2. REST runtime boundary

The runtime transport depends on these stable endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/system-tools/ping` | liveness |
| `GET` | `/api/tools` | live tool schemas |
| `POST` | `/api/tools/{name}` | invoke a generated/runtime tool |
| `POST` | `/api/system-tools/{name}` | internal/system operation |

`src/transport/index.ts` defines the transport interface and `src/transport/rest.ts` implements fetch, bearer auth, response decoding, and REST error classification. Runtime commands receive transport through `runCommand`; they do not reach into fetch directly.

The tool server is the Node.js uco server (`uco/src/server/`, shipped compiled in the package): REST on the agent side, a raw-WebSocket bridge to the Unity plugin on the Editor side. Claude Desktop/Cursor-style MCP clients cannot be inferred to work from the server name. Raw official `unity mcp`/Pipeline capabilities are a separate official domain.

## 3. Connection resolution and root globals

Runtime URL resolution is:

1. root `--url`;
2. `UserSettings/AI-Game-Developer-Config.json` under root `--project`/cwd;
3. deterministic port derived from the canonical project path.

Root options are registered on the root Commander program. The raw-argv ownership helper preserves supported globals before or after active build/test subcommands, including compact short forms and suffix `--json`. Root `--timeout <ms>` remains a REST request setting even when parsed beside an official batch command; it never becomes the official process wall clock.

## 4. Command surface conventions

### 4.1 Inventory

The current source-derived inventory is:

| Layer | Count | Source |
|---|---:|---|
| uco shortcuts | 6 | registrations in `src/index.ts` |
| active dev-ops | 16 | registrations in `src/commands/devops/index.ts` |
| generated tools | 163 | `src/generated/tools.json` and `GENERATED_TOOL_NAMES` |
| functional total | **185** | sum; excludes Commander `help` |

The 163 generated commands are a controlled g-006 release snapshot, not a timeless upstream total. `uco gen` re-fetches `GET /api/tools` and rewrites the generated snapshot/source; generated files are never hand-edited.

### 4.2 Shortcuts

`ping`, `list`, `call`, `exec`, `gen`, and `install` live under `src/commands/`. They provide the small stable interface for liveness, discovery, an arbitrary-tool escape hatch, Roslyn execution, schema regeneration, and one-shot project toolchain setup.

### 4.3 Active dev-ops

The active registrar barrel registers:

`install-plugin`, `remove-plugin`, `configure`, `setup-mcp`, `open`, `close`, `wait-for-ready`, `status`, `setup-skills`, `setup-unity-cli`, `install-unity`, `create-project`, `editors`, `build`, `test`, and `login`.

`src/devops/commands-upstream/` is an inactive reference copy. It is not a second registrar tree and must not be edited to change current command behavior or documentation.

### 4.4 Onboarding mutation seams

Machine onboarding and project onboarding are deliberately separate deep modules:

- `setupUnityCli()` is the only uco path that acquires Unity's installer. npm lifecycle and first-use discovery stay non-mutating. The trust boundary is explicit default-no consent plus the exact HTTPS Unity CDN origin. Redirects are manual and bounded, with every hop checked before request. Vendor execution receives only allowlisted path/system/home/temp/locale/architecture/certificate/proxy values plus `UNITY_CLI_CHANNEL=beta`; token/secret variables are excluded and known secrets are redacted from diagnostics. Byte/time/output/process-tree bounds and uco temp cleanup surround execution. `--dry-run` stops before prompt, network, temp files, or process launch.
- `installPlugin()` is the lightweight post-create package seam. It preserves non-semver sources during automatic resolution, never downgrades a semantic version automatically, and atomically replaces only `Packages/manifest.json` when semantic changes exist.

`create-project` calls the second seam only after lifecycle creation succeeds. A package failure preserves the created project and returns a typed retry command; it never invokes another lifecycle backend. This lightweight package entry is not the same as top-level `uco install`, which separately stages NuGet and configuration payloads.

### 4.5 Generated tools

`src/generated/tools.ts` registers each tool as a flat top-level command. JSON Schema properties become required/optional Commander options, with coercers for primitives, enums, `Vector3`, `GameObjectRef`, and nested JSON. Disabled tools remain registered for discovery; the running server enforces project/session gating.

### 4.6 Three-surface progressive Skill bundle

`setup-skills` no longer asks Unity's legacy file generator to create one Skill per tool. It reads the live `/api/tools` catalog and passes it to `src/skills/bundle.ts`, which owns classification, rendering, ownership, staging, validation, publication, and optional legacy migration.

The installed topology has exactly three mutually exclusive discoverable entries: `uco-setup` for integration/bootstrap/repair, `unity-cli` for the official raw CLI and process lifecycle, and `unity-editor` for operations through a ready running Editor. This prevents setup rules, beta CLI syntax, and 163 release REST tools from competing under one broad trigger.

Six first-level domain references belong only to `unity-editor`. Exact input/output schemas remain lossless under the non-discoverable `.cocli/agent-runtime/catalog/tools.json` and are surfaced one tool at a time through its `scripts/tool-info.mjs`; they never enter YAML metadata or a default Skill body. The shared project wrapper pins both the project and current uco entry without registering tool schemas in the agent session.

Invariants:

- each live tool appears exactly once in the domain index;
- unknown prefixes remain reachable under diagnostics and emit a warning;
- generated text is deterministic UTF-8 without BOM;
- every generated Skill directory contains exactly one `SKILL.md`, while the shared runtime contains none;
- ownership manifests are written with all four staged outputs;
- unmanaged destinations and extra user files are never replaced;
- a managed v1 `unity-copilot` bundle is migrated automatically with rollback protection;
- optional legacy cleanup removes only a known tool/system name whose directory contains exactly one recognizable generated `SKILL.md`;
- positional project selection is applied before REST transport construction.

## 5. Official integration module map

| Module | Responsibility |
|---|---|
| `src/devops/utils/unity-cli.ts` | official executable discovery/binding, bounded subprocess execution, UTF-8/output/envelope parsing, error classification, argument normalization, process-tree cancellation, signing redaction |
| `src/devops/lib/setup-unity-cli.ts` | explicit consent, fixed official installer metadata, bounded acquisition, private temp ownership, no-shell execution, cleanup and post-install verification |
| `src/commands/devops/setup-unity-cli.ts` | `--yes`/`--dry-run`, JSON purity, progress and signal ownership |
| `src/devops/lib/unity-lifecycle.ts` | one sticky lifecycle backend selection, official/Hub adapters, absence-only fallback, diagnostics |
| `src/commands/devops/editors.ts` | normalized installed/release inventory and optional routing diagnostics |
| `src/commands/devops/install-unity.ts` | project/version precedence, official modifiers, Hub compatibility rejection, JSON-safe progress |
| `src/commands/devops/create-project.ts` | official-first create, default lightweight package bootstrap, opt-out/version controls, and retained-project partial-failure reporting |
| `src/devops/utils/manifest.ts` | canonical package identity, semantic no-op inspection, registry merge and same-directory atomic manifest replacement |
| `src/commands/devops/_unity-command-line.ts` | option-aware raw argv ownership, suffix globals, compact shorts, literal delimiter/opaque-value preservation |
| `src/commands/devops/_unity-operations.ts` | pure build/test validation, project resolution, adapter request mapping, timeout and abort ownership |
| `src/commands/devops/build.ts` | active build Commander registration and output/error boundary |
| `src/commands/devops/test.ts` | active top-level batch test registration and literal-`--` Editor tail |
| `src/devops/utils/unity-hub.ts` | retained transition fallback and legacy Hub-compatible helpers; not used by build/test |

The official wrapper exposes data operations, not a general shell. Lifecycle creates a bound client immediately after selection; later environment/PATH changes cannot swap the executable between inventory and mutation.

## 6. Lifecycle routing contract

`COCLI_USE_UNITY_CLI` is parsed before lifecycle work:

| Value | Meaning |
|---|---|
| unset/empty/`auto` | bind a discoverable official CLI, else select Hub before the operation |
| `1` | official required |
| `0` | Hub forced |
| other | configuration error before either backend |

A non-empty `UNITY_CLI_PATH` is authoritative. Under auto/required policy an invalid override produces a path-specific official-required failure—no secondary PATH search and no Hub fallback. Selection is sticky across diagnostics, inventory, and mutation.

Automatic fallback is strictly **absence-only**. Once an official process starts, spawn failure, timeout, cancellation, output/envelope/data error, or official command failure is returned; it is not retried through Hub because mutation may already be partial. Official-only lifecycle options are rejected before any selected Hub lookup/mutation instead of being silently ignored.

Hub inventory has two compatibility modes. Lifecycle sessions select strict inventory and, for JSON output, a silent injected sink throughout the deep Hub call graph. Direct legacy callers retain their older lenient/human defaults. Global stream interception is intentionally not used.

`editors --diagnostics` exposes policy, selection reason, override/discovery path, bound path/version, and fallback state. There is no uco `doctor` command.

## 7. Official build/test contract

Build and top-level test call the official wrapper directly. They do not import the lifecycle selector, perform a separate discovery preflight, or call Hub—even when `COCLI_USE_UNITY_CLI=0`.

Project resolution is positional `[project]`, then root `--project`, then cwd. Only the selected project is made absolute. Output, log, report, and editor paths are forwarded unchanged so relative paths keep official semantics.

### Build

- `--target` and `--execute-method` are semantically required before adapter work.
- `--args` owns exactly one opaque value; option-looking contents stay data.
- a non-empty post-literal-`--` tail is rejected;
- wrapper-owned `--json`, `--non-interactive`, and `--no-tail` are normalized to one pre-delimiter occurrence;
- live official build-log tailing is always disabled, including when the compatibility `--no-tail` flag is omitted.

### Test

- command-local `--timeout <seconds>` appears after `test`, is distinct from root REST milliseconds, and is capped at 2,147,183 seconds;
- raw Editor arguments are accepted only after the first literal `--` and are preserved verbatim, including option-looking `--json`/`--format` tokens;
- the wrapper normalizes only its pre-delimiter segment.

The generic official subprocess ceiling is Node-safe `2,147,483,647 ms`. Wrapper operation bounds are install 30 minutes, create 15 minutes, build 2 hours, and test at least 2 hours or requested seconds plus 5 minutes. Operation-scoped signal listeners are removed in `finally`.

## 8. Durable operations, scheduling, and cancellation

Build, tests, asset refresh, menu execution, and explicitly asynchronous screenshot work return one project-local durable operation handle before owned side effects begin. Generic `editor-operation-{get,list,cancel}` and compatibility build/test wrappers project the same Unity record; Node pending state is correlation only and is never an operation database.

Every Unity tool enters one per-Editor admission scheduler after authoring policy approval and before confirmation consumption/path re-resolution/transaction start. Missing metadata means `main-thread` serialized. Only a pure read with explicit `executionAffinity=background|either` and `threadSafeRead=true` may use the bounded read lane; `readOnlyHint` alone never grants parallel execution. Operation observation reads remain available while a blocking side-effect lane is active.

Cancellation has three distinct meanings:

1. abort before WebSocket dispatch sends nothing;
2. abort of an in-flight immediate call sends at most one advertised same-generation `CancelToolCall` request and removes only the local pending waiter;
3. durable operation cancellation is an explicit operation-ID tool call routed to the registered Unity owner.

Timeout, disconnect, and local abort never fabricate a terminal durable state. Side-effecting calls and cancellation requests have zero automatic retries; the readiness loop performs new bounded read probes instead of silently replaying a prior call.

## 9. Output, JSON, and error boundaries

Runtime commands use the common uco output and exit-code mapping. Official-backed lifecycle/build/test commands follow the same user-facing principle with a stricter delegated contract:

- the official outer `{success, command, data, errors, warnings}` envelope is validated internally;
- success returns the envelope's opaque `data` value directly;
- root `--json` produces exactly one JSON stdout value;
- structured failure is emitted on stderr with non-zero exit and no partial success stdout;
- human lifecycle hints/progress use JSON-aware output injection, so Hub fallback cannot contaminate JSON stdout;
- build never streams a live log tail into stdout.

Formatting normalization is option/value-aware. It removes/deduplicates wrapper-owned pre-delimiter formatting flags without deleting option-looking values. The test delimiter stops normalization.

Known values owned by `--android-keystore-base64`, `--android-keystore-password`, and `--android-key-alias-password` are redacted from attempted argv, retained stdout/stderr, official errors/warnings, and the selected message. Build `--args` and test Editor tails are deliberately opaque, so arbitrary embedded secrets cannot be promised redaction.

The wrapper decodes UTF-8 safely, bounds retained output, classifies timeout/abort/spawn/envelope/data/command failures, and terminates its owned process tree with bounded settlement. It cannot undo Unity artifacts already written before cancellation.

## 10. Open and readiness ownership

`openProject` remains a direct Editor launch, not an alias for official `unity open`. It:

1. resolves the requested/project/highest installed editor through the selected lifecycle inventory;
2. injects connection environment unless `--no-connect` is set;
3. starts Unity and runs the launch-error dialog handling loop;
4. resolves after the child process emits `spawn`.

REST availability can lag spawn through first import/domain reload. `wait-for-ready` owns a bounded staged poll: Node process/listener and authenticated HTTP remain local; eligible routing additionally requires WebSocket, compatible handshake, prompts/resources/tools registration, the canonical Editor/scheduler readiness snapshot, and a fresh read-only probe. Transitional `settling`, `compiling`, `importing`, `playmode-transition`, `building`, and `busy` states are retryable observations rather than transport success. Deadlines and intervals remain in milliseconds. Runtime workflows compose them explicitly:

```bash
uco open <project> && uco wait-for-ready <project>
```

## 11. Verification map

| Suite | Contract |
|---|---|
| `tests/unity-cli.test.ts` | discovery/binding, JSON envelope/data, UTF-8/output bounds, normalization, timeout/abort/process tree, redaction |
| `tests/unity-lifecycle.test.ts` | sticky official-first selection, authoritative override, absence-only fallback, mappings/diagnostics |
| `tests/unity-hub-lifecycle.test.ts` | strict/silent Hub inventory and JSON-safe fallback behavior |
| `tests/lifecycle-commands.test.ts` | lifecycle Commander mappings, option compatibility, JSON/error output |
| `tests/unity-editor-lifecycle.test.ts` | editor lifecycle behavior |
| `tests/open-lifecycle-regression.test.ts` | direct-open spawn boundary, launch handling, separate readiness registration |
| `tests/build-test-commands.test.ts` | build/test validation, argv ownership, project/path/timeouts, cancellation, redaction |
| `tests/build-test-cli-smoke.test.ts` | built help and safe missing-executable/CLI grammar behavior |

These suites use injected/fake processes and safe unavailable-executable smokes. Passing them does not claim that a real editor was installed/opened or that a real Unity project was built/tested.

## 12. Repository ownership

```text
uco/
├── bin/cocli.mjs
├── src/
│   ├── index.ts
│   ├── commands/
│   │   ├── {ping,list,call,exec,gen,install}.ts
│   │   └── devops/                 # 16 active registrations
│   ├── generated/                  # refreshable; hand-edit forbidden
│   ├── transport/                  # REST runtime seam
│   └── devops/
│       ├── lib/unity-lifecycle.ts
│       ├── utils/{unity-cli,unity-hub}.ts
│       └── commands-upstream/      # inactive reference only
├── tests/
├── skills/
│   ├── uco-setup/            # integration, bootstrap, repair
│   ├── unity-cli/              # official CLI and process workflows
│   └── unity-editor/           # live Editor map + domain references
├── docs/architecture.md
└── CHANGELOG.md
```

`dist/` is generated by TypeScript build and is not an authored documentation target. `Unity-MCP/cli/CHANGELOG.md` elsewhere in the repository is vendored upstream history, not uco's changelog.

## 13. Refreshing and future migration

- Server schema changed: run `uco gen --project <project>`, review regenerated `src/generated/{tools.json,tools.ts}`, rebuild, and update every snapshot count together.
- Official beta changed: compare live raw `unity <command> --help`, uco built help, wrapper tests, and the root direct-official skill.
- Lifecycle behavior changed: update lifecycle tests, README, packaged skill, this guide, integration outcome record, and changelog together.
- Hub removal is deferred future work. Do not delete or describe it as deleted without a separate reviewed change and an explicit hard-dependency decision.
