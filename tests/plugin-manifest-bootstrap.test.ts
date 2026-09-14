import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPlugin } from '../src/devops/lib/install-plugin.js';
import {
  addPluginToManifest,
  AtomicManifestReplaceError,
  COCLI_LEGACY_UNITY_PACKAGE_IDS,
  COCLI_OPENUPM_REQUIRED_SCOPES,
  UCO_UNITY_PACKAGE_ID,
  inspectPluginManifest,
  resolveLatestVersion,
  setPluginInManifest,
  shouldUpdateVersion,
  type ManifestFileSystem,
} from '../src/devops/utils/manifest.js';

const directories: string[] = [];

function projectWithManifest(manifest: Record<string, unknown>): {
  project: string;
  manifestPath: string;
} {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-plugin-bootstrap-'));
  directories.push(project);
  const packages = path.join(project, 'Packages');
  fs.mkdirSync(packages);
  const manifestPath = path.join(packages, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { project, manifestPath };
}

function completeManifest(version: string): Record<string, unknown> {
  return {
    dependencies: { [UCO_UNITY_PACKAGE_ID]: version, 'com.example.keep': '9.9.9' },
    scopedRegistries: [{
      name: 'package.openupm.com',
      url: 'https://package.openupm.com',
      scopes: [...COCLI_OPENUPM_REQUIRED_SCOPES, 'com.example.keep'],
    }],
    customField: { nested: true },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('uco install manifest patching', () => {
  it('keeps OpenUPM resolution for embedded plugin dependencies', () => {
    const { project, manifestPath } = projectWithManifest({ dependencies: {} });

    setPluginInManifest(project, { kind: 'embed' });

    const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    expect(updated.scopedRegistries).toContainEqual({
      name: 'package.openupm.com',
      url: 'https://package.openupm.com',
      scopes: ['extensions.unity'],
    });
  });
});

describe('canonical atomic plugin manifest bootstrap', () => {
  it('does not rewrite a semantically satisfied manifest', () => {
    const { project, manifestPath } = projectWithManifest(completeManifest('2.0.0'));
    const original = fs.readFileSync(manifestPath, 'utf8');
    const before = fs.statSync(manifestPath).mtimeMs;
    const result = addPluginToManifest(project, '2.0.0');
    expect(result).toMatchObject({ modified: false, resolvedVersion: '2.0.0' });
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(fs.statSync(manifestPath).mtimeMs).toBe(before);
  });

  it('preserves unrelated values and removes only the legacy dependency on install', () => {
    const legacy = COCLI_LEGACY_UNITY_PACKAGE_IDS[0];
    const { project, manifestPath } = projectWithManifest({
      dependencies: { [legacy]: '1.0.0', 'com.example.keep': 'file:../Keep' },
      scopedRegistries: [{
        name: 'custom.registry',
        url: 'https://registry.example.test',
        scopes: ['com.example'],
      }],
      customField: { untouched: ['yes'] },
    });
    const originalMode = fs.statSync(manifestPath).mode;
    expect(addPluginToManifest(project, '3.0.0')).toMatchObject({
      modified: true,
      resolvedVersion: '3.0.0',
    });
    const updated = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    expect(updated.dependencies).toMatchObject({
      [UCO_UNITY_PACKAGE_ID]: '3.0.0',
      'com.example.keep': 'file:../Keep',
    });
    expect(updated.dependencies).not.toHaveProperty(legacy);
    expect(updated.customField).toEqual({ untouched: ['yes'] });
    expect(updated.scopedRegistries[0]).toEqual({
      name: 'custom.registry',
      url: 'https://registry.example.test',
      scopes: ['com.example'],
    });
    const openUpmRegistry = updated.scopedRegistries.find(
      (registry: { url?: string }) => registry.url === 'https://package.openupm.com',
    );
    expect(openUpmRegistry?.scopes).toContain('com.atelierai');
    expect(UCO_UNITY_PACKAGE_ID.startsWith('com.atelierai.')).toBe(true);
    expect(fs.statSync(manifestPath).mode).toBe(originalMode);
  });

  it('uses an explicit version without registry resolution', async () => {
    const { project } = projectWithManifest({ dependencies: {} });
    const resolve = vi.fn(async () => 'should-not-be-used');
    const result = await installPlugin({ unityProjectPath: project, version: '4.2.0' }, {
      resolveLatestVersion: resolve,
      inspectManifest: (projectPath) => ({
        manifestPath: path.join(projectPath, 'Packages', 'manifest.json'),
        activeSource: undefined,
        activeSourceIsNonSemver: false,
      }),
      addToManifest: (projectPath, version, force) => addPluginToManifest(projectPath, version, force),
    });
    expect(result).toMatchObject({
      kind: 'success',
      installedVersion: '4.2.0',
      modified: true,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['file:../LocalPlugin', 'git+https://example.test/plugin.git', 'https://example.test/plugin.tgz'])
    ('preserves automatic non-semver source %s without registry access', async (source) => {
      const { project, manifestPath } = projectWithManifest(completeManifest(source));
      const resolve = vi.fn(async () => '99.0.0');
      const result = await installPlugin({ unityProjectPath: project }, {
        resolveLatestVersion: resolve,
        inspectManifest: () => ({ manifestPath, activeSource: source, activeSourceIsNonSemver: true }),
        addToManifest: (projectPath, version, force) => addPluginToManifest(projectPath, version, force),
      });
      expect(result).toMatchObject({ kind: 'success', installedVersion: source, modified: false });
      expect(resolve).not.toHaveBeenCalled();
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
      expect(manifest.dependencies[UCO_UNITY_PACKAGE_ID]).toBe(source);
    });

  it('never downgrades an automatically resolved semantic version', async () => {
    const { project, manifestPath } = projectWithManifest(completeManifest('9.0.0'));
    const result = await installPlugin({ unityProjectPath: project }, {
      resolveLatestVersion: vi.fn(async () => '2.0.0'),
      inspectManifest: () => ({ manifestPath, activeSource: '9.0.0', activeSourceIsNonSemver: false }),
      addToManifest: (projectPath, version, force) => addPluginToManifest(projectPath, version, force),
    });
    expect(result).toMatchObject({ kind: 'success', installedVersion: '9.0.0', modified: false });
  });

  it.each([
    ['stable upgrade', '1.9.9', '2.0.0', true],
    ['stable equality', '2.0.0', '2.0.0', false],
    ['prerelease numeric ordering', '2.0.0-beta.10', '2.0.0-beta.2', false],
    ['prerelease numeric upgrade', '2.0.0-beta.2', '2.0.0-beta.10', true],
    ['prerelease equality ignoring build', '2.0.0-beta.2+one', '2.0.0-beta.2+two', false],
    ['numeric before alphanumeric', '2.0.0-1', '2.0.0-alpha', true],
    ['short prerelease before longer', '2.0.0-alpha', '2.0.0-alpha.1', true],
    ['prerelease before release', '2.0.0-rc.1', '2.0.0', true],
    ['release never moves to prerelease', '2.0.0', '2.0.0-rc.2', false],
    ['build metadata has equal precedence', '2.0.0+build.1', '2.0.0+build.2', false],
    ['build metadata does not hide a core upgrade', '2.0.0+build.9', '2.0.1+build.1', true],
    ['build metadata does not hide a core downgrade', '2.0.1+build.1', '2.0.0+build.9', false],
    ['stable downgrade', '3.0.0', '2.99.99', false],
  ])('%s follows complete SemVer precedence', (_label, current, latest, expected) => {
    expect(shouldUpdateVersion(current, latest)).toBe(expected);
  });

  it('accepts a complete SemVer OpenUPM latest value', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest: '2.1.0-beta.3+build.7' },
    }), { status: 200 })));
    await expect(resolveLatestVersion()).resolves.toBe('2.1.0-beta.3+build.7');
  });

  it.each([
    { malformed: true },
    ['1.2.3'],
    123,
    '',
    'not-semver',
    '1.2.3\nmalicious',
  ])('rejects malformed OpenUPM latest payload %j at the registry boundary', async (latest) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    await expect(resolveLatestVersion()).rejects.toThrow('invalid latest plugin version');
  });

  it.each([
    { malformed: true },
    ['1.2.3'],
    123,
    '',
    'not-semver',
    '1.2.3\u0000evil',
  ])('rejects malformed automatic version %j before byte-level manifest mutation', async (latest) => {
    const { project, manifestPath } = projectWithManifest({
      dependencies: { 'com.example.keep': '1.0.0' },
      customField: { formatting: 'must stay byte-for-byte' },
    });
    const original = fs.readFileSync(manifestPath);
    const addToManifest = vi.fn((projectPath: string, version: string, force: boolean) => (
      addPluginToManifest(projectPath, version, force)
    ));
    const result = await installPlugin({ unityProjectPath: project }, {
      resolveLatestVersion: vi.fn(async () => latest as unknown as string),
      inspectManifest: inspectPluginManifest,
      addToManifest,
    });
    expect(result).toMatchObject({ kind: 'failure', success: false });
    expect(result.kind === 'failure' ? result.error.message : '').toContain('invalid latest plugin version');
    expect(addToManifest).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifestPath)).toEqual(original);
  });

  it('keeps original content and cleans the unique temp file when atomic replace fails', () => {
    const { project, manifestPath } = projectWithManifest({ dependencies: {} });
    const original = fs.readFileSync(manifestPath, 'utf8');
    const writtenTemps: string[] = [];
    const removedTemps: string[] = [];
    const fileSystem: ManifestFileSystem = {
      statSync: (filePath) => fs.statSync(filePath),
      writeFileSync: (filePath, content, options) => {
        writtenTemps.push(filePath);
        fs.writeFileSync(filePath, content, options);
      },
      renameSync: () => { throw new Error('injected atomic replacement failure'); },
      unlinkSync: (filePath) => {
        removedTemps.push(filePath);
        fs.unlinkSync(filePath);
      },
    };
    expect(() => addPluginToManifest(project, '1.0.0', false, undefined, fileSystem))
      .toThrow('injected atomic replacement failure');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(writtenTemps).toHaveLength(1);
    expect(removedTemps).toEqual(writtenTemps);
    expect(fs.existsSync(writtenTemps[0]!)).toBe(false);
  });

  it('cleans a partially written temp file when the write itself throws', () => {
    const { project, manifestPath } = projectWithManifest({ dependencies: {} });
    const original = fs.readFileSync(manifestPath, 'utf8');
    let temporaryPath = '';
    const fileSystem: ManifestFileSystem = {
      statSync: (filePath) => fs.statSync(filePath),
      writeFileSync: (filePath, content, options) => {
        temporaryPath = filePath;
        fs.writeFileSync(filePath, content.slice(0, 8), options);
        throw new Error('injected partial write failure');
      },
      renameSync: () => { throw new Error('must not replace'); },
      unlinkSync: (filePath) => fs.unlinkSync(filePath),
    };
    expect(() => addPluginToManifest(project, '1.0.0', false, undefined, fileSystem))
      .toThrow('injected partial write failure');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(temporaryPath).not.toBe('');
    expect(fs.existsSync(temporaryPath)).toBe(false);
  });

  it('surfaces replacement and cleanup failures with the retained temp path', () => {
    const { project, manifestPath } = projectWithManifest({ dependencies: {} });
    const original = fs.readFileSync(manifestPath, 'utf8');
    let temporaryPath = '';
    const replacementError = new Error('injected replacement failure');
    const cleanupError = new Error('injected cleanup refusal');
    const fileSystem: ManifestFileSystem = {
      statSync: (filePath) => fs.statSync(filePath),
      writeFileSync: (filePath, content, options) => {
        temporaryPath = filePath;
        fs.writeFileSync(filePath, content, options);
      },
      renameSync: () => { throw replacementError; },
      unlinkSync: () => { throw cleanupError; },
    };
    let thrown: unknown;
    try {
      addPluginToManifest(project, '1.0.0', false, undefined, fileSystem);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AtomicManifestReplaceError);
    expect(thrown).toMatchObject({
      temporaryPath,
      replacementError,
      cleanupError,
    });
    expect((thrown as Error).message).toContain(temporaryPath);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(original);
    expect(fs.existsSync(temporaryPath)).toBe(true);
    fs.unlinkSync(temporaryPath);
  });
});
