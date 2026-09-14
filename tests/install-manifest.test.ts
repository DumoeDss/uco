import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installStaticSkillBundle } from '../src/skills/bundle.js';
import {
  INSTALL_MANIFEST_SCHEMA_VERSION,
  UNITY_SOURCE_BUNDLE,
  computeInstallSeed,
  getUcoVersion,
  inferUnitySource,
  installManifestPath,
  readInstallManifest,
  readOrSeedInstallManifest,
  recordUnityInInstallManifest,
  removeDeselectedAgentSkills,
  writeInstallManifest,
  type InstallManifest,
} from '../src/skills/install-manifest.js';
import { UCO_UNITY_PACKAGE_ID } from '../src/devops/utils/manifest.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryTarget(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-install-manifest-'));
  directories.push(directory);
  return directory;
}

function sampleManifest(overrides: Partial<InstallManifest> = {}): InstallManifest {
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    ucoVersion: getUcoVersion(),
    updatedAt: '2026-09-09T00:00:00.000Z',
    agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
    unity: { installed: false },
    ...overrides,
  };
}

function seedValidInstall(target: string, skillsPath: string): void {
  installStaticSkillBundle({ projectPath: target, skillsRoot: path.join(target, skillsPath) });
}

function writeUnityProjectManifest(target: string, dependency: string): void {
  fs.mkdirSync(path.join(target, 'Packages'), { recursive: true });
  fs.writeFileSync(
    path.join(target, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { [UCO_UNITY_PACKAGE_ID]: dependency } }, null, 2) + '\n',
  );
}

describe('install manifest writer and reader', () => {
  it('round-trips a manifest as canonical JSON with a trailing newline', () => {
    const target = temporaryTarget();
    writeInstallManifest(target, sampleManifest());

    const manifestPath = installManifestPath(target);
    const raw = fs.readFileSync(manifestPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.startsWith('{\n  "agents"')).toBe(true); // canonical: sorted keys, 2-space indent
    expect(fs.readdirSync(path.join(target, '.uco')).filter((entry) => entry.includes('.tmp'))).toEqual([]);

    const read = readInstallManifest(target);
    expect(read.warnings).toEqual([]);
    expect(read.manifest).toEqual(sampleManifest());
  });

  it('drops unknown agent ids with a warning and keeps the survivors', () => {
    const target = temporaryTarget();
    writeInstallManifest(target, sampleManifest({
      agents: [
        { id: 'claude-code', skillsPath: '.claude/skills' },
        { id: 'windsurf-legacy', skillsPath: '.windsurf/skills' },
      ],
    }));

    const read = readInstallManifest(target);
    expect(read.manifest!.agents).toEqual([{ id: 'claude-code', skillsPath: '.claude/skills' }]);
    expect(read.warnings.join(' ')).toContain('windsurf-legacy');
  });

  it('drops agents that exist in the registry but do not support skills', () => {
    const target = temporaryTarget();
    writeInstallManifest(target, sampleManifest({
      agents: [{ id: 'claude-desktop', skillsPath: '.claude/skills' }],
    }));

    const read = readInstallManifest(target);
    expect(read.manifest!.agents).toEqual([]);
    expect(read.warnings.join(' ')).toContain('claude-desktop');
  });

  it('tolerates a minimal older manifest with absent optional fields', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.uco'), { recursive: true });
    fs.writeFileSync(
      installManifestPath(target),
      JSON.stringify({ agents: [{ id: 'cursor' }] }) + '\n',
    );

    const read = readInstallManifest(target);
    expect(read.warnings).toEqual([]);
    expect(read.manifest!.agents).toEqual([{ id: 'cursor', skillsPath: '.cursor/skills' }]);
    expect(read.manifest!.unity).toEqual({ installed: false });
    expect(read.manifest!.schemaVersion).toBe(INSTALL_MANIFEST_SCHEMA_VERSION);
  });

  it('treats a non-array agents field and an unparseable file as warnings, not errors', () => {
    const malformed = temporaryTarget();
    fs.mkdirSync(path.join(malformed, '.uco'), { recursive: true });
    fs.writeFileSync(installManifestPath(malformed), JSON.stringify({ agents: 'nope' }) + '\n');
    const nonArray = readInstallManifest(malformed);
    expect(nonArray.manifest!.agents).toEqual([]);
    expect(nonArray.warnings.length).toBe(1);

    const corrupt = temporaryTarget();
    fs.mkdirSync(path.join(corrupt, '.uco'), { recursive: true });
    fs.writeFileSync(installManifestPath(corrupt), '{not json');
    const unparseable = readInstallManifest(corrupt);
    expect(unparseable.manifest).toBeUndefined();
    expect(unparseable.warnings.length).toBe(1);
  });

  it('records the skills-path override verbatim', () => {
    const target = temporaryTarget();
    writeInstallManifest(target, sampleManifest({
      agents: [{ id: 'claude-code', skillsPath: '.claude/my-skills' }],
    }));

    expect(readInstallManifest(target).manifest!.agents[0]!.skillsPath).toBe('.claude/my-skills');
  });
});

describe('one-time migration seed', () => {
  it('seeds from an existing uco-owned install and proceeds with it', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.claude', 'skills'));

    const result = readOrSeedInstallManifest(target);
    expect(result.seeded).toBe(true);
    expect(result.seedAgentIds).toEqual(['claude-code']);
    expect(result.manifest!.agents).toEqual([{ id: 'claude-code', skillsPath: '.claude/skills' }]);
    expect(fs.existsSync(installManifestPath(target))).toBe(true);
  });

  it('seeds multiple agents and infers the unity record from the package manifest', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.claude', 'skills'));
    seedValidInstall(target, path.join('.cursor', 'skills'));
    writeUnityProjectManifest(target, `file:./${UCO_UNITY_PACKAGE_ID}`);

    const result = readOrSeedInstallManifest(target);
    expect(result.seedAgentIds).toEqual(['claude-code', 'cursor']);
    expect(result.manifest!.unity).toEqual({ installed: true, source: 'bundle', projectPath: target });
  });

  it('is idempotent: a present manifest is never re-seeded from disk', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.claude', 'skills'));
    readOrSeedInstallManifest(target);
    const afterFirst = fs.readFileSync(installManifestPath(target), 'utf8');

    // A new on-disk uco install appears afterwards.
    seedValidInstall(target, path.join('.cursor', 'skills'));
    const second = readOrSeedInstallManifest(target);
    expect(second.seeded).toBe(false);
    expect(second.manifest!.agents.map((agent) => agent.id)).toEqual(['claude-code']);
    expect(fs.readFileSync(installManifestPath(target), 'utf8')).toBe(afterFirst);
  });

  it('writes nothing when the target has no uco-owned artifacts', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(target, '.claude', 'settings.json'), '{}\n');

    const result = readOrSeedInstallManifest(target);
    expect(result.manifest).toBeUndefined();
    expect(result.seeded).toBe(false);
    expect(fs.existsSync(path.join(target, '.uco'))).toBe(false);
  });

  it('fails open when the manifest path is unwritable', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.claude', 'skills'));
    // Seeding already created `.uco/`; block the manifest slot itself with a
    // directory so the atomic rename cannot land.
    fs.mkdirSync(installManifestPath(target), { recursive: true });

    const result = readOrSeedInstallManifest(target);
    expect(result.seeded).toBe(true);
    expect(result.manifest!.agents.map((agent) => agent.id)).toEqual(['claude-code']);
    expect(result.warnings.join(' ')).toContain(installManifestPath(target));
  });

  it('seeds unity alone for a Unity project without agent skills', () => {
    const target = temporaryTarget();
    writeUnityProjectManifest(target, '1.2.3');

    const seed = computeInstallSeed(target);
    expect(seed.agents).toEqual([]);
    expect(seed.unity).toEqual({ installed: true, source: '1.2.3', projectPath: target });
  });

  it.each([
    ['file:./com.atelierai.unity.copilot', 'bundle'],
    ['file:com.atelierai.unity.copilot', 'bundle'],
    ['file:C:/dev/plugin', 'file:C:/dev/plugin'],
    ['git+https://example.test/plugin.git', 'git:https://example.test/plugin.git'],
    ['https://example.test/plugin.git', 'git:https://example.test/plugin.git'],
    ['2.0.0', '2.0.0'],
  ])('infers source %s -> %s', (dependency, expected) => {
    expect(inferUnitySource(dependency)).toBe(expected);
  });
});

describe('deselection cleanup', () => {
  it('removes only the deselected agent and keeps the shared runtime', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.claude', 'skills'));
    seedValidInstall(target, path.join('.cursor', 'skills'));

    const result = removeDeselectedAgentSkills(target, [
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);

    expect(result.removedAgents).toEqual(['cursor']);
    expect(result.warnings).toEqual([]);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'uco-setup'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'unity-editor'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.claude', 'skills', 'uco-setup'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.uco', 'agent-runtime', 'bundle-manifest.json'))).toBe(true);
  });

  it('refuses to remove a directory with unmanaged user content, removes only managed siblings', () => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.cursor', 'skills'));
    fs.writeFileSync(
      path.join(target, '.cursor', 'skills', 'unity-editor', 'user-notes.md'),
      'hand-written',
    );

    const result = removeDeselectedAgentSkills(target, [
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);

    // Per-directory granularity: the managed directories go, the one holding
    // unmanaged user content stays with a warning naming it.
    expect(result.removedAgents).toEqual(['cursor']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('.cursor/skills/unity-editor');
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'unity-editor'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'uco-setup'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'unity-cli'))).toBe(false);
  });

  it('refuses a uco-named directory without any ownership manifest', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.cursor', 'skills', 'uco-setup'), { recursive: true });
    fs.writeFileSync(path.join(target, '.cursor', 'skills', 'uco-setup', 'SKILL.md'), 'user content');

    const result = removeDeselectedAgentSkills(target, [
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);

    expect(result.removedAgents).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'uco-setup'))).toBe(true);
  });

  it('refuses an unsafe skills path from a hand-edited manifest', () => {
    const target = temporaryTarget();
    const innocent = temporaryTarget();
    fs.mkdirSync(path.join(target, 'elsewhere', 'skills', 'uco-setup'), { recursive: true });

    const result = removeDeselectedAgentSkills(target, [
      { id: 'cursor', skillsPath: '../elsewhere/skills' },
    ]);

    expect(result.removedAgents).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(fs.existsSync(path.join(target, 'elsewhere', 'skills', 'uco-setup'))).toBe(true);
    expect(fs.readdirSync(innocent)).toEqual([]);
  });

  it('keeps a skills directory shared with a surviving agent', () => {
    const target = temporaryTarget();
    // `.github/skills` is shared by vscode-copilot / vs-copilot / github-copilot-cli.
    seedValidInstall(target, path.join('.github', 'skills'));
    const entry = (id: string): { id: string; skillsPath: string } => ({ id, skillsPath: '.github/skills' });

    const result = removeDeselectedAgentSkills(
      target,
      [entry('vscode-copilot')],
      [entry('github-copilot-cli')],
    );

    // The deselected agent's directories stay: the survivor records the same
    // path and owns them now.
    expect(result.removedAgents).toEqual([]);
    expect(result.removedDirectories).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('github-copilot-cli');
    expect(fs.existsSync(path.join(target, '.github', 'skills', 'uco-setup'))).toBe(true);

    // Without a surviving sharer the same path is cleaned up as usual.
    const unshared = removeDeselectedAgentSkills(target, [entry('vscode-copilot')], [
      { id: 'claude-code', skillsPath: '.claude/skills' },
    ]);
    expect(unshared.removedAgents).toEqual(['vscode-copilot']);
    expect(fs.existsSync(path.join(target, '.github', 'skills', 'uco-setup'))).toBe(false);
  });

  it('warns and skips a skill directory containing a symlink instead of crashing', (ctx) => {
    const target = temporaryTarget();
    seedValidInstall(target, path.join('.cursor', 'skills'));
    // An entry the ownership walk cannot classify: a symlink inside a
    // uco-named skill directory.
    const linkTarget = path.join(target, 'link-target.md');
    fs.writeFileSync(linkTarget, 'link target');
    try {
      fs.symlinkSync(linkTarget, path.join(target, '.cursor', 'skills', 'uco-setup', 'link.md'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        // Windows without Developer Mode / admin cannot create symlinks.
        ctx.skip();
        return;
      }
      throw error;
    }

    const result = removeDeselectedAgentSkills(target, [
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);

    // The unverifiable directory is refused with a warning, its managed
    // siblings are still cleaned up, and nothing crashes.
    expect(result.removedAgents).toEqual(['cursor']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('.cursor/skills/uco-setup');
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'uco-setup'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'unity-cli'))).toBe(false);
  });
});

describe('recordUnityInInstallManifest', () => {
  it('creates the manifest with an empty agent list when none exists', () => {
    const target = temporaryTarget();
    const outcome = recordUnityInInstallManifest(target, { installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: target });

    expect('manifestPath' in outcome).toBe(true);
    const read = readInstallManifest(target);
    expect(read.manifest!.agents).toEqual([]);
    expect(read.manifest!.unity).toEqual({ installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: target });
  });

  it('preserves existing agents while updating the unity section', () => {
    const target = temporaryTarget();
    writeInstallManifest(target, sampleManifest());
    recordUnityInInstallManifest(target, { installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: target });

    const read = readInstallManifest(target);
    expect(read.manifest!.agents).toEqual([{ id: 'claude-code', skillsPath: '.claude/skills' }]);
    expect(read.manifest!.unity.installed).toBe(true);
  });

  it('fails open with a warning instead of failing the install', () => {
    const target = temporaryTarget();
    fs.writeFileSync(path.join(target, '.uco'), 'not a directory');

    const outcome = recordUnityInInstallManifest(target, { installed: true, source: UNITY_SOURCE_BUNDLE });
    expect('warning' in outcome).toBe(true);
  });
});
