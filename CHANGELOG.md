# Changelog

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
  `uco open --start-server` handoff health checks and generated MCP configs
  (`.mcp.json`) use `127.0.0.1` as well.
- Legacy `.cocli-skill.json` markers refresh in place again (a pre-rename
  install was refused by its own ownership marker; the marker file itself
  no longer counts as unmanaged).
- Bridge startup banner reports the real package version (was stuck at
  `0.2.1-node` since the Node migration).
- unity-editor skill: Editor log guidance for multi-instance machines
  (project-local `Logs/Editor.log` vs the machine-global one, DLL-timestamp
  compile verification, per-process proxy notes).


## 1.0.4 - 2026-09-17

- Server startup banner says "uco bridge" (was "Node MCP Server"); help
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
  "Unity-MCP server"; the uco-setup recovery skill now documents how to
  bring the bridge up (`uco open --start-server true`, plugin auto-start,
  manual spawn with the exact CLI arguments).

## 1.0.2 - 2026-09-15

- Product naming unified to **Unity Copilot** (no hyphen) across docs and
  skill templates.
- Vendored plugin refreshed to **1.0.2**: one menu tree (Tools ▸ Unity
  Copilot), the "AI Game Developer" leftovers and the dead MCP Inspector
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

