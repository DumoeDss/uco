# Changelog

## 1.0.1 - 2026-09-15

- Vendored plugin refreshed to **1.0.1** — the three framework DLLs
  (ReflectorNet / Uco.Framework / Uco.Framework.Common) now ship inside
  the plugin package itself, making OpenUPM and git-URL installs
  self-contained.
- `uco install` removes project-level copies of the relocated framework
  trio on upgrade (they would collide with the package-embedded
  assemblies); the staged external NuGet set is unchanged.

## 1.0.0 - 2026-09-14 — first public release

Inaugural public version of **uco** (Unity Co-Pilot CLI); the version
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

