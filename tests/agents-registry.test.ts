import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentRegistry,
  detectAgentsAt,
  getAgentById,
  getSkillsCapableAgentIds,
  getSkillsCapableAgents,
  listSkillsCapableAgents,
} from '../src/devops/utils/agents.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryTarget(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-agents-'));
  directories.push(directory);
  return directory;
}

describe('agent registry install-selection surface', () => {
  it('enumerates every skills-capable agent including windsurf', () => {
    const ids = getSkillsCapableAgentIds();
    for (const id of ['claude-code', 'cursor', 'codex', 'windsurf']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('claude-desktop');
    expect(ids).not.toContain('unity-ai');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('excludes entries whose skillsPath is null', () => {
    const nullSkilled = agentRegistry.filter((a) => a.skillsPath === null).map((a) => a.id);
    for (const id of nullSkilled) {
      expect(getSkillsCapableAgentIds()).not.toContain(id);
    }
  });

  it('gives every skills-capable entry at least one detection path', () => {
    for (const agent of getSkillsCapableAgents()) {
      expect(agent.detectionPaths.length).toBeGreaterThan(0);
    }
  });

  it('registers windsurf with skills, config, and detection paths', () => {
    const windsurf = getAgentById('windsurf');
    expect(windsurf).toBeDefined();
    expect(windsurf!.skillsPath).toBe('.windsurf/skills');
    expect(windsurf!.detectionPaths).toEqual(['.windsurf']);
    expect(windsurf!.configPathDisplay).toBe('.windsurf/mcp.json');
    expect(windsurf!.getConfigPath('C:/proj')).toBe(path.join('C:/proj', '.windsurf', 'mcp.json'));
  });

  it('lists skills-capable agents with detection paths for --list', () => {
    const entries = listSkillsCapableAgents();
    expect(entries.length).toBe(getSkillsCapableAgents().length);
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.skillsPath).toBe('string');
      expect(Array.isArray(entry.detectionPaths)).toBe(true);
    }
    const claude = entries.find((entry) => entry.id === 'claude-code');
    expect(claude!.detectionPaths).toEqual(['.claude']);
  });
});

describe('detectAgentsAt', () => {
  it('reports agents whose detection directories exist at the target', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.claude'));
    fs.mkdirSync(path.join(target, '.cursor'));

    expect(detectAgentsAt(target)).toEqual(['claude-code', 'cursor']);
  });

  it('never reports agents whose directories are absent', () => {
    const target = temporaryTarget();
    expect(detectAgentsAt(target)).toEqual([]);
  });

  it('probes file detection paths, not just directories', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.github'), { recursive: true });
    fs.writeFileSync(path.join(target, '.github', 'copilot-instructions.md'), '# instructions\n');

    expect(detectAgentsAt(target)).toEqual(['github-copilot-cli']);
  });

  it('ignores detection paths for agents without skills support', () => {
    const target = temporaryTarget();
    // unity-ai's config destination exists, but it is not skills-capable and
    // carries no detection paths — it must never be detected.
    fs.mkdirSync(path.join(target, 'UserSettings'), { recursive: true });
    fs.writeFileSync(path.join(target, 'UserSettings', 'mcp.json'), '{}\n');

    expect(detectAgentsAt(target)).toEqual([]);
  });

  it('does not create, modify, or remove anything at the target', () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.windsurf'));
    detectAgentsAt(target);

    expect(fs.readdirSync(target)).toEqual(['.windsurf']);
  });
});
