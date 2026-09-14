import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCatalogEntry } from '../src/codegen/types.js';
import {
  DOMAIN_IDS,
  ENTRY_SKILL_IDS,
  classifyTool,
  setupSkillBundle,
} from '../src/skills/bundle.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshotTools(): ToolCatalogEntry[] {
  return JSON.parse(
    fs.readFileSync(path.resolve('src/generated/tools.json'), 'utf8'),
  ) as ToolCatalogEntry[];
}

function generatedSkill(name: string): string {
  return `---\nname: ${name}\ndescription: Legacy generated tool.\n---\n\n# ${name}\n\n## How to Call\n\nuco call ${name}\n`;
}

function writeManagedV1(skillsRoot: string): string {
  const destination = path.join(skillsRoot, 'unity-copilot');
  const manifestPath = path.join(destination, 'catalog', 'bundle-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(path.join(destination, 'SKILL.md'), generatedSkill('unity-copilot'), 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    bundleId: 'uco-unity-progressive-v1',
    managedFiles: ['SKILL.md', 'catalog/bundle-manifest.json'],
  }, null, 2) + '\n', 'utf8');
  return destination;
}

describe('three-surface Unity skill bundle', () => {
  it('publishes exactly three discoverable Skills and one hidden support runtime', async () => {
    const projectPath = temporaryProject();
    const tools = snapshotTools();
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });

    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const skillFiles = fs.readdirSync(skillsRoot, { recursive: true })
      .filter((entry) => path.basename(String(entry)) === 'SKILL.md');
    expect(result.skillEntryCount).toBe(3);
    expect(result.skillIds).toEqual(ENTRY_SKILL_IDS);
    expect(skillFiles.sort()).toEqual(
      ENTRY_SKILL_IDS.map((id) => path.join(id, 'SKILL.md')).sort(),
    );
    expect(result.destinations).toEqual(Object.fromEntries(
      ENTRY_SKILL_IDS.map((id) => [id, path.join(skillsRoot, id)]),
    ));
    expect(result.supportDestination).toBe(
      path.join(projectPath, '.uco', 'agent-runtime'),
    );
    expect(fs.existsSync(path.join(result.supportDestination, 'SKILL.md'))).toBe(false);
  });

  it('preserves every live schema exactly once in shared support', async () => {
    const projectPath = temporaryProject();
    const tools = snapshotTools();
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const installedCatalog = JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    )) as ToolCatalogEntry[];
    expect(installedCatalog).toEqual(
      [...tools].sort((left, right) => left.name.localeCompare(right.name)),
    );
    const index = JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tool-index.json'),
      'utf8',
    )) as Array<{ name: string; domain: string }>;
    expect(index).toHaveLength(tools.length);
    expect(new Set(index.map((entry) => entry.name)).size).toBe(tools.length);
    expect(index.every((entry) => DOMAIN_IDS.includes(entry.domain as never))).toBe(true);
  });

  it('preserves safety metadata in support catalogs and renders descriptive tri-state hints', async () => {
    const projectPath = temporaryProject();
    const tools: ToolCatalogEntry[] = [
      {
        name: 'scene-metadata',
        enabled: false,
        description: 'Metadata fixture.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: null,
        futureSafetyMember: { version: 2 },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          $defs: { Value: { customKeyword: 'retained' } },
        },
      },
      { name: 'scene-legacy', enabled: true },
    ];
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });

    const installed = JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    )) as ToolCatalogEntry[];
    expect(installed[1]).toMatchObject({
      name: 'scene-metadata',
      destructiveHint: false,
      idempotentHint: null,
      futureSafetyMember: { version: 2 },
      inputSchema: {
        additionalProperties: false,
        $defs: { Value: { customKeyword: 'retained' } },
      },
    });

    const index = JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tool-index.json'),
      'utf8',
    )) as Array<Record<string, unknown>>;
    expect(Object.hasOwn(index[0]!, 'readOnlyHint')).toBe(false);
    expect(index[1]).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
    });
    expect(Object.hasOwn(index[1]!, 'openWorldHint')).toBe(false);

    const authoring = fs.readFileSync(path.join(
      result.destinations['unity-editor'], 'references', 'authoring.md',
    ), 'utf8');
    expect(authoring).toContain(
      '**Safety hints (descriptive):** readOnlyHint=unknown, destructiveHint=unknown, idempotentHint=unknown, openWorldHint=unknown',
    );
    expect(authoring).toContain(
      '**Safety hints (descriptive):** readOnlyHint=true, destructiveHint=false, idempotentHint=unknown, openWorldHint=unknown',
    );
  });

  it('produces identical outputs for shuffled catalog and object-key order', async () => {
    const firstProject = temporaryProject();
    const secondProject = temporaryProject();
    const firstTools: ToolCatalogEntry[] = [
      { name: 'scene-z', enabled: true, inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'boolean' } } } },
      { name: 'scene-a', enabled: false, destructiveHint: false },
    ];
    const secondTools: ToolCatalogEntry[] = [
      { destructiveHint: false, enabled: false, name: 'scene-a' },
      { inputSchema: { properties: { a: { type: 'boolean' }, z: { type: 'string' } }, type: 'object' }, enabled: true, name: 'scene-z' },
    ];
    const first = await setupSkillBundle({
      projectPath: firstProject,
      skillsPath: '.agents/skills',
      tools: firstTools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const second = await setupSkillBundle({
      projectPath: secondProject,
      skillsPath: '.agents/skills',
      tools: secondTools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });

    expect(fs.readFileSync(path.join(first.supportDestination, 'catalog', 'tools.json'), 'utf8'))
      .toBe(fs.readFileSync(path.join(second.supportDestination, 'catalog', 'tools.json'), 'utf8'));
    expect(fs.readFileSync(path.join(first.destinations['unity-editor'], 'references', 'authoring.md'), 'utf8'))
      .toBe(fs.readFileSync(path.join(second.destinations['unity-editor'], 'references', 'authoring.md'), 'utf8'));
  });

  it('routes live build/test tools separately from official process workflows', () => {
    expect(classifyTool('build-player')).toBe('build-and-tests');
    expect(classifyTool('tests-run')).toBe('build-and-tests');
    expect(classifyTool('scene-open')).toBe('authoring');
    expect(classifyTool('script-read')).toBe('code');
    expect(classifyTool('assets-shader-get-data')).toBe('visuals');
    expect(classifyTool('physics-raycast')).toBe('physics');
    expect(classifyTool('profiler-get-counters')).toBe('diagnostics');
    expect(classifyTool('third-party-surprise')).toBe('diagnostics');
  });

  it('keeps each trigger focused and schemas out of all Skill metadata', async () => {
    const projectPath = temporaryProject();
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const contents = Object.fromEntries(ENTRY_SKILL_IDS.map((id) => [
      id,
      fs.readFileSync(path.join(result.destinations[id], 'SKILL.md'), 'utf8'),
    ]));
    for (const skill of Object.values(contents)) {
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      expect(frontmatter).not.toContain('inputSchema');
      expect(frontmatter).not.toContain('$defs');
    }
    expect(contents['uco-setup']).toContain('setup-skills');
    expect(contents['uco-setup']).not.toContain('physics-raycast');
    expect(contents['unity-cli']).toContain('unity <command> --help');
    expect(contents['unity-cli']).toContain('unity auth');
    expect(contents['unity-editor']).toContain('Requires a ready');
    for (const domain of DOMAIN_IDS) {
      expect(contents['unity-editor']).toContain(`references/${domain}.md`);
      expect(fs.existsSync(path.join(
        result.destinations['unity-editor'], 'references', `${domain}.md`,
      ))).toBe(true);
    }
  });

  it('renders full tool definitions (name + description + parameters) in domain references', async () => {
    const projectPath = temporaryProject();
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const authoring = fs.readFileSync(path.join(
      result.destinations['unity-editor'], 'references', 'authoring.md',
    ), 'utf8');
    // Full definitions: tool name + description + parameter table are all inlined
    // so the agent reads one domain reference and knows how to call every tool in it,
    // without per-tool tool-info lookups.
    expect(authoring).toContain('`gameobject-create`');
    expect(authoring).toContain('Create a new GameObject');
    expect(authoring).toContain('**Parameters:**');
  });

  it('supports a side-effect-free dry run across both output roots', async () => {
    const projectPath = temporaryProject();
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
      dryRun: true,
    });
    expect(result.status).toBe('would-change');
    expect(result.written.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(projectPath, '.agents'))).toBe(false);
    expect(fs.existsSync(path.join(projectPath, '.uco'))).toBe(false);
  });

  it('rejects an empty catalog instead of publishing partial entries', async () => {
    await expect(setupSkillBundle({
      projectPath: temporaryProject(),
      skillsPath: '.agents/skills',
      tools: [],
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    })).rejects.toThrow(/catalog is empty/i);
  });

  it('migrates a managed v1 bundle after publishing v2', async () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const v1 = writeManagedV1(skillsRoot);
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    expect(fs.existsSync(v1)).toBe(false);
    expect(result.removed).toContain('unity-copilot');
    expect(result.skillEntryCount).toBe(3);
  });

  it('migrates only recognizable legacy leaf Skills and preserves user content', async () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const legacy = path.join(skillsRoot, 'scene-open');
    const customized = path.join(skillsRoot, 'script-read');
    fs.mkdirSync(legacy, { recursive: true });
    fs.mkdirSync(customized, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), generatedSkill('scene-open'), 'utf8');
    fs.writeFileSync(path.join(customized, 'SKILL.md'), generatedSkill('script-read'), 'utf8');
    fs.writeFileSync(path.join(customized, 'notes.md'), 'keep me\n', 'utf8');
    const result = await setupSkillBundle({
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
      migrateLegacy: true,
    });
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(customized)).toBe(true);
    expect(result.removed).toContain('scene-open');
    expect(result.preserved).toContain('script-read');
  });

  it('adopts pre-rename cocli markers, overwrites in place, and removes the renamed cocli-setup entry', async () => {
    const projectPath = temporaryProject();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
      migrateLegacy: true,
    };
    await setupSkillBundle(options);
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    // Age every ownership marker to the pre-rename bundle id, then rename the
    // uco-setup entry to its old cocli-setup name — the exact on-disk state
    // left behind by cocli 0.2.x installs.
    for (const skillId of ENTRY_SKILL_IDS) {
      const markerPath = path.join(skillsRoot, skillId, '.uco-skill.json');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      marker.bundleId = 'cocli-unity-three-surface-v2';
      fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    }
    fs.renameSync(path.join(skillsRoot, 'uco-setup'), path.join(skillsRoot, 'cocli-setup'));

    const result = await setupSkillBundle(options);
    expect(fs.existsSync(path.join(skillsRoot, 'uco-setup'))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, 'cocli-setup'))).toBe(false);
    expect(result.removed).toContain('cocli-setup');
    const marker = JSON.parse(
      fs.readFileSync(path.join(skillsRoot, 'unity-cli', '.uco-skill.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(marker.bundleId).toBe('uco-unity-three-surface-v2');
  });

  it('preserves a renamed cocli-setup entry when it carries user-added files', async () => {
    const projectPath = temporaryProject();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
      migrateLegacy: true,
    };
    await setupSkillBundle(options);
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const oldEntry = path.join(skillsRoot, 'uco-setup');
    const markerPath = path.join(oldEntry, '.uco-skill.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.bundleId = 'cocli-unity-three-surface-v2';
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    fs.renameSync(oldEntry, path.join(skillsRoot, 'cocli-setup'));
    fs.writeFileSync(path.join(skillsRoot, 'cocli-setup', 'notes.md'), 'keep me\n', 'utf8');

    const result = await setupSkillBundle(options);
    expect(fs.existsSync(path.join(skillsRoot, 'cocli-setup'))).toBe(true);
    expect(result.preserved).toContain('cocli-setup');
  });

  it('migrates the pre-rename .cocli layout: adopts legacy marker names and removes the legacy dir', async () => {
    const projectPath = temporaryProject();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    };
    await setupSkillBundle(options);
    const skillsRoot = path.join(projectPath, '.agents', 'skills');

    // Rewind to the 0.3.1-era layout: markers under the legacy name, runtime
    // under .cocli/agent-runtime plus a legacy install manifest.
    fs.renameSync(path.join(projectPath, '.uco'), path.join(projectPath, '.cocli'));
    fs.writeFileSync(path.join(projectPath, '.cocli', 'install-manifest.json'), '{}
', 'utf8');
    for (const skillId of ENTRY_SKILL_IDS) {
      fs.renameSync(
        path.join(skillsRoot, skillId, '.uco-skill.json'),
        path.join(skillsRoot, skillId, '.cocli-skill.json'),
      );
    }

    const result = await setupSkillBundle(options);
    expect(fs.existsSync(path.join(projectPath, '.uco', 'agent-runtime', 'bundle-manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, '.cocli'))).toBe(false);
    for (const skillId of ENTRY_SKILL_IDS) {
      expect(fs.existsSync(path.join(skillsRoot, skillId, '.uco-skill.json'))).toBe(true);
      expect(fs.existsSync(path.join(skillsRoot, skillId, '.cocli-skill.json'))).toBe(false);
    }
    expect(result.status).toBe('changed');
  });

  it('still refuses to replace a Skill directory owned by a foreign bundle', async () => {
    const projectPath = temporaryProject();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    };
    await setupSkillBundle(options);
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const markerPath = path.join(skillsRoot, 'unity-cli', '.uco-skill.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.bundleId = 'someone-else-bundle';
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

    await expect(setupSkillBundle(options)).rejects.toThrow(/invalid ownership manifest/);
  });

  it('writes deterministic UTF-8 without BOM and is idempotent', async () => {
    const projectPath = temporaryProject();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools: snapshotTools(),
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    };
    const first = await setupSkillBundle(options);
    const skillPath = path.join(first.destinations['unity-editor'], 'SKILL.md');
    const before = fs.readFileSync(skillPath);
    const second = await setupSkillBundle(options);
    expect(before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(fs.readFileSync(skillPath).equals(before)).toBe(true);
    expect(second.status).toBe('unchanged');
  });

  it('refuses to discard user files inside any managed output', async () => {
    const projectPath = temporaryProject();
    const tools = snapshotTools();
    const options = {
      projectPath,
      skillsPath: '.agents/skills',
      tools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    };
    const first = await setupSkillBundle(options);
    const userFile = path.join(first.destinations['unity-editor'], 'my-notes.md');
    fs.writeFileSync(userFile, 'preserve me\n', 'utf8');
    await expect(setupSkillBundle({
      ...options,
      tools: tools.map((tool, index) => index === 0
        ? { ...tool, title: `${tool.title ?? tool.name} changed` }
        : tool),
    })).rejects.toThrow(/unmanaged files.*my-notes\.md/i);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('preserve me\n');
  });

  it.each(['../skills', '/absolute/skills', 'C:\\outside\\skills'])(
    'rejects an unsafe skills path: %s',
    async (skillsPath) => {
      await expect(setupSkillBundle({
        projectPath: temporaryProject(),
        skillsPath,
        tools: snapshotTools(),
        ucoEntryPath: path.resolve('bin/uco.mjs'),
      })).rejects.toThrow(/project-relative/i);
    },
  );
});
