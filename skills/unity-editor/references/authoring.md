# Scenes, GameObjects, components, assets, and prefabs

Use this reference when the primary result is a Unity serialized-content change.

Inspect open scenes and locate target objects/assets first. Use Unity asset operations when preserving `.meta` identity matters. Validate a representative mutation before batching; never batch destructive work merely to save latency. Save and re-read the scene, prefab, or asset, then inspect console errors.

## Live tool groups
