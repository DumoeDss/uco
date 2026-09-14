import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ENTRY_SKILL_IDS,
  installStaticSkillBundle,
  loadToolsFromManifest,
  setupSkillBundle,
} from '../src/skills/bundle.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-init-'));
  temporaryDirectories.push(directory);
  return directory;
}

const BUNDLE_ID = 'uco-unity-three-surface-v2';
const BUNDLE_VERSION = 2;
const SKILL_OWNERSHIP_PATH = '.uco-skill.json';

function readManifest(skillsRoot: string, skillId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(skillsRoot, skillId, SKILL_OWNERSHIP_PATH), 'utf8'),
  );
}

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) files.push(path.relative(root, abs).replace(/\\/g, '/'));
    }
  };
  visit(root);
  return files;
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

describe('uco init (installStaticSkillBundle)', () => {
  it('installs the three entry Skills with static files and ownership manifests', () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.claude', 'skills');
    const result = installStaticSkillBundle({ projectPath, skillsRoot });

    expect(result.status).toBe('changed');
    expect(Object.keys(result.destinations).sort()).toEqual([...ENTRY_SKILL_IDS].sort());

    for (const skillId of ENTRY_SKILL_IDS) {
      const dest = path.join(skillsRoot, skillId);
      expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(dest, 'agents', 'openai.yaml'))).toBe(true);

      // Manifest is present and well-formed.
      const manifest = readManifest(skillsRoot, skillId);
      expect(manifest.bundleId).toBe(BUNDLE_ID);
      expect(manifest.bundleVersion).toBe(BUNDLE_VERSION);
      expect(manifest.skillId).toBe(skillId);
      const managedFiles = manifest.managedFiles as string[];
      expect(Array.isArray(managedFiles)).toBe(true);
      expect(managedFiles.length).toBeGreaterThan(0);
      expect(managedFiles).toContain(SKILL_OWNERSHIP_PATH);

      // Every managed file exists; no unmanaged files leak into the directory.
      for (const rel of managedFiles) {
        expect(fs.existsSync(path.join(dest, rel))).toBe(true);
      }
      expect(listRelativeFiles(dest).sort()).toEqual([...managedFiles].sort());
    }

    // unity-editor references: six tool domains + prompts.md + resources.md (static base).
    const editorRefs = fs.readdirSync(path.join(skillsRoot, 'unity-editor', 'references'));
    expect(editorRefs.length).toBe(8);

    expect(result.supportDestination).toBe(path.join(projectPath, '.uco', 'agent-runtime'));
    expect(JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    ))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tool-index.json'),
      'utf8',
    ))).toEqual([]);
    expect(listRelativeFiles(result.supportDestination)).toEqual([
      'bundle-manifest.json',
      'catalog/tool-index.json',
      'catalog/tools.json',
    ]);
  });

  it('is idempotent: a second run is accepted (manifest validates) and rewrites nothing', () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.claude', 'skills');
    installStaticSkillBundle({ projectPath, skillsRoot });
    const before = snapshotTree(projectPath);

    // The second call runs assertManagedTargets over the first run's output —
    // not throwing proves the manifest is setup-skills compatible.
    const result = installStaticSkillBundle({ projectPath, skillsRoot });
    expect(result.status).toBe('unchanged');
    expect(result.written).toEqual([]);
    expect(snapshotTree(projectPath)).toEqual(before);
  });

  it('dry-run reports what would change but writes nothing', () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.claude', 'skills');
    const result = installStaticSkillBundle({ projectPath, skillsRoot, dryRun: true });
    expect(result.status).toBe('would-change');
    expect(result.written.length).toBeGreaterThan(0);
    expect(fs.existsSync(skillsRoot)).toBe(false);
  });

  it('rejects a skills root outside the selected init target', () => {
    const projectPath = temporaryProject();
    const outside = temporaryProject();
    const skillsRoot = path.join(outside, '.claude', 'skills');

    expect(() => installStaticSkillBundle({ projectPath, skillsRoot }))
      .toThrow(/escapes the intended directory/i);
    expect(fs.existsSync(path.join(projectPath, '.uco'))).toBe(false);
    expect(fs.existsSync(skillsRoot)).toBe(false);
  });

  it('refuses to overwrite a Skill directory without a managed manifest', () => {
    const projectPath = temporaryProject();
    const skillsRoot = path.join(projectPath, '.claude', 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'uco-setup'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'uco-setup', 'SKILL.md'), 'user content', 'utf8');

    expect(() => installStaticSkillBundle({ projectPath, skillsRoot })).toThrow(/unmanaged/i);
  });

  it('keeps offline manifest metadata and generated references identical to live setup', async () => {
    const offlineRoot = temporaryProject();
    const liveProject = temporaryProject();
    const manifestPath = path.join(offlineRoot, 'tools-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify([
      { name: 'scene-legacy', inputSchema: { additionalProperties: true } },
      {
        name: 'scene-metadata',
        enabled: false,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: null,
        futureSafetyMember: { version: 2 },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          $defs: { Value: { customKeyword: 'retained' } },
        },
        outputSchema: {
          additionalProperties: { futureOutputKeyword: true },
          $defs: { Result: { customOutputKeyword: 'retained' } },
          $ref: '#/$defs/Result',
        },
      },
    ]), 'utf8');

    const tools = loadToolsFromManifest(manifestPath);
    expect(tools[0]).toEqual({
      enabled: true,
      inputSchema: { additionalProperties: true },
      name: 'scene-legacy',
    });
    expect(tools[1]).toMatchObject({
      destructiveHint: false,
      idempotentHint: null,
      futureSafetyMember: { version: 2 },
      inputSchema: {
        additionalProperties: false,
        $defs: { Value: { customKeyword: 'retained' } },
      },
      outputSchema: {
        additionalProperties: { futureOutputKeyword: true },
        $defs: { Result: { customOutputKeyword: 'retained' } },
        $ref: '#/$defs/Result',
      },
    });

    const skillsRoot = path.join(offlineRoot, '.claude', 'skills');
    const offline = installStaticSkillBundle({
      projectPath: offlineRoot,
      skillsRoot,
      tools,
    });
    const live = await setupSkillBundle({
      projectPath: liveProject,
      skillsPath: '.claude/skills',
      tools,
      ucoEntryPath: path.resolve('bin/uco.mjs'),
    });
    const offlineReference = fs.readFileSync(
      path.join(skillsRoot, 'unity-editor', 'references', 'authoring.md'),
      'utf8',
    );
    const liveReference = fs.readFileSync(
      path.join(live.destinations['unity-editor'], 'references', 'authoring.md'),
      'utf8',
    );
    expect(offlineReference).toBe(liveReference);
    expect(offlineReference).toContain('destructiveHint=false');
    expect(offlineReference).toContain('idempotentHint=unknown');
    expect(fs.readFileSync(
      path.join(offline.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    )).toBe(fs.readFileSync(
      path.join(live.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    ));
    expect(fs.readFileSync(
      path.join(offline.supportDestination, 'catalog', 'tool-index.json'),
      'utf8',
    )).toBe(fs.readFileSync(
      path.join(live.supportDestination, 'catalog', 'tool-index.json'),
      'utf8',
    ));
  });

  it('rejects duplicate names before replacing any existing managed output', () => {
    const root = temporaryProject();
    const skillsRoot = path.join(root, '.claude', 'skills');
    installStaticSkillBundle({
      projectPath: root,
      skillsRoot,
      tools: [{ name: 'existing-tool', enabled: true }],
    });
    const before = snapshotTree(root);

    expect(() => installStaticSkillBundle({
      projectPath: root,
      skillsRoot,
      tools: [{ name: 'same', enabled: true }, { name: 'same', enabled: true }],
    })).toThrow(/duplicate name.*same/i);
    expect(snapshotTree(root)).toEqual(before);
  });
});
