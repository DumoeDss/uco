# Console, profiler, frame debugger, instances, and tool diagnostics

Capture the smallest relevant evidence before changing anything: new console entries, bounded counters/traces, frame events, or instance state. Test one hypothesis at a time and repeat the same measurement after an authorized fix.

Profiler and frame-debugger capture can perturb results. Record capture conditions and keep output bounded. Unknown third-party prefixes remain reachable here with a generation warning.

## Editor log files on multi-instance machines

Unity keeps one machine-global log — Windows `%LOCALAPPDATA%\Unity\Editor\Editor.log`, macOS `~/Library/Logs/Unity/Editor.log`, Linux `~/.config/unity3d/Editor.log` — owned by whichever Editor instance started most recently (older content rotates to `Editor-prev.log`). With several Editors open, that file usually diagnoses the wrong project.

Newer Editors (verified on 6000.5) also write a project-local `<project>/Logs/Editor.log` that belongs to this project's instance regardless of what else is running (`AssetImportWorker*.log`, `upm.log`, and `Packages-Update.log` there are per-project too) — prefer it when it exists. Older Editors (verified on 2022.3) write no project-local `Editor.log`; on those, identify the owning instance before trusting the global file, or verify by artifacts below.

Reliable compile-status signals when the bridge is not yet usable (still importing, or plugin not connected) — version-independent:

- `<project>/Library/ScriptAssemblies/<Assembly>.dll` timestamps — a failed compile writes no DLL, so a DLL newer than the last script edit proves that edit compiled clean.
- `grep "error CS"` in the project-local log (6000.x) or in the global log after confirming its owning instance (202.3/older; check the head of the file for this instance's `-projectPath` in `COMMAND LINE ARGUMENTS`).

Prefer `console-get-logs` through the bridge once it is connected. To pin a private log per instance, launch with `-logFile <path>` (batch-mode gates already do this); a running instance cannot be redirected.

## Loopback and per-process proxies

uco dials its own bridge at the `127.0.0.1` literal even when a config says `localhost` — Node's fetch may resolve `localhost` to `::1` while the bridge binds IPv4 loopback, and per-process proxy rules (Proxifier/TUN configurations matching `node.exe`) commonly hijack that path. When a bridge is genuinely down on such a machine, the failure still classifies as `connection-refused` (uco re-checks with a raw TCP probe), so trust that diagnosis. What uco cannot work around: a proxy rule that also breaks traffic to live loopback ports — if `uco ping` fails while the bridge process is demonstrably listening, ask the user to exclude loopback (`127.0.0.0/8`, `localhost`) from their proxy rules. Agent MCP configs (`.mcp.json`) pin `127.0.0.1` for the same reason; other clients dialing a `localhost` URL on a proxified machine may need the same rewrite.

## Live tool groups
