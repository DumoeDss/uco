# Live build jobs, build settings, batching, and in-Editor tests

These tools operate through the already-running Editor bridge. They are not aliases for raw/top-level official process commands.

- `build-*` can inspect build settings, manage scenes/platform, start a player build job, and poll its state.
- `tests-run` executes inside the current ready Editor. Save every dirty scene first.
- `batch-execute` reduces round trips for validated independent calls; do not hide ordering dependencies or destructive risk inside a batch.

Use `$unity-cli` instead when the task is a standalone batch process, CI build/test/run, or does not need the current GUI Editor session.

## Live tool groups
