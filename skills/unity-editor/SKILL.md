---
name: unity-editor
description: Inspect or change a running Unity Editor through uco tools. Use for scenes, GameObjects, components, assets, scripts, packages, UI, graphics, physics, screenshots, console, profiler, live build jobs, or in-Editor tests. Requires a ready Unity Copilot project bridge.
---

# Running Unity Editor

Requires a ready project bridge. Use the project-pinned wrapper:

```bash
node .uco/agent-runtime/scripts/uco.mjs <command> [...args]
```

## Preflight and core loop

```bash
node .uco/agent-runtime/scripts/uco.mjs ping
node .uco/agent-runtime/scripts/uco.mjs status --json
```

If the Editor is stopped, use `open` followed by `wait-for-ready`; process spawn alone is not REST readiness. If installation/configuration is broken rather than merely stopped, use `$uco-setup`.

For every task:

1. Inspect/find/read before mutation.
2. Prefer the narrowest typed tool and use `<tool> --help` for ordinary flags.
3. For a nested or unclear payload, extract exactly one schema:

```bash
node .uco/agent-runtime/scripts/tool-info.mjs <exact-tool-name>
```

4. Make the smallest coherent change, save Unity serialized state, and re-read it.
5. After source/package changes, wait for import/domain reload and inspect new console errors. When reading log files while the bridge is down, mind which Editor instance owns them — the machine-global `Editor.log` belongs to whichever Editor started last; prefer the project-local `Logs/Editor.log` (6000.x) or verify by `Library/ScriptAssemblies` DLL timestamps (see the diagnostics reference).
6. Use a focused in-Editor test or screenshot when behavior or appearance matters.

Never load `.uco/agent-runtime/catalog/tools.json` wholesale.

## Runtime reference map

- [Scenes, GameObjects, components, assets, and prefabs](references/authoring.md)
- [C# scripts, packages, docs, types, and reflection](references/code.md)
- [Cameras, graphics, UI, textures, screenshots, and VFX](references/visuals.md)
- [Physics queries, colliders, rigidbodies, and simulation](references/physics.md)
- [Console, profiler, frame debugger, instances, and tool diagnostics](references/diagnostics.md)
- [Live build jobs, build settings, batching, and in-Editor tests](references/build-and-tests.md)
- [Preset instruction prompts](references/prompts.md)
- [Read-only state resources](references/resources.md)

Simple scene/GameObject reads and mutations can use the core loop without loading a reference. Raw official Editor/project lifecycle and process-based build/test/run belong to `$unity-cli`.
