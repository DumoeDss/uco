# Changelog

## 1.0.10 - 2026-09-19

- Vendored plugin refreshed to **1.0.8** — fixes an editor-native crash on
  domain reload (UmaViewer issue uco-domain-reload-crash-20260919, 2/2
  reproducible during script recompile). The plugin no longer defines a
  finalizer: the historical one ran the full teardown (token cancellation
  with synchronous Task continuations and ExecutionContext restores) on the
  GC finalizer thread during domain unload, which mono cannot execute.
  Assembly-reload/unload/quit cleanup now disposes the plugin instance
  deterministically on the safe background-thread path. Ten other
  same-pattern finalizers (request DTOs, log storage/collector) removed with
  it. Framework tests 831x2; 2022.3 gate unchanged.


## 1.0.9 - 2026-09-19

- Vendored plugin refreshed to **1.0.7**: the complete legacy-naming sweep —
  dead config-builder helpers removed (the last code producing
  agent-config-shaped JSON), internal docs rewritten to the current
  architecture, package/UI naming cleaned end to end, and a live prefs-key
  bug fixed (the tool-group flag now reads the key its own migration writes).
  Framework tests 831x2, 2022.3 gate 857/858 unchanged.


## 1.0.8 - 2026-09-19

- Vendored plugin refreshed to **1.0.6**: the C# source's internal type and
  directory names complete the legacy-naming scrub (managers, builder,
  hub interfaces, test names, storage keys). No behavioral change —
  framework tests 831/831 across TFMs, 2022.3 EditMode gate unchanged.
- This rename also fixed a live mismatch: the plugin now requests
  `GetPluginClientData`, which the bridge actually serves (it previously
  requested a method name the bridge never registered).


## 1.0.7 - 2026-09-19

- **Legacy agent-config writing removed.** uco no longer writes or
  reconciles server entries into agent-client config files
  Cursor, codex toml, …) — those entries pointed at a protocol surface the
  bridge has never spoken and never worked; they only surfaced as dead
  entries in agent tooling. The legacy setup and login commands are gone.
  Existing entries in your projects are left untouched; delete them at will.
- **Legacy naming surface scrubbed end to end.** The bridge speaks plain
  REST (`/api/*`) plus a raw-WebSocket plugin hub — nothing else — and the
  codebase, docs, skills, banner, help text, wire identifiers (hub path,
  instance header, notification methods) and editor environment variables
  (`UNITY_COPILOT_*`) now say exactly that.
- The CLI update checker now checks **@atelierai/uco** on npm (it previously
  queried a package that is not ours and could never report updates).
- Vendored plugin refreshed to **1.0.5** with the matching wire identifiers.
  **Both sides must move together**: a plugin older than 1.0.5 cannot connect
  to this bridge, and this bridge does not accept the old plugin — upgrade
  projects with `uco update` after installing 1.0.7.


## 1.0.6 - 2026-09-19

- Agent-client config files written by the legacy setup command /
  `uco update` now dial `127.0.0.1` even when the project config's host says
  `localhost` — third-party agent clients (Claude Code, codex) run on Node
  runtimes that resolve `localhost` to `::1`, which per-process proxy rules
  commonly hijack. The project config file itself is left untouched.


## 1.0.5 - 2026-09-19

- **Embed upgrades now prune stale files.** The embedded package restage
  (`uco install` / `uco update`) mirrors the bundle exactly: files removed
  between versions are deleted (the 1.0.2 -> 1.0.4 upgrade left the
  Cloud-era `DeviceAuthFlow.cs` behind, which broke the whole Editor asmdef
  compile), and the refresh-diff detects extra files so `uco update` no
  longer reports `unchanged` for a directory that is actually broken.
- **Loopback hardening against per-process proxies.** uco dials its own
  bridge at the `127.0.0.1` literal even when a config says `localhost`
  (Node's fetch may resolve `localhost` to ::1, which proxy rules matching
  node.exe commonly hijack), and a dead bridge behind such a proxy still
  classifies as `connection-refused` instead of an opaque `fetch failed`.
  `uco open --start-server` handoff health checks and generated agent configs use
  `127.0.0.1` as well.
- Legacy `.cocli-skill.json` markers refresh in place again (a pre-rename
  install was refused by its own ownership marker; the marker file itself
  no longer counts as unmanaged).
- Bridge startup banner reports the real package version (was stuck at
  `0.2.1-node` since the Node migration).
- unity-editor skill: Editor log guidance for multi-instance machines
  (project-local `Logs/Editor.log` vs the machine-global one, DLL-timestamp
  compile verification, per-process proxy notes).


## 1.0.4 - 2026-09-17

- Server startup banner says "uco bridge"; help
  endpoint header updated to match.
- Vendored plugin refreshed to **1.0.4**: the in-editor updater now
  detects embedded installs (uco install) and directs the user to the
  CLI instead of failing with a UPM error.

## 1.0.3 - 2026-09-17

- Vendored plugin refreshed to **1.0.3**: the Cloud connection mode is gone
  (single Custom mode, local bridge auto-starts unconditionally), and the
  bridge discovery now finds the published **@atelierai/uco** npm package
  (plus legacy `uco`/`cocli` layouts as fallbacks).
- Help text and skill templates say "uco bridge server" instead of
  the legacy server name; the uco-setup recovery skill now documents how to
  bring the bridge up (`uco open --start-server true`, plugin auto-start,
  manual spawn with the exact CLI arguments).

## 1.0.2 - 2026-09-15

- Product naming unified to **Unity Copilot** (no hyphen) across docs and
  skill templates.
- Vendored plugin refreshed to **1.0.2**: one menu tree (Tools ▸ Unity
  Copilot), the "AI Game Developer" leftovers and the dead legacy inspector
  item removed.
- `uco init` interactive agent selection now renders a checkbox list
  (space toggles, arrows move, enter confirms) on a TTY; non-TTY keeps the
  numbered answer grammar.
- Codex skills folder follows the current Codex convention:
  `.codex/skills` (was `.agents/skills`).

## 1.0.1 - 2026-09-15

- Vendored plugin refreshed to **1.0.1** — the three framework DLLs
  (ReflectorNet / Uco.Framework / Uco.Framework.Common) now ship inside
  the plugin package itself, making OpenUPM and git-URL installs
  self-contained.
- `uco install` removes project-level copies of the relocated framework
  trio on upgrade (they would collide with the package-embedded
  assemblies); the staged external NuGet set is unchanged.

## 1.0.0 - 2026-09-14 — first public release

Inaugural public version of **uco** (Unity Copilot CLI); the version
counter starts here.

uco drives the Unity Editor from any AI agent or terminal over plain HTTP:
a Node bridge server plus this CLI. Ships together with the
`com.atelierai.unity.copilot` plugin package (vendored, matched set).

- 165+ typed tool commands mirrored 1:1 from the live Editor catalog
  (`uco call <tool>`, `uco exec` Roslyn compile-and-execute, `uco list`)
- `uco install` — one-shot project integration: embedded plugin package,
  NuGet DLL set, config, and agent skill generation
- Three-surface agent skills (uco-setup / unity-cli / unity-editor) with a
  shared `.uco/agent-runtime` wrapper, refreshed from the live catalog via
  `uco setup-skills`; `uco update` keeps skills, runtime, and toolchain in
  step after every upgrade
- Durable async calls (`uco exec --async` -> `uco call get <id> --wait`),
  structured error envelopes, deterministic per-project ports with token
  auth
- Lifecycle wrappers over the official Unity CLI: editors, install-unity,
  create-project, build, test — plus `open`/`close`/`wait-for-ready`
  editor orchestration

