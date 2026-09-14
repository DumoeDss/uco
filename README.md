# uco — Unity Co-Pilot CLI

Drive the Unity Editor from any AI agent. Agents run plain shell commands; uco does the rest.

## Quick start

```bash
npm install -g @atelierai/uco           # 1. install the CLI (Node.js 20+)
uco init                     # 2. bootstrap agent Skills in your project (pick your agent)
uco install <your-project>   # 3. embed the Unity plugin + everything it needs
```

Then open your AI agent in that project and just ask: *"list the scenes"*,
*"add a cube at origin"*, *"run the EditMode tests"*. Open the project in
Unity once so the plugin starts; after that everything works from the chat.

Requires Unity 2022.3+ (tested on 2022.3 LTS and 6000.5) and Node.js 20+.
Supported agents: `uco init --list` (Claude Code, Codex, Cursor, ...).

## What you can do

- **Build & edit in chat** — scenes, GameObjects, components, prefabs,
  assets, materials, shaders
- **Write & run code** — read/patch scripts; compile-and-execute C#
  (Roslyn), with confirmation gating on risky operations
- **See the result** — scene/game/camera screenshots fed back to the agent
- **Quality gates** — EditMode/PlayMode tests and player builds from the chat
- **Diagnose** — console logs, editor state, package management
- **Editor lifecycle** — install Unity editors, create/open projects via
  wrappers over the official `unity` CLI

165+ tools in total; `uco list` shows everything your Editor exposes.

## How it works

```
AI agent  →  uco (shell)  →  REST /api/tools/*  →  Node server  →  WebSocket  →  Unity plugin
```

The agent surface stays small and discoverable — no MCP protocol or tool
schemas enter the agent session; `uco --help` (and per-command help) expose
typed options and JSON output. Editor/project lifecycle (installs, create,
build, test) is handled by wrappers over the official `unity` CLI.

See [the architecture guide](docs/architecture.md) and the packaged Skills for
[project setup](skills/uco-setup/SKILL.md), the [official Unity
CLI](skills/unity-cli/SKILL.md), and the [running Unity
Editor](skills/unity-editor/SKILL.md).

## Status

The official Unity CLI integration is implemented and locally verified against the `1.0.0-beta.3` contract. The official CLI is still beta, so check `unity <command> --help` and `uco <command> --help` when exact flags matter. Unity Hub remains an absence-only fallback for lifecycle commands; build and test are official-CLI-only.

## Install from an offline bundle (distributing to others)

uco installs from npm in one line; it also ships as a single self-contained `.tgz` that carries the CLI, its npm dependencies, the Unity-MCP plugin source, the compiled Node.js tool server, and the NuGet DLLs. A recipient installs it **fully offline**: no npm registry, OpenUPM, or git access required. The server is plain Node.js, so the same bundle works on Windows, macOS, and Linux.

### Prerequisites (recipient)

- Node.js 20+ and Unity 2022.3 or later.
- The `uco-<version>.tgz` file you received.

### Install

```bash
npm install -g @atelierai/uco-<version>.tgz      # offline; npm dependencies are bundled in the tarball
uco install <path-to-your-unity-project>
```

`uco install` embeds the plugin source into the project's `Packages/com.atelierai.unity.copilot/`, stages the NuGet DLLs into `Assets/Plugins/NuGet/`, and writes an initial `UserSettings/AI-Game-Developer-Config.json`. No server binaries are staged into the project.

Open the project in Unity once — the plugin auto-starts its local Node MCP server on first launch.

```bash
uco ping                          # from the project dir, verify the bridge is live
uco list                          # enumerate available tools
uco call <tool> --args '{...}'    # invoke a tool over REST
```

### Make your AI agent aware of uco

To let an AI agent (Claude Code by default) drive Unity through uco, install uco's Skills into the agent's skills folder. This is the bootstrap step that breaks the chicken-and-egg: the agent learns uco's command surface **before** any Unity project or running server exists.

```bash
uco init                            # install the three uco Skills into ./.claude/skills (Claude Code)
# uco init <dir>                    # target a different working directory
# uco init --agent codex            # use a different agent's skills folder (.agents/skills)
# uco init --agent claude-code,cursor  # install for several agents at once
# uco init --list                   # see all supported agents (with detection paths)
```

Without `--agent`, init picks the agent set for you: interactively (a numbered multi-select on a TTY — press Enter to accept the pre-selected agents) or, when non-interactive, every agent directory already detected at the target (falling back to Claude Code).

Then **restart the agent session** — Claude Code scans the skills folder at startup. The agent can now drive the whole flow on its own: `uco install-unity` → `uco create-project` → `uco install` → `uco open` → `uco setup-skills`.

`uco init` writes static Skill templates with an ownership manifest matching `uco setup-skills`, so a later `setup-skills` (which compiles the live tool catalog and needs a running Editor) refreshes them in place. Running `uco init` twice is a safe no-op.

Every successful install is recorded in `.uco/install-manifest.json` (selected agents, their skills paths, and whether the Unity toolchain surface is installed). Re-running `uco init` with a smaller `--agent` set removes the deselected agents' uco-owned skill directories — never user files.

### Updating an installed target

After upgrading the uco package (`npm i -g @atelierai/uco@latest`), refresh everything uco installed into a target:

```bash
uco update [target]                 # default target: current directory
# uco update --dry-run              # print the planned changes without writing
# uco update --force                # regenerate every recorded agent even when content-identical
# uco update --skip-unity           # leave the Unity plugin package and NuGet DLL set untouched
# uco update --skip-mcp-config      # do not touch any agent MCP config file
```

Per the install manifest, `uco update` refreshes every installed agent's Skills and the shared `.uco/agent-runtime` (content-diff driven — no running Unity Editor required, and a live catalog produced by `setup-skills` is never regressed), re-stages the Unity plugin package and NuGet DLL set as one matched set for bundle-sourced installs (so the stale-DLL CS0246 breakage cannot happen through uco), and reconciles each agent's MCP config from the project's live server settings. It is idempotent — a second run prints `Already up to date.` — and never onboards agents that were not installed (new agent directories surface only as an advisory pointing at `uco init --agent <id>`). Projects that predate the manifest are migrated automatically on first update.

### Rebuilding the bundle (distributor)

From the `unity-copilot/uco` checkout:

```bash
npm run stage-vendor    # copies ../dist/nuget and the plugin source into ./vendor/
npm pack                # prepack rebuilds dist/ (incl. the compiled Node server) and produces uco-<version>.tgz
```

`stage-vendor` fails loudly if any staged artifact is missing — run `scripts/stage-nuget-dlls.ps1` in `unity-copilot/` first.

### Limitations

- **Snapshot date.** The bundled NuGet artifacts reflect the last `stage-nuget-dlls.ps1` run, not necessarily the latest source.
- **Node on the target.** The server runs on the recipient's Node.js (20+); it is compiled JavaScript, not a bundled runtime.

## Install for development

```bash
cd uco
npm install
npm run build
npm link            # expose `uco` globally
# or: node bin/uco.mjs --help
```

npm installation never downloads or executes Unity software. Machine setup is an explicit, consented step:

```bash
# Inspect the exact platform installer, executor, beta channel and verification plan.
uco setup-unity-cli --dry-run --json

# Interactive mode asks a default-no question. CI/non-TTY/JSON automation must opt in.
uco setup-unity-cli --yes --json
```

The command uses only Unity's documented `public-cdn.cloud.unity3d.com` installer, bounds download/output/time, executes it without a shell command string, and cleans uco's temporary script. A successful vendor installer may require a new shell before `unity` is visible; in that case the result is `installed-restart-required`, not fabricated verification. A non-empty invalid `UNITY_CLI_PATH` remains authoritative and must be fixed or unset.

Requires Node.js 20 or later. The official `unity` CLI is:

- optional for automatic lifecycle commands because Hub fallback is retained;
- required for `uco build` and top-level `uco test`;
- recommended for the current lifecycle path and complete direct management/auth/license/Pipeline surface.

Runtime commands additionally require a Unity project with the Unity-MCP plugin installed and a running Editor/server. `uco install [project]` provides the project toolchain setup. Lifecycle and batch commands do **not** require the REST server or a preliminary `uco ping`.

## Choose the right surface

| Domain | Use | Running REST server? | Backend |
|---|---|---:|---|
| Complete official management | raw `unity` for auth, licensing, config, raw editor/project operations and Pipeline/MCP bridge | No, except bridge commands | Official Unity CLI |
| uco lifecycle | `editors`, `install-unity`, `create-project` | No | Official-first; absence-only Hub fallback |
| uco batch | `build`, top-level `test` | No | Official Unity CLI only; never Hub |
| Rich running-Editor automation | `ping`, `list`, `call`, `exec`, and 165 generated tools | Yes | uco REST → tool server → Unity plugin |

The three-surface Skill bundle keeps raw official Unity CLI workflows separate from project integration and running-Editor automation. Live `unity <command> --help` remains authoritative for the complete beta surface.

## Quick tour

### Lifecycle and editor diagnostics

```bash
# Explicit machine prerequisite setup; never runs from npm postinstall or first use.
uco setup-unity-cli --dry-run
uco setup-unity-cli

# Installed editors; include routing/discovery/version/fallback diagnostics
uco editors --diagnostics --json

# Available official/Hub releases under the selected lifecycle backend
uco editors --releases --json

# Latest stable, explicitly consenting to the Unity EULA
uco install-unity --accept-eula

# A specific editor plus official modules (official backend required)
uco install-unity 6000.2.9f1 \
  --module android windows-il2cpp \
  --architecture x86_64 \
  --accept-eula

# Create a project; lifecycle backend is selected before mutation
# com.atelierai.unity.copilot is installed into the manifest by default.
uco create-project ./MyGame \
  --unity 6000.2.9f1 \
  --template com.unity.template.3d

# Reproducible/offline-aware package selection, or the create-only compatibility path.
uco create-project ./PinnedGame --plugin-version 0.74.0
uco create-project ./BareGame --skip-plugin
```

If project creation succeeds but plugin resolution or atomic manifest replacement fails, uco retains the project and exits non-zero with `project-created-plugin-install-failed` plus a copyable `uco install-plugin <project> [--version ...]` retry. It never recreates the project or retries through Hub. `uco install <project>` remains the separate full NuGet/config staging flow.

An explicit positional install version wins; when it is omitted, `install-unity --path <project>` reads the required version from that project, then the final fallback is latest stable. Official-only install modifiers (`--module`, architecture, changeset, child-module selection, force, EULA, resume, and elevation policy) and create modifiers unsupported by Hub are rejected before Hub resolution or mutation; they are never silently dropped.

### Open, then wait for runtime readiness

```bash
uco open ./MyGame && uco wait-for-ready ./MyGame --timeout 180000
uco open ./MyGame --start-server true
uco --project ./MyGame ping
uco --project ./MyGame gameobject-create --name Player --primitiveType Capsule
```

Normal `open` locates and directly launches the Editor, injects the configured MCP connection environment, handles the launch-error dialog, and returns after the OS child emits `spawn`. That is not REST readiness. With explicit `--start-server true`, uco first starts or reuses a uco-owned loopback bridge and waits for its authenticated `/api/health`; only then does it launch Unity with `UNITY_MCP_START_SERVER=false`. If that Editor is already running, uco asks you to close and reopen it because a running process cannot receive the new connection environment. `wait-for-ready` still owns full bridge-and-Editor readiness, including `editor-application-get-state`; its timeout is milliseconds.

Direct `uco-server` startup is secure by default: provide `--token` or `UCO_SERVER_TOKEN`. The compatibility opt-out, `--authorization none`, is loopback-only. A non-loopback `--listen-host` additionally requires explicit `--allow-lan`, required authentication, and a non-empty token.

### Official batch build and test

```bash
uco build ./MyGame \
  --target StandaloneWindows64 \
  --execute-method BuildScript.Build \
  --output-path Build/Windows/Game.exe \
  --json

uco test ./MyGame \
  --mode EditMode \
  --filter 'MyCompany.Tests' \
  --output TestResults/editmode.xml \
  --timeout 1800 \
  --json \
  -- -nographics
```

Build always disables live official build-log tailing. `--target` and `--execute-method` must be non-empty. `--args <arguments>` is exactly one opaque official value; build rejects any non-empty tail after literal `--`. Test is different: raw Editor arguments are accepted only after literal `--` and are preserved token-for-token.

Top-level `uco test` launches an official batch Test Framework operation. Generated `uco tests-run` is a REST call against an already-running Editor/server:

```bash
# Existing running Editor/server workflow
uco tests-run --testMode EditMode --json
```

## Lifecycle backend policy

Backend selection is sticky for one lifecycle command: uco selects and binds the executable/backend before inventory or mutation, then uses it for the whole command.

| `UCO_USE_UNITY_CLI` | Lifecycle behavior |
|---|---|
| unset, empty, or `auto` | Use a discoverable official CLI; select Hub only when official absence is proven before the operation |
| `1` | Require the official CLI; absence is an error |
| `0` | Force Hub for lifecycle commands (rollback/compatibility path) |
| anything else | Configuration error before either backend runs |

A non-empty `UNITY_CLI_PATH` is an authoritative executable override. Under auto/required policy, an invalid override fails for that exact path: uco does not search another PATH entry and does not fall back to Hub. `UCO_USE_UNITY_CLI=0` is the explicit way to force Hub instead.

Fallback is **absence-only**. Once official execution begins, spawn, timeout, abort, invalid-envelope/data, or official command failures are surfaced as structured errors and are never retried through Hub; a mutating operation may already have partial effects. `uco editors --diagnostics` is the supported diagnostic surface—there is no uco `doctor` command.

`UCO_USE_UNITY_CLI` affects lifecycle commands only. Build/test remain official-only even when it is `0` and fail if the official executable is unavailable.

## Options, paths, timeouts, and process ownership

| Surface | Owner and semantics |
|---|---|
| root `-P, --project <path>` | REST config/port project and build/test fallback project; build/test precedence is positional project, root project, then current directory |
| root `--timeout-ms <ms>` | REST request timeout only (default 60,000 ms; range 1–2,147,483,647); deprecated `--timeout` is the millisecond alias |
| `wait-for-ready --timeout-ms <ms>` | staged readiness deadline (default 120,000 ms; range 1–2,147,483,647); deprecated `--timeout` is the millisecond alias and `--interval` is also ms |
| `close --timeout-seconds <seconds>` | normal-close deadline (default 30 s; range 1–2,147,483); deprecated `--timeout` is the seconds alias |
| `status --timeout-ms <ms>` | per-probe deadline (default 5,000 ms; range 1–2,147,483,647); deprecated `--timeout` is the millisecond alias |
| `test --timeout-seconds <seconds>` | official test-process timeout (default 7,200 s; range 1–2,147,483); deprecated `--timeout` is the seconds alias |
| wrapper wall clocks | install 30 min; create 15 min; build 2 h; test at least 2 h or local test seconds + 5 min |
| build/test project path | selected by positional > root `--project` > cwd and resolved absolute |
| output/log/report/editor paths | forwarded unchanged; relative paths retain official CLI semantics rather than being resolved against the project by uco |
| build `--args` | one opaque value; never interpreted as a token list and never put after literal `--` |
| test tokens after literal `--` | opaque Editor arguments preserved in order, including option-looking `--json`/`--format` tokens |

Root global options are supported both before and after subcommands, including suffix JSON forms such as `uco build ... --json`. When root and test-local timeouts are both needed, put the root millisecond value before `test` and the local seconds value after it:

```bash
uco --timeout-ms 60000 test ./MyGame --timeout-seconds 1800 --json
```

Install, first create/import, build, and test can take minutes. Do not wrap them in the root REST timeout or casually kill a first import. Cancellation/timeout handling aborts uco's owned official process tree, waits for bounded settlement, and returns a structured error, but it cannot roll back arbitrary Unity artifacts. Inspect a partially created/imported project before retrying.

## JSON and sensitive diagnostics

Use `--json` for agents and scripts. It can be placed before or after the command. On successful official-backed operations, stdout contains exactly one JSON value representing the official envelope's opaque `data`; uco does not print the outer official `{success, command, data, errors, warnings}` envelope, Hub progress, banners, or a build-log tail. On failure, stdout contains no partial success; a structured error is written to stderr and the process exits non-zero.

Known values for `--android-keystore-base64`, `--android-keystore-password`, and `--android-key-alias-password` are redacted from retained attempted arguments and official/process diagnostics. Always use placeholders in examples:

```bash
uco build ./MyGame \
  --target Android \
  --execute-method BuildScript.Build \
  --android-keystore-base64 '<BASE64_KEYSTORE>' \
  --android-keystore-password '<KEYSTORE_PASSWORD>' \
  --android-key-alias release \
  --android-key-alias-password '<ALIAS_PASSWORD>' \
  --json
```

Redaction is option-aware, not magical. Values inside opaque build `--args` or test post-delimiter Editor arguments are preserved, so uco cannot promise to discover or redact arbitrary embedded secrets. Do not place secrets in those containers.

## Command inventory

### Uco shortcuts (6)

`ping`, `list`, `call`, `exec`, `gen`, and `install`.

### Active dev-ops commands (16)

`install-plugin`, `remove-plugin`, `configure`, `setup-mcp`, `open`, `close`, `wait-for-ready`, `status`, `setup-skills`, `setup-unity-cli`, `install-unity`, `create-project`, `editors`, `build`, `test`, and `login`.

### Generated tools (165 in the current snapshot)

Every current tool is a flat `uco <tool-name>` command with typed flags derived from its JSON Schema. Examples:

```bash
uco gameobject-create --name Player --primitiveType Cube --position '0,1,0'
uco script-execute --csharpCode 'UnityEngine.Debug.Log("hi");' --isMethodBody true
uco screenshot-game-view --json
uco console-get-logs --json
```

Run `uco <tool-name> --help` for its options, `uco list` for the live server catalog, and `uco gen --project <path>` to refresh `src/generated/` after an upstream schema change. The number 165 describes the checked-in snapshot, not a permanent upstream total.

## Exit codes for REST runtime commands

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | CLI/configuration/validation or delegated operation error |
| `2` | REST connection refused |
| `3` | REST request timeout |
| `4` | REST server returned non-2xx |
| `5` | Tool returned a structured failure (`Ok=false` or `ok=false`) |

Official-backed failures additionally carry structured error kinds; scripts should use the non-zero exit code and parse JSON stderr rather than expect fallback success.

## Skills

The canonical progressive-disclosure bundle has exactly three discoverable entry Skills:

- [`uco-setup`](skills/uco-setup/SKILL.md) owns plugin/server/config installation, project integration, repair, and Skill migration.
- [`unity-cli`](skills/unity-cli/SKILL.md) owns the official `unity` CLI, Editor/module and project lifecycle, auth/license, Pipeline/MCP, CI, and process-based build/test/run.
- [`unity-editor`](skills/unity-editor/SKILL.md) owns scenes, assets, code, graphics, physics, diagnostics, and other operations against a ready running Editor.

The complete live catalog and project-pinned wrapper are generated once under the non-discoverable `.uco/agent-runtime`. `tool-info.mjs` extracts one exact schema or at most 20 search results, so 165 schemas never enter Skill metadata or the default context.

Generate a project-scoped bundle from the running Editor's real catalog:

```bash
uco setup-skills codex /path/to/UnityProject --dry-run
uco setup-skills codex /path/to/UnityProject --migrate-legacy
```

Codex output follows the Agent Skills convention at `.agents/skills/{uco-setup,unity-cli,unity-editor}`. A managed v1 `unity-copilot` directory is migrated automatically; `--migrate-legacy` additionally removes only recognizable one-tool-per-Skill leaves. User-authored directories and files are preserved. All three entries and the shared runtime are staged and ownership-validated before transactional publication, enabling safe idempotent updates.

## Roadmap

- Done: plain-REST runtime transport and typed generated tool commands.
- Done: active dev-ops, official-first lifecycle routing, editor diagnostics, and official-only build/test wrappers.
- Current: documentation and release packaging alignment for the beta.3-verified contract.
- Deferred: remove the Hub transition fallback only after an explicit stability decision; it remains current behavior today.
- Future: refresh generated tools and direct official guidance as upstream schemas/beta flags evolve.

## License

MIT for uco's original code—see [LICENSE](LICENSE).

Substantial code under `src/devops/lib/` and `src/devops/utils/` is derived from [IvanMurzak/Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) under Apache-2.0; original notices are preserved.
