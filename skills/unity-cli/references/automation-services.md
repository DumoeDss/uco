# Official automation, services, and diagnostics

## Build, test, and run

Build requires a real static C# execute method:

```bash
unity build . --target StandaloneWindows64 \
  --execute-method BuildScript.BuildWindows --output-path Build/Game.exe --no-tail
uco build . --target StandaloneWindows64 \
  --execute-method BuildScript.BuildWindows --output-path Build/Game.exe --json

unity test . --mode EditMode --output TestResults/editmode.xml
uco test . --mode PlayMode --output TestResults/playmode.xml --timeout 1800 --json
unity run . -- -nographics
```

The timeout after uco `test` is seconds; the root REST timeout is milliseconds. Batch/no-graphics execution has no normal Game view. Use a running GUI Editor or explicit render-texture flow for visual capture.

## Auth, license, cloud, and CI

```bash
unity auth login
unity auth status
unity auth logout
unity license
unity cloud
unity config
```

In CI, supply `UNITY_SERVICE_ACCOUNT_ID` and `UNITY_SERVICE_ACCOUNT_SECRET` through the secret store. Use non-interactive and machine-readable output without echoing secret values.

## Pipeline and MCP

```bash
unity pipeline install --project-path .
unity open .
unity status
unity list
unity command
unity mcp --project-path .
unity mcp configure --list
```

Pipeline/MCP requires Unity 6 and an already-running Editor. It is distinct from uco's REST runtime bridge.

## Diagnostics

Use `unity doctor`, `diagnose`, `env`, `logs`, `cache`, `config`, `shell`, `completion`, `changelog`, and `upgrade` as appropriate. Redact reports before sharing them and prefer live help for current beta syntax.
