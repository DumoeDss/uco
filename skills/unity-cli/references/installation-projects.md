# Official CLI installation, Editors, and projects

## Install the CLI

Use uco's bounded, explicit installer flow:

```bash
uco setup-unity-cli --dry-run --json
uco setup-unity-cli
# Non-interactive only after operator approval:
uco setup-unity-cli --yes --json
unity --version
```

Npm installation and ordinary uco discovery never execute Unity's remote installer implicitly. Raw platform installation uses Unity's documented installer and `UNITY_CLI_CHANNEL=stable|beta`.

## Editors and modules

```bash
unity editors -i --json
unity releases --lts
unity install 6000.5.6f1 --accept-eula
unity install-modules -e 6000.5.6f1 -l

uco editors --diagnostics --json
uco editors --releases --json
uco install-unity 6000.5.6f1 --accept-eula --json
```

Specific historical versions may require release filters or a changeset. First install/import can take many minutes; interruption can leave partial state, so inspect before retrying.

## Projects

```bash
unity projects list
unity projects info .
unity projects add ./MyGame
unity projects remove ./MyGame
unity projects new MyGame --path . --editor-version 6000.5.6f1 \
  --template com.unity.template.3d --non-interactive
unity open ./MyGame

uco create-project ./MyGame --unity 6000.5.6f1 \
  --template com.unity.template.3d --json
```

`uco create-project` installs `com.atelierai.unity.copilot` by default; project integration repair then belongs to `$uco-setup`. `unity open` proves process launch, not uco REST readiness.
