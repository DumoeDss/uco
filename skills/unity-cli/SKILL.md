---
name: unity-cli
description: Operate Unity's official unity CLI directly or through uco lifecycle wrappers. Use for Unity CLI or Editor/module installation, project creation and opening, auth, licensing, configuration, Pipeline/MCP, diagnostics, CI, or process-based run/build/test. Not for live scene or asset manipulation.
---

# Official Unity CLI

Use raw `unity` for the complete official surface and uco for its bounded installation/lifecycle/build/test wrappers. These operations do not require a uco runtime ping. The official CLI is beta, so `unity <command> --help` is authoritative when examples drift.

## Command ownership

| Need | Command family |
|---|---|
| Install the official CLI explicitly | `uco setup-unity-cli` |
| Discover/install Editors and modules | `unity editors/install/...` or uco `editors`/`install-unity` |
| Create/register/open projects | `unity projects ...`, `unity open`, or uco `create-project` |
| Auth, license, cloud, config, diagnostics | raw `unity auth`, `unity license`, `unity cloud`, `unity config`, `unity doctor` |
| Process-based build/test/run | raw `unity build/test/run` or top-level uco `build/test` |
| Official Pipeline/MCP bridge | raw `unity pipeline`, `unity status/list/command/mcp` |

## Rules

1. Prefer `--json` or another documented machine-readable format and check the process exit code.
2. Use non-interactive flags/environment in CI; never allow a missing value to hang on a prompt.
3. Do not require REST `ping` before Editor inventory/install, project creation/open, or process-based build/test/run.
4. A non-empty `UNITY_CLI_PATH` is authoritative to uco. Automatic Hub fallback is absence-only and must never retry an already-started official mutation.
5. Top-level uco `build` and `test` are official-only. Generated `build-*` and `tests-run` tools instead belong to `$unity-editor`.
6. Do not place credentials in opaque build arguments, test tails, examples, logs, or Skill files.

Quick inspection:

```bash
unity --version
unity editors -i --json
unity projects info .
unity auth status
```

Read [installation and projects](references/installation-projects.md) for local lifecycle details. Read [automation and services](references/automation-services.md) for build/test/run, auth/license, CI, diagnostics, and Pipeline/MCP.
