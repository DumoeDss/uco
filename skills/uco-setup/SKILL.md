---
name: uco-setup
description: Bootstrap or repair uco integration in a Unity project. Use for Unity Co-Pilot plugin installation or updates, NuGet/config staging, agent Skill generation or migration, project wrapper repair, and bridge readiness failures. Not for routine Editor changes or official Unity lifecycle commands.
---

# uco setup

Use this Skill for project integration, not ordinary Unity authoring. Run installed project commands through the shared wrapper when it exists:

```bash
node .uco/agent-runtime/scripts/uco.mjs <command> [...args]
```

If the wrapper is absent or broken, invoke the installed `uco` command or its known checkout directly, then regenerate the bundle.

## Bootstrap sequence

1. Confirm the target contains `Assets/`, `Packages/`, and `ProjectSettings/`.
2. Inspect before mutation (both commands print their planned actions and write nothing):

```bash
uco install-plugin <project> --dry-run
uco install <project> --dry-run
```

3. Install the Unity Co-Pilot package alone with `install-plugin`, or use `install` when NuGet and configuration staging are also required.
4. Open the project and wait for package resolution/compilation.
5. Require runtime readiness before reading the live catalog:

```bash
uco open <project>
uco wait-for-ready <project> --timeout 180000
uco --project <project> ping
```

6. Generate the three project Skills:

```bash
uco setup-skills codex <project> --dry-run
uco setup-skills codex <project> --migrate-legacy
```

The result must contain exactly `uco-setup`, `unity-cli`, and `unity-editor`, plus the non-discoverable `.uco/agent-runtime` support directory.

## Ownership boundaries

- `uco create-project`, `install-plugin`, `install`, `configure`, `setup-mcp`, and `setup-skills` belong here.
- Installing or using the official `unity` executable, Editor inventory, auth/license, and process-based build/test belong to `$unity-cli`.
- Scene, GameObject, asset, script, graphics, physics, console, profiler, screenshot, and in-Editor tests belong to `$unity-editor`.
- `open` and `wait-for-ready` are setup handoff commands here; routine runtime preflight is also summarized in `$unity-editor` so normal development does not load this Skill.

Never print project tokens or silently replace an unmanaged Skill directory. For failed installs, stale wrappers, package resolution, or connection diagnosis, read [recovery](references/recovery.md).
