# uco integration recovery

Read this only after the bootstrap happy path fails.

## Diagnose by layer

1. Verify `Packages/manifest.json` contains `com.atelierai.unity.copilot` and inspect its source/version without rewriting unrelated dependencies.
2. Check the OpenUPM scopes required by the package and preserve an active local package source.
3. Check that `Assets/Plugins/NuGet` is present when using full `uco install`. (No server directory is staged — the Unity plugin launches its Node server itself.)
4. Check `UserSettings/AI-Game-Developer-Config.json` exists, but never print its token.
5. Confirm the expected Unity Editor process owns this exact project before diagnosing REST readiness.
6. Use `uco status`, then `open` plus `wait-for-ready`; only then run `ping` and `instance-get-current`.

## Safe repair

- Run `install-plugin --dry-run` or `install --dry-run` before mutation.
- Close Unity before a repair that replaces staged NuGet files or rewrites package resolution state.
- If package installation fails after project creation, retain the project and retry `install-plugin`; do not recreate the project or switch lifecycle backend blindly.
- After package or script changes, reopen Unity, wait for import/domain reload, and inspect new console errors.
- Regenerate Skills only from a ready live catalog. A moved uco checkout requires regeneration because the project wrapper pins the entry path.

## Skill migration

`setup-skills --migrate-legacy` removes only recognizable one-tool-per-Skill leaves in the selected agent root. A managed v1 `unity-copilot` bundle is upgraded automatically. User-authored files or unknown ownership cause a refusal instead of data loss.
