import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAll, detectPackageSiblings, pluginSurfaceDiffers } from '../src/devops/lib/install.js';
import type { PluginSource } from '../src/devops/lib/types.js';
import type { UnityLifecycleSession } from '../src/devops/lib/unity-lifecycle.js';
import { executeCreateProject } from '../src/commands/devops/create-project.js';
import { UCO_UNITY_PACKAGE_ID } from '../src/devops/utils/manifest.js';
import {
  UNITY_SOURCE_BUNDLE,
  readInstallManifest,
  recordUnityInInstallManifest,
} from '../src/skills/install-manifest.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A minimal Unity project: Packages/manifest.json + the embed dependency. */
function unityProject(): string {
  const project = temporaryDirectory('uco-unity-refresh-project-');
  fs.mkdirSync(path.join(project, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Packages', 'manifest.json'), JSON.stringify({
    dependencies: { 'com.unity.modules.core': '1.0.0' },
  }, null, 2) + '\n');
  return project;
}

/** A minimal fake plugin bundle source. */
function pluginSource(version: string): { source: PluginSource; root: string } {
  const root = temporaryDirectory('uco-unity-refresh-plugin-');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: UCO_UNITY_PACKAGE_ID, version }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'Runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Runtime', 'Plugin.cs'), `// ${version}\n`);
  return { source: { kind: 'embed', sourcePath: root }, root };
}

/** A minimal fake staged NuGet set: a DLL plus its .meta. */
function nugetSource(dllContent: string): string {
  const root = temporaryDirectory('uco-unity-refresh-nuget-');
  fs.writeFileSync(path.join(root, 'System.Text.Json.dll'), dllContent);
  fs.writeFileSync(path.join(root, 'System.Text.Json.dll.meta'), 'fileFormatVersion: 2\nguid: 1111111111111111111111111111111\n');
  return root;
}

const lockfilePath = (project: string): string => path.join(project, 'Packages', 'packages-lock.json');

/**
 * `installAll` wrapper for this change's refresh tests. The refresh path
 * never stages a tool server, so every call asks `skipServer: true`. The
 * field exists only in the pre-Node-migration `InstallAllOptions` (where
 * omitting it makes installAll demand a `stagedServerPath` and fail); the
 * intersection keeps the calls type-valid before and after the migration
 * deletes the field, and the extra property is a runtime no-op afterwards.
 */
type RefreshInstallOptions = Parameters<typeof installAll>[0] & { skipServer?: boolean };

function callInstallAll(options: RefreshInstallOptions) {
  const call: RefreshInstallOptions = { ...options, skipServer: true };
  return installAll(call);
}

describe('installAll refresh mode', () => {
  it('stages the plugin and DLL set as one matched set in a single invocation', async () => {
    const project = unityProject();
    const { source } = pluginSource('2.0.0');
    const nuget = nugetSource('v2-dll');

    const result = await callInstallAll({
      unityProjectPath: project,
      pluginSource: source,
      stagedNugetPath: nuget,
      refresh: true,
      skipConfig: true,
    });
    expect(result.kind).toBe('success');
    expect(fs.readFileSync(path.join(project, 'Packages', UCO_UNITY_PACKAGE_ID, 'Runtime', 'Plugin.cs'), 'utf8')).toContain('2.0.0');
    expect(fs.readFileSync(path.join(project, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll'), 'utf8')).toBe('v2-dll');
  });

  it('prunes stale files the new bundle no longer ships (stale .cs must not survive a restage)', async () => {
    const project = unityProject();
    const { source } = pluginSource('2.0.0');
    const nuget = nugetSource('v2-dll');
    await callInstallAll({
      unityProjectPath: project,
      pluginSource: source,
      stagedNugetPath: nuget,
      refresh: true,
      skipConfig: true,
    });

    // Simulate the upgrade-crossing-a-deletion leftover: a file (and its
    // .meta) present in the installed embed copy but absent from the new
    // bundle — exactly the 1.0.2 -> 1.0.4 DeviceAuthFlow.cs breakage class.
    const embed = path.join(project, 'Packages', UCO_UNITY_PACKAGE_ID);
    fs.mkdirSync(path.join(embed, 'Editor', 'Legacy'), { recursive: true });
    const staleCs = path.join(embed, 'Editor', 'Legacy', 'DeviceAuthFlow.cs');
    fs.writeFileSync(staleCs, '// stale: references APIs deleted upstream\n');
    fs.writeFileSync(`${staleCs}.meta`, 'fileFormatVersion: 2\nguid: 2222222222222222222222222222222\n');
    fs.writeFileSync(path.join(embed, 'Editor', 'Legacy', 'Orphan.dll'), 'stale-binary');

    // The extra file counts as drift: refresh must not report `unchanged`.
    expect(pluginSurfaceDiffers(project, source)).toBe(true);

    const result = await callInstallAll({
      unityProjectPath: project,
      pluginSource: source,
      stagedNugetPath: nuget,
      refresh: true,
      skipConfig: true,
    });
    expect(result.kind).toBe('success');
    expect(fs.existsSync(staleCs)).toBe(false);
    expect(fs.existsSync(`${staleCs}.meta`)).toBe(false);
    // The whole source-absent directory is pruned, binary extras included.
    expect(fs.existsSync(path.join(embed, 'Editor', 'Legacy'))).toBe(false);
    // A source-shipped directory survives untouched.
    expect(fs.readFileSync(path.join(embed, 'Runtime', 'Plugin.cs'), 'utf8')).toContain('2.0.0');
    // Post-refresh state matches the bundle: no more drift.
    expect(pluginSurfaceDiffers(project, source)).toBe(false);
  });

  it('keeps the lockfile when the plugin surface is unchanged, deletes it when it changes', async () => {
    const project = unityProject();
    const { source } = pluginSource('1.0.0');
    const nuget = nugetSource('dll');
    await callInstallAll({ unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, refresh: true, skipConfig: true });

    // Unchanged refresh: lockfile survives.
    fs.writeFileSync(lockfilePath(project), '{"locked":true}\n');
    const unchanged = await callInstallAll({
      unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, refresh: true, skipConfig: true,
    });
    expect(unchanged.kind).toBe('success');
    expect(fs.existsSync(lockfilePath(project))).toBe(true);

    // The plugin bundle ships a new version: lockfile resets.
    const upgraded = pluginSource('2.0.0');
    fs.writeFileSync(path.join(upgraded.root, 'Runtime', 'Plugin.cs'), '// 2.0.0\n');
    const changed = await callInstallAll({
      unityProjectPath: project, pluginSource: upgraded.source, stagedNugetPath: nuget, refresh: true, skipConfig: true,
    });
    expect(changed.kind).toBe('success');
    expect(fs.existsSync(lockfilePath(project))).toBe(false);
  });

  it('still deletes the lockfile unconditionally in normal (non-refresh) installs', async () => {
    const project = unityProject();
    const { source } = pluginSource('1.0.0');
    const nuget = nugetSource('dll');
    await callInstallAll({ unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, skipConfig: true });
    fs.writeFileSync(lockfilePath(project), '{"locked":true}\n');

    const again = await callInstallAll({ unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, skipConfig: true });
    expect(again.kind).toBe('success');
    expect(fs.existsSync(lockfilePath(project))).toBe(false);
  });

  it('preserves existing .meta GUIDs while overwriting the DLL binary on re-stage', async () => {
    const project = unityProject();
    const { source } = pluginSource('1.0.0');
    const nuget = nugetSource('v1-dll');
    await callInstallAll({ unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, skipConfig: true });

    // The user's Unity wrote its own .meta with a project-specific GUID.
    const installedMeta = path.join(project, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll.meta');
    fs.writeFileSync(installedMeta, 'fileFormatVersion: 2\nguid: deadbeefdeadbeefdeadbeefdeadbeef\n');

    const upgraded = nugetSource('v2-dll');
    const result = await callInstallAll({
      unityProjectPath: project, pluginSource: source, stagedNugetPath: upgraded, refresh: true, skipConfig: true,
    });
    expect(result.kind).toBe('success');
    expect(fs.readFileSync(path.join(project, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll'), 'utf8')).toBe('v2-dll');
    expect(fs.readFileSync(installedMeta, 'utf8')).toContain('deadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('preserves the UserSettings config byte-for-byte', async () => {
    const project = unityProject();
    const { source } = pluginSource('1.0.0');
    const nuget = nugetSource('dll');
    fs.mkdirSync(path.join(project, 'UserSettings'), { recursive: true });
    const configPath = path.join(project, 'UserSettings', 'AI-Game-Developer-Config.json');
    fs.writeFileSync(configPath, '{"host":"http://127.0.0.1:9999","token":"keep-me"}\n');

    const result = await callInstallAll({
      unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, refresh: true, skipConfig: true,
    });
    expect(result.kind).toBe('success');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"host":"http://127.0.0.1:9999","token":"keep-me"}\n');
  });

  it('warns about unrecognized package siblings without deleting them (refresh mode)', async () => {
    const project = unityProject();
    const { source } = pluginSource('1.0.0');
    const nuget = nugetSource('dll');
    fs.mkdirSync(path.join(project, 'Packages', `${UCO_UNITY_PACKAGE_ID}.backup-097`), { recursive: true });
    fs.writeFileSync(path.join(project, 'Packages', `${UCO_UNITY_PACKAGE_ID}.backup-097`, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(project, 'Packages', `${UCO_UNITY_PACKAGE_ID}-old-copy`), { recursive: true });
    fs.mkdirSync(path.join(project, 'Packages', 'com.other.package'), { recursive: true });

    const result = await callInstallAll({
      unityProjectPath: project, pluginSource: source, stagedNugetPath: nuget, refresh: true, skipConfig: true,
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    const siblingWarnings = result.warnings.filter((warning) => warning.includes('Possible stale copy'));
    expect(siblingWarnings.length).toBe(2);
    expect(siblingWarnings.join(' ')).toContain(`${UCO_UNITY_PACKAGE_ID}.backup-097`);
    expect(siblingWarnings.join(' ')).toContain(`${UCO_UNITY_PACKAGE_ID}-old-copy`);
    expect(siblingWarnings.join(' ')).not.toContain('com.other.package');
    expect(fs.existsSync(path.join(project, 'Packages', `${UCO_UNITY_PACKAGE_ID}.backup-097`, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'Packages', `${UCO_UNITY_PACKAGE_ID}-old-copy`))).toBe(true);
  });
});

describe('detectPackageSiblings', () => {
  it('matches the package id prefix other than the live directory', () => {
    const project = unityProject();
    for (const name of [UCO_UNITY_PACKAGE_ID, `${UCO_UNITY_PACKAGE_ID}.backup-097`, `${UCO_UNITY_PACKAGE_ID}-old`, 'com.other.package', 'not-a-package']) {
      fs.mkdirSync(path.join(project, 'Packages', name), { recursive: true });
    }
    expect(detectPackageSiblings(project)).toEqual([
      `${UCO_UNITY_PACKAGE_ID}-old`,
      `${UCO_UNITY_PACKAGE_ID}.backup-097`,
    ]);
  });

  it('stays silent when only the live directory exists', () => {
    const project = unityProject();
    fs.mkdirSync(path.join(project, 'Packages', UCO_UNITY_PACKAGE_ID), { recursive: true });
    expect(detectPackageSiblings(project)).toEqual([]);
  });

  it('matches a case-variant sibling name on Windows (exact elsewhere)', () => {
    const project = unityProject();
    // A Windows-created backup with different casing; on a case-sensitive
    // filesystem this is a genuinely different directory and stays unreported.
    const variant = `Com.${UCO_UNITY_PACKAGE_ID.slice(4)}.bak`;
    fs.mkdirSync(path.join(project, 'Packages', variant), { recursive: true });
    expect(detectPackageSiblings(project)).toEqual(process.platform === 'win32' ? [variant] : []);
  });
});

describe('recording the unity surface (uco install / create-project)', () => {
  it.each([
    [UNITY_SOURCE_BUNDLE, UNITY_SOURCE_BUNDLE],
    ['file:C:/dev/fork', 'file:C:/dev/fork'],
    ['git:https://example.test/plugin.git', 'git:https://example.test/plugin.git'],
    ['1.4.2', '1.4.2'],
  ])('records source %s verbatim', (source) => {
    const project = unityProject();
    recordUnityInInstallManifest(project, { installed: true, source, projectPath: project });
    expect(readInstallManifest(project).manifest!.unity).toEqual({ installed: true, source, projectPath: project });
  });

  it('merges into an existing manifest without clobbering the agents list', () => {
    const project = unityProject();
    recordUnityInInstallManifest(project, { installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: project });
    // A later init wrote agents into the same manifest.
    fs.mkdirSync(path.join(project, '.uco'), { recursive: true });
    const manifestPath = path.join(project, '.uco', 'install-manifest.json');
    const current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    current.agents = [{ id: 'claude-code', skillsPath: '.claude/skills' }];
    fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2) + '\n');

    // A re-install updates only the unity section.
    recordUnityInInstallManifest(project, { installed: true, source: 'file:D:/other', projectPath: project });
    const read = readInstallManifest(project).manifest!;
    expect(read.agents).toEqual([{ id: 'claude-code', skillsPath: '.claude/skills' }]);
    expect(read.unity).toEqual({ installed: true, source: 'file:D:/other', projectPath: project });
  });
});

describe('create-project manifest recording guard', () => {
  /** Minimal lifecycle session: creation is a no-op (scripted caller). */
  function fakeLifecycleSession(): UnityLifecycleSession {
    return {
      backend: 'unity-cli',
      unityCliPath: '/tools/unity',
      validateCreateOptions: vi.fn(),
      listInstalledEditors: vi.fn(async () => []),
      createProject: vi.fn(async () => undefined),
    } as unknown as UnityLifecycleSession;
  }

  function fakePluginInstaller() {
    return vi.fn(async () => ({
      kind: 'success' as const,
      success: true as const,
      installedVersion: '1.2.3',
      manifestPath: '<project>/Packages/manifest.json',
      modified: true,
      warnings: [],
      nextSteps: [],
    }));
  }

  it('records the manifest when the created project looks like a Unity project', async () => {
    const project = temporaryDirectory('uco-create-record-');
    fs.mkdirSync(path.join(project, 'Packages'), { recursive: true });

    const result = await executeCreateProject(project, { unity: '6000.5.6f1' }, fakeLifecycleSession(), fakePluginInstaller());

    expect(result).toMatchObject({ created: true, plugin: { status: 'installed', version: '1.2.3' } });
    expect(readInstallManifest(project).manifest!.unity).toEqual({
      installed: true,
      source: '1.2.3',
      projectPath: project,
    });
  });

  it('skips the recording for a path that is not a real Unity project', async () => {
    // Reproduces the scripted-caller shape: a relative "project" path whose
    // directory was never actually created on disk.
    const stray = path.resolve('NotAUnityProject');
    try {
      const result = await executeCreateProject(
        'NotAUnityProject',
        { unity: '6000.5.6f1' },
        fakeLifecycleSession(),
        fakePluginInstaller(),
      );

      expect(result).toMatchObject({ created: true, plugin: { status: 'installed' } });
      // No `.uco/` litter at the resolved path (or anywhere else).
      expect(fs.existsSync(path.join(stray, '.uco'))).toBe(false);
      expect(fs.existsSync(stray)).toBe(false);
    } finally {
      fs.rmSync(stray, { recursive: true, force: true });
    }
  });
});
