import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installStaticSkillBundle,
  setupSkillBundle,
  loadToolsFromManifest,
  resolvePluginManifestPath,
} from '../src/skills/bundle.js';
import {
  installManifestPath,
  readInstallManifest,
  writeInstallManifest,
  INSTALL_MANIFEST_SCHEMA_VERSION,
  getUcoVersion,
  UNITY_SOURCE_BUNDLE,
} from '../src/skills/install-manifest.js';
import { runUpdate } from '../src/devops/lib/update.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryTarget(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-update-flow-'));
  directories.push(directory);
  return directory;
}

const SKILLS_PATH_BY_ID: Record<string, string> = {
  'claude-code': '.claude/skills',
  cursor: '.cursor/skills',
  windsurf: '.windsurf/skills',
};

function installAgents(target: string, ids: string[]): void {
  // Use the same offline tools manifest update resolves, so a fresh install
  // is content-identical to what update would rewrite.
  const tools = loadToolsFromManifest(resolvePluginManifestPath());
  for (const id of ids) {
    installStaticSkillBundle({
      projectPath: target,
      skillsRoot: path.join(target, SKILLS_PATH_BY_ID[id]!),
      runtimeSkillsPath: SKILLS_PATH_BY_ID[ids[0]!]!,
      tools,
    });
  }
  writeInstallManifest(target, {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    ucoVersion: getUcoVersion(),
    updatedAt: new Date().toISOString(),
    agents: ids.map((id) => ({ id, skillsPath: SKILLS_PATH_BY_ID[id]! })),
    unity: { installed: false },
  });
}

function snapshotTree(root: string): Record<string, string> {
  const snap: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) {
        snap[path.relative(root, abs).replace(/\\/g, '/')] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  visit(root);
  return snap;
}

describe('uco update (library)', () => {
  it('refreshes drifted templates for every manifest agent and restamps the version', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code', 'cursor']);
    // Simulate a uco upgrade: a template-installed file drifted on disk.
    const drifted = path.join(target, '.claude', 'skills', 'uco-setup', 'SKILL.md');
    const good = fs.readFileSync(drifted, 'utf8');
    fs.writeFileSync(drifted, 'stale content from an older uco\n');

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.upToDate).toBe(false);
    expect(result.agents.map((agent) => agent.id)).toEqual(['claude-code', 'cursor']);
    const claude = result.agents[0]!;
    expect(claude.status).toBe('updated');
    expect(claude.changedFileCount).toBe(1);
    expect(result.agents[1]!.status).toBe('unchanged');
    expect(fs.readFileSync(drifted, 'utf8')).toBe(good);
    expect(readInstallManifest(target).manifest!.ucoVersion).toBe(getUcoVersion());
  });

  it('second run is a byte-identical no-op ("Already up to date.")', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code', 'cursor']);
    const first = await runUpdate({ targetPath: target });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.upToDate).toBe(true);
    // The first run may restamp nothing (already current) — snapshot after it.
    const before = snapshotTree(target);

    const second = await runUpdate({ targetPath: target });
    expect(second.kind).toBe('success');
    if (second.kind !== 'success') return;
    expect(second.upToDate).toBe(true);
    expect(snapshotTree(target)).toEqual(before);
  });

  it('dry-run writes nothing, including the manifest', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    fs.writeFileSync(
      path.join(target, '.claude', 'skills', 'uco-setup', 'SKILL.md'),
      'stale content\n',
    );
    const before = snapshotTree(target);

    const result = await runUpdate({ targetPath: target, dryRun: true });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.dryRun).toBe(true);
    expect(result.upToDate).toBe(false);
    expect(result.agents[0]!.status).toBe('updated');
    expect(snapshotTree(target)).toEqual(before);
  });

  it('force republishes every manifest agent even when content-identical', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    const skillPath = path.join(target, '.claude', 'skills', 'uco-setup', 'SKILL.md');
    const beforeWrite = fs.statSync(skillPath).mtimeMs;

    const result = await runUpdate({ targetPath: target, force: true });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.upToDate).toBe(false);
    expect(result.agents[0]!.status).toBe('updated');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fs.statSync(skillPath).mtimeMs).toBeGreaterThan(beforeWrite);
  });

  it('fails with a uco init pointer outside any install and writes nothing', async () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.claude'), { recursive: true });

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') return;
    expect(result.error.message).toContain('uco init');
    expect(fs.existsSync(path.join(target, '.uco'))).toBe(false);
  });

  it('isolates per-agent failures and still refreshes the rest', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code', 'cursor']);
    // Break cursor's ownership: an unmanaged file inside a managed skill dir
    // makes the replacement guard refuse that agent.
    fs.writeFileSync(
      path.join(target, '.cursor', 'skills', 'unity-editor', 'user-notes.md'),
      'user content',
    );

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    const cursor = result.agents.find((agent) => agent.id === 'cursor')!;
    const claude = result.agents.find((agent) => agent.id === 'claude-code')!;
    expect(cursor.status).toBe('failed');
    expect(cursor.error).toMatch(/unmanaged/i);
    expect(claude.status).toBe('unchanged');
  });

  it('never onboards a new agent; detection surfaces only as an advisory', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    fs.mkdirSync(path.join(target, '.windsurf'), { recursive: true });

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.newAgentAdvisories.map((advisory) => advisory.id)).toEqual(['windsurf']);
    expect(result.agents.map((agent) => agent.id)).toEqual(['claude-code']);
    expect(fs.readdirSync(path.join(target, '.windsurf'))).toEqual([]);
  });

  it('resolves the manifest relative to an explicit target', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    const elsewhere = temporaryTarget();

    const result = await runUpdate({ targetPath: path.join(target) });
    expect(result.kind).toBe('success');
    const failing = await runUpdate({ targetPath: elsewhere });
    expect(failing.kind).toBe('failure');
  });

  it('reports nothing to update for an empty manifest without a unity record', async () => {
    const target = temporaryTarget();
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: new Date().toISOString(),
      agents: [],
      unity: { installed: false },
    });

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.upToDate).toBe(true);
    expect(result.warnings.join(' ')).toContain('uco init');
  });

  it('seeds the manifest from a pre-manifest install and proceeds in the same run', async () => {
    const target = temporaryTarget();
    installStaticSkillBundle({
      projectPath: target,
      skillsRoot: path.join(target, '.claude', 'skills'),
    });

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.seeded).toBe(true);
    expect(result.seedAgentIds).toEqual(['claude-code']);
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'claude-code', skillsPath: '.claude/skills' },
    ]);
  });

  it('dry-run on a legacy (manifest-less) target plans the seed without persisting it', async () => {
    const target = temporaryTarget();
    installStaticSkillBundle({
      projectPath: target,
      skillsRoot: path.join(target, '.claude', 'skills'),
    });
    const before = snapshotTree(target);

    const result = await runUpdate({ targetPath: target, dryRun: true });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    // The seed was computed in memory so the plan can report the migration…
    expect(result.seeded).toBe(true);
    expect(result.seedAgentIds).toEqual(['claude-code']);
    // …but a dry run writes nothing, the seeded manifest included.
    expect(snapshotTree(target)).toEqual(before);
    expect(fs.existsSync(installManifestPath(target))).toBe(false);

    // The real run then performs the migration.
    const real = await runUpdate({ targetPath: target });
    expect(real.kind).toBe('success');
    expect(fs.existsSync(installManifestPath(target))).toBe(true);
  });

  it('reports "Already up to date." after an upgrade with content-identical templates and writes nothing', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    // The state right after a uco upgrade that shipped no template changes:
    // the manifest still names the older uco, but every managed file
    // already matches the current output.
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: '0.0.1-older-uco',
      updatedAt: '2026-01-01T00:00:00.000Z',
      agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
      unity: { installed: false },
    });
    const before = snapshotTree(target);

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.versionBefore).toBe('0.0.1-older-uco');
    expect(result.versionAfter).toBe(getUcoVersion());
    expect(result.versionBefore).not.toBe(result.versionAfter);
    // Version equality is not part of the no-op decision: the run reports the
    // short-circuit and the version restamp is included in the no-op.
    expect(result.upToDate).toBe(true);
    expect(snapshotTree(target)).toEqual(before);
  });

  it('persists the inferred unity source on an otherwise-quiet run, exactly once', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"1.0.0"}\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'dll-bytes');
    const bundleOpts = {
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    };

    installAgents(target, ['claude-code']);
    fs.mkdirSync(path.join(target, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Packages', 'manifest.json'), JSON.stringify({
      dependencies: { 'com.atelierai.unity.copilot': 'file:./com.atelierai.unity.copilot' },
    }, null, 2) + '\n');
    // Stage the matched set once (a bundle-sourced manifest) so a later run
    // can be fully quiet.
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: new Date().toISOString(),
      agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
      unity: { installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: target },
    });
    await runUpdate({ targetPath: target, ...bundleOpts });
    // A hand-edited legacy record: unity installed, source dropped.
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: '2026-01-01T00:00:00.000Z',
      agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
      unity: { installed: true, projectPath: target },
    });

    const quiet = await runUpdate({ targetPath: target, ...bundleOpts });
    expect(quiet.kind).toBe('success');
    if (quiet.kind !== 'success') return;
    expect(quiet.unity.status).toBe('unchanged');
    expect(quiet.upToDate).toBe(true);
    // The inference persisted even though the run wrote no content — it is a
    // manifest-only field heal, not a content write.
    expect(readInstallManifest(target).manifest!.unity.source).toBe(UNITY_SOURCE_BUNDLE);

    // "Runs at most once" is literal: the next quiet run writes nothing at all.
    const before = snapshotTree(target);
    const second = await runUpdate({ targetPath: target, ...bundleOpts });
    expect(second.kind === 'success' && second.upToDate).toBe(true);
    expect(snapshotTree(target)).toEqual(before);
  });

  it('does not persist the inferred unity source under --dry-run', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"1.0.0"}\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'dll-bytes');
    const bundleOpts = {
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    };

    installAgents(target, ['claude-code']);
    fs.mkdirSync(path.join(target, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Packages', 'manifest.json'), JSON.stringify({
      dependencies: { 'com.atelierai.unity.copilot': 'file:./com.atelierai.unity.copilot' },
    }, null, 2) + '\n');
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: new Date().toISOString(),
      agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
      unity: { installed: true, source: UNITY_SOURCE_BUNDLE, projectPath: target },
    });
    await runUpdate({ targetPath: target, ...bundleOpts });
    // The same hand-edited sourceless record, inspected read-only.
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: '2026-01-01T00:00:00.000Z',
      agents: [{ id: 'claude-code', skillsPath: '.claude/skills' }],
      unity: { installed: true, projectPath: target },
    });
    const before = snapshotTree(target);

    const result = await runUpdate({ targetPath: target, dryRun: true, ...bundleOpts });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.dryRun).toBe(true);
    expect(snapshotTree(target)).toEqual(before);
    expect(readInstallManifest(target).manifest!.unity.source).toBeUndefined();
  });
});

describe('uco update live-catalog preservation', () => {
  it('refreshes runtime scripts but leaves live catalog content in place', async () => {
    const target = temporaryTarget();
    // Install static first (creates the runtime + ownership manifests).
    installStaticSkillBundle({
      projectPath: target,
      skillsRoot: path.join(target, '.claude', 'skills'),
    });
    // Then simulate a live setup-skills run over the same runtime: it writes
    // the live-only catalog marker and a richer managed set (scripts + prompts).
    await setupSkillBundle({
      projectPath: target,
      skillsPath: '.claude/skills',
      tools: [{ name: 'scene-create', enabled: true }],
      prompts: [],
      resources: [],
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const runtime = path.join(target, '.uco', 'agent-runtime');
    expect(fs.existsSync(path.join(runtime, 'catalog', 'project.json'))).toBe(true);
    const liveTools = fs.readFileSync(path.join(runtime, 'catalog', 'tools.json'), 'utf8');
    // Simulate a uco upgrade drifting the runtime script.
    fs.writeFileSync(path.join(runtime, 'scripts', 'uco.mjs'), '// stale script\n');

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.runtime.liveCatalogPreserved).toBe(true);
    expect(result.runtime.status).toBe('updated');
    expect(result.runtime.changedFileCount).toBe(1);
    // Live catalog content untouched; script refreshed from the template.
    expect(fs.readFileSync(path.join(runtime, 'catalog', 'tools.json'), 'utf8')).toBe(liveTools);
    const template = fs.readFileSync(
      path.resolve('skills/unity-editor/scripts/uco.mjs'),
      'utf8',
    );
    expect(fs.readFileSync(path.join(runtime, 'scripts', 'uco.mjs'), 'utf8')).toBe(template);
    // And a second run is quiet.
    const second = await runUpdate({ targetPath: target });
    expect(second.kind === 'success' && second.upToDate).toBe(true);
  });
});

describe('uco update MCP config reconciliation', () => {
  function writeProjectConfig(projectPath: string): { host: string; token: string } {
    fs.mkdirSync(path.join(projectPath, 'UserSettings'), { recursive: true });
    const host = 'http://127.0.0.1:23456';
    const token = 'test-token-value';
    fs.writeFileSync(
      path.join(projectPath, 'UserSettings', 'AI-Game-Developer-Config.json'),
      JSON.stringify({ host, token, authOption: 'required', timeoutMs: 10000 }, null, 2) + '\n',
    );
    return { host, token };
  }

  it('writes the managed entry for every manifest agent and preserves unrelated content', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code', 'cursor']);
    const { host, token } = writeProjectConfig(target);
    // Pre-existing user content in the claude config must survive.
    fs.mkdirSync(path.dirname(path.join(target, '.mcp.json')), { recursive: true });
    fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'other-server': { command: 'other', args: ['--flag'] },
      },
      customUserKey: { nested: true },
    }, null, 2) + '\n');

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.configSync.status).toBe('synced');
    expect(result.configSync.restartReminder).toBe(true);
    const claude = result.configSync.agents.find((agent) => agent.id === 'claude-code')!;
    const cursor = result.configSync.agents.find((agent) => agent.id === 'cursor')!;
    expect(claude.status).toBe('updated');
    expect(cursor.status).toBe('created');

    const claudeConfig = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8')) as Record<string, any>;
    expect(claudeConfig.mcpServers['ai-game-developer']).toMatchObject({
      type: 'http',
      url: host,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(claudeConfig.mcpServers['other-server']).toEqual({ command: 'other', args: ['--flag'] });
    expect(claudeConfig.customUserKey).toEqual({ nested: true });

    const cursorConfig = JSON.parse(fs.readFileSync(path.join(target, '.cursor', 'mcp.json'), 'utf8')) as Record<string, any>;
    expect(cursorConfig.mcpServers['ai-game-developer'].url).toBe(host);
  });

  it('writes 127.0.0.1 into agent MCP configs when the project config says localhost', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    fs.mkdirSync(path.join(target, 'UserSettings'), { recursive: true });
    fs.writeFileSync(
      path.join(target, 'UserSettings', 'AI-Game-Developer-Config.json'),
      JSON.stringify({ host: 'http://localhost:23456', token: 't', authOption: 'required', timeoutMs: 10000 }, null, 2) + '\n',
    );

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    const claudeConfig = JSON.parse(fs.readFileSync(path.join(target, '.mcp.json'), 'utf8')) as Record<string, any>;
    // Third-party agent clients (Claude Code & co.) run on Node too: their
    // fetch resolves localhost to ::1, which per-process proxy rules hijack.
    // The written entry must dial the IPv4 literal; the project config file
    // itself is left untouched.
    expect(claudeConfig.mcpServers['ai-game-developer'].url).toBe('http://127.0.0.1:23456');
    const onDisk = JSON.parse(fs.readFileSync(path.join(target, 'UserSettings', 'AI-Game-Developer-Config.json'), 'utf8')) as { host: string };
    expect(onDisk.host).toBe('http://localhost:23456');
  });

  it('leaves an in-sync config byte-identical and reports it unchanged', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    writeProjectConfig(target);
    await runUpdate({ targetPath: target });
    const configPath = path.join(target, '.mcp.json');
    const afterFirst = fs.readFileSync(configPath, 'utf8');

    const second = await runUpdate({ targetPath: target });
    expect(second.kind).toBe('success');
    if (second.kind !== 'success') return;
    expect(second.configSync.agents[0]!.status).toBe('unchanged');
    expect(second.configSync.restartReminder).toBe(false);
    expect(second.upToDate).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  it('skips with a note when no project config resolves (never fabricates an endpoint)', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.configSync.status).toBe('skipped');
    expect(result.configSync.detail).toContain('uco install');
    expect(fs.existsSync(path.join(target, '.mcp.json'))).toBe(false);
  });

  it('--skip-mcp-config neither reads nor writes any agent config', async () => {
    const target = temporaryTarget();
    installAgents(target, ['claude-code']);
    writeProjectConfig(target);

    const result = await runUpdate({ targetPath: target, skipMcpConfig: true });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.configSync.status).toBe('disabled');
    expect(fs.existsSync(path.join(target, '.mcp.json'))).toBe(false);
  });
});

describe('uco update unity surface', () => {
  function minimalUnityProject(target: string, source: string): void {
    fs.mkdirSync(path.join(target, 'Packages'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Packages', 'manifest.json'), JSON.stringify({
      dependencies: { 'com.atelierai.unity.copilot': source },
    }, null, 2) + '\n');
    writeInstallManifest(target, {
      schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
      ucoVersion: getUcoVersion(),
      updatedAt: new Date().toISOString(),
      agents: [],
      unity: { installed: true, source, projectPath: target },
    });
  }

  it('skips a user-managed source with a note naming it', async () => {
    const target = temporaryTarget();
    minimalUnityProject(target, 'file:C:/dev/my-fork');

    const result = await runUpdate({ targetPath: target });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.unity.status).toBe('skipped');
    expect(result.unity.detail).toContain('file:C:/dev/my-fork');
    expect(result.unity.detail).toContain('uco install');
  });

  it('--skip-unity leaves the Unity project untouched', async () => {
    const target = temporaryTarget();
    minimalUnityProject(target, UNITY_SOURCE_BUNDLE);
    const before = snapshotTree(target);

    const result = await runUpdate({ targetPath: target, skipUnity: true });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.unity.status).toBe('skipped');
    expect(result.unity.detail).toBe('--skip-unity');
    expect(snapshotTree(target)).toEqual(before);
  });

  it('reports no refresh for a bundle-sourced project already matching the bundle', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"1.0.0"}\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'dll-bytes');

    minimalUnityProject(target, UNITY_SOURCE_BUNDLE);
    // Stage the matched set once via update (first run installs from the fake bundle).
    const first = await runUpdate({
      targetPath: target,
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    });
    expect(first.kind).toBe('success');
    if (first.kind !== 'success') return;
    expect(first.unity.status).toBe('refreshed');
    expect(fs.existsSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot', 'package.json'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll'), 'utf8')).toBe('dll-bytes');

    // Second run: bundle unchanged → unity surface unchanged, lockfile kept.
    fs.writeFileSync(path.join(target, 'Packages', 'packages-lock.json'), '{"locked":true}\n');
    const second = await runUpdate({
      targetPath: target,
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    });
    expect(second.kind).toBe('success');
    if (second.kind !== 'success') return;
    expect(second.unity.status).toBe('unchanged');
    expect(fs.existsSync(path.join(target, 'Packages', 'packages-lock.json'))).toBe(true);
  });

  it('heals a hand-edited mismatch by re-staging both surfaces from one bundle', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"2.0.0"}\n');
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'Runtime.cs'), '// v2 runtime\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'v2-dll-bytes');
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll.meta'), 'guid: v2\n');

    minimalUnityProject(target, UNITY_SOURCE_BUNDLE);
    // Hand-edited drift: plugin at v1 while the DLLs are ancient.
    fs.mkdirSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot', 'package.json'), '{"version":"1.0.0"}\n');
    fs.mkdirSync(path.join(target, 'Assets', 'Plugins', 'NuGet'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll'), 'ancient-dll');
    fs.writeFileSync(path.join(target, 'Assets', 'Plugins', 'NuGet', 'packages-lock.json'), '{"stale":true}\n');
    fs.writeFileSync(path.join(target, 'Packages', 'packages-lock.json'), '{"locked":true}\n');

    const result = await runUpdate({
      targetPath: target,
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.unity.status).toBe('refreshed');
    // Both surfaces now come from the one bundle (matched set).
    expect(fs.readFileSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot', 'package.json'), 'utf8'))
      .toContain('2.0.0');
    expect(fs.readFileSync(path.join(target, 'Assets', 'Plugins', 'NuGet', 'System.Text.Json.dll'), 'utf8'))
      .toBe('v2-dll-bytes');
    // Lockfile reset happened because the plugin changed.
    expect(fs.existsSync(path.join(target, 'Packages', 'packages-lock.json'))).toBe(false);
  });

  it('removes project-level framework DLLs superseded by the package-embedded set', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"1.0.1"}\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'ext-dll\n');

    minimalUnityProject(target, UNITY_SOURCE_BUNDLE);
    // Legacy layout: the framework trio still sitting in the project's NuGet dir.
    const nugetDir = path.join(target, 'Assets', 'Plugins', 'NuGet');
    fs.mkdirSync(nugetDir, { recursive: true });
    for (const name of ['ReflectorNet.dll', 'Uco.Framework.dll', 'Uco.Framework.Common.dll']) {
      fs.writeFileSync(path.join(nugetDir, name), 'stale-local-dll');
      fs.writeFileSync(path.join(nugetDir, name + '.meta'), 'guid: stale\n');
    }

    const result = await runUpdate({
      targetPath: target,
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    // External DLL staged; the relocated trio is gone from the project level.
    expect(fs.existsSync(path.join(nugetDir, 'System.Text.Json.dll'))).toBe(true);
    expect(fs.existsSync(path.join(nugetDir, 'Uco.Framework.dll'))).toBe(false);
    expect(fs.existsSync(path.join(nugetDir, 'ReflectorNet.dll'))).toBe(false);
    expect(fs.existsSync(path.join(nugetDir, 'Uco.Framework.Common.dll.meta'))).toBe(false);
  });

  it('warns about stale package siblings without deleting them', async () => {
    const target = temporaryTarget();
    const fakeBundle = temporaryTarget();
    fs.mkdirSync(path.join(fakeBundle, 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'plugin', 'package.json'), '{"version":"1.0.0"}\n');
    fs.mkdirSync(path.join(fakeBundle, 'nuget'), { recursive: true });
    fs.writeFileSync(path.join(fakeBundle, 'nuget', 'System.Text.Json.dll'), 'dll-bytes');

    minimalUnityProject(target, UNITY_SOURCE_BUNDLE);
    fs.mkdirSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot.backup-097'), { recursive: true });
    fs.writeFileSync(
      path.join(target, 'Packages', 'com.atelierai.unity.copilot.backup-097', 'package.json'),
      '{"version":"0.9.7"}\n',
    );

    const result = await runUpdate({
      targetPath: target,
      pluginSourcePath: path.join(fakeBundle, 'plugin'),
      nugetSourcePath: path.join(fakeBundle, 'nuget'),
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.warnings.join(' ')).toContain('com.atelierai.unity.copilot.backup-097');
    expect(fs.existsSync(path.join(target, 'Packages', 'com.atelierai.unity.copilot.backup-097', 'package.json'))).toBe(true);
  });
});
