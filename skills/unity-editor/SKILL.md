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

The installed project wrapper defaults to `--result-view auto`: small returns,
mutations and screenshots remain full; large typed read-only returns may carry
a compact/ref view and a complete redacted evidence file in the OS temporary
directory. Inspect `resultView` to see what was selected. Use
`--result-view full` when the complete output is needed immediately, or
`--evidence-dir <existing-directory>` to keep auto evidence in a chosen place.
For explicit control, use `--result-view ref --evidence-file <new-path>`;
`scene-get-data`, `console-get-logs`, and `batch-execute` also accept explicit
`--result-view compact`. Retrieve missing facts with
`uco evidence show <path> --sha256 <hash> --pointer <json-pointer>`;
do not re-call a mutating Unity tool merely to recover output. Use a new file
path per call; UCO will not overwrite prior evidence. Default full output is
unchanged in the raw CLI. These views reduce output volume, not the need to
verify task-specific claims or handle tool failures.

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
