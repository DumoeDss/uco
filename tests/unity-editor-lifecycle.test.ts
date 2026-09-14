import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { UnityLifecycleSession } from '../src/devops/lib/unity-lifecycle.js';
import { findEditorPath } from '../src/devops/utils/unity-editor.js';

function editorExecutable(version: string): string {
  if (process.platform === 'win32') return `C:\\Unity\\${version}\\Editor\\Unity.exe`;
  if (process.platform === 'darwin') return `/Applications/Unity/${version}/Unity.app/Contents/MacOS/Unity`;
  return `/opt/unity/${version}/Editor/Unity`;
}

function session(
  editors: Array<{ version: string; path: string }>,
  backend: 'unity-cli' | 'unity-hub' = 'unity-cli',
): UnityLifecycleSession {
  return {
    backend,
    decision: {
      policy: backend === 'unity-cli' ? 'required' : 'auto',
      reason: backend === 'unity-cli' ? 'required-by-flag' : 'auto-absent-fallback',
      overridePresent: false,
      officialAvailable: backend === 'unity-cli',
      fallback: backend === 'unity-hub',
    },
    unityCliPath: backend === 'unity-cli' ? '/tools/unity' : undefined,
    hubPath: backend === 'unity-hub' ? '/tools/UnityHub' : undefined,
    validateInstallOptions: vi.fn(),
    validateCreateOptions: vi.fn(),
    listInstalledEditors: vi.fn(async () => editors),
    listAvailableReleases: vi.fn(async () => []),
    installEditor: vi.fn(async () => undefined),
    createProject: vi.fn(async () => undefined),
    getDiagnostics: vi.fn(() => ({
      policy: backend === 'unity-cli' ? 'required' : 'auto',
      selectedBackend: backend,
      selectionReason: backend === 'unity-cli' ? 'required-by-flag' : 'auto-absent-fallback',
      overridePresent: false,
      officialAvailable: backend === 'unity-cli',
      officialPath: backend === 'unity-cli' ? '/tools/unity' : null,
      officialVersion: null,
      fallback: backend === 'unity-hub',
    })),
  };
}

describe('routed editor locator slow path', () => {
  it('returns a cache hit without selecting a lifecycle backend', async () => {
    const selectSession = vi.fn(() => session([]));
    const cached = editorExecutable('6000.5.6f1');
    await expect(findEditorPath('6000.5.6f1', {
      selectSession,
      readCachedEditorPath: () => cached,
      findEditorPathByCommonLocations: vi.fn(() => null),
    })).resolves.toBe(cached);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('returns and caches a known-version common path without selecting a backend', async () => {
    const selectSession = vi.fn(() => session([]));
    const common = editorExecutable('2022.3.62f3');
    const writeCache = vi.fn();
    await expect(findEditorPath('2022.3.62f3', {
      selectSession,
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => common,
      writeCachedEditorPath: writeCache,
    })).resolves.toBe(common);
    expect(selectSession).not.toHaveBeenCalled();
    expect(writeCache).toHaveBeenCalledWith('2022.3.62f3', common);
  });

  it('accepts an official inventory path that already names the executable', async () => {
    const executable = editorExecutable('6000.5.6f1');
    const selected = session([{ version: '6000.5.6f1', path: executable }]);
    const writeCache = vi.fn();
    await expect(findEditorPath('6000.5.6f1', {
      selectSession: () => selected,
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => null,
      writeCachedEditorPath: writeCache,
    })).resolves.toBe(executable);
    expect(selected.listInstalledEditors).toHaveBeenCalledTimes(1);
    expect(writeCache).toHaveBeenCalledWith('6000.5.6f1', executable);
  });

  it('uses the selected auto-fallback Hub session without switching backends', async () => {
    const executable = editorExecutable('2022.3.62f3');
    const selected = session([{ version: '2022.3.62f3', path: executable }], 'unity-hub');
    const selectSession = vi.fn(() => selected);
    await expect(findEditorPath('2022.3.62f3', {
      selectSession,
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => null,
      writeCachedEditorPath: vi.fn(),
    })).resolves.toBe(executable);
    expect(selectSession).toHaveBeenCalledTimes(1);
    expect(selected.listInstalledEditors).toHaveBeenCalledTimes(1);
  });

  it('keeps the common-location fallback for a successful empty inventory', async () => {
    const fallback = editorExecutable('6000.5.6f1');
    const findCommon = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(fallback);
    await expect(findEditorPath('6000.5.6f1', {
      selectSession: () => session([]),
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: findCommon,
      writeCachedEditorPath: vi.fn(),
    })).resolves.toBe(fallback);
    expect(findCommon).toHaveBeenCalledTimes(2);
  });

  it('propagates a selected official inventory failure without a retry', async () => {
    const selected = session([]);
    const error = new Error('official inventory failed');
    vi.mocked(selected.listInstalledEditors).mockRejectedValueOnce(error);
    const selectSession = vi.fn(() => selected);
    await expect(findEditorPath(undefined, {
      selectSession,
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => null,
      writeCachedEditorPath: vi.fn(),
    })).rejects.toBe(error);
    expect(selectSession).toHaveBeenCalledTimes(1);
    expect(selected.listInstalledEditors).toHaveBeenCalledTimes(1);
  });

  it('matches a requested version and otherwise selects the numeric highest version', async () => {
    const older = editorExecutable('2022.3.9f1');
    const newer = editorExecutable('2022.3.62f3');
    const selected = session([
      { version: '2022.3.9f1', path: older },
      { version: '2022.3.62f3', path: newer },
    ]);
    const baseDependencies = {
      selectSession: () => selected,
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => null,
      writeCachedEditorPath: vi.fn(),
    };
    await expect(findEditorPath('2022.3.9f1', baseDependencies)).resolves.toBe(older);
    await expect(findEditorPath(undefined, baseDependencies)).resolves.toBe(newer);
  });

  it('normalizes an installation root according to the current platform', async () => {
    const root = process.platform === 'win32'
      ? 'C:\\Unity\\6000.5.6f1'
      : process.platform === 'darwin'
        ? '/Applications/Unity/6000.5.6f1'
        : '/opt/unity/6000.5.6f1';
    const expected = process.platform === 'win32'
      ? path.join(root, 'Editor', 'Unity.exe')
      : process.platform === 'darwin'
        ? path.posix.join(root, 'Unity.app', 'Contents', 'MacOS', 'Unity')
        : path.posix.join(root, 'Editor', 'Unity');
    await expect(findEditorPath('6000.5.6f1', {
      selectSession: () => session([{ version: '6000.5.6f1', path: root }]),
      readCachedEditorPath: () => null,
      findEditorPathByCommonLocations: () => null,
      writeCachedEditorPath: vi.fn(),
    })).resolves.toBe(expected);
  });
});

