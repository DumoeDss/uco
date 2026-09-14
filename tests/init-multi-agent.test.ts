vi.mock('@inquirer/prompts', () => ({
  checkbox: async () => { throw new Error('non-TTY'); },
}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerInit } from '../src/commands/init.js';
import { installManifestPath, readInstallManifest } from '../src/skills/install-manifest.js';
import { ENTRY_SKILL_IDS } from '../src/skills/bundle.js';
import { promptMultiSelect } from '../src/util/multi-select.js';

// The prompt path is covered with a module mock (the prompt module itself has
// its own suite over stubbed streams). Keep the real error class so init's
// instanceof wiring stays exercised.
vi.mock('../src/util/multi-select.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/util/multi-select.js')>();
  return { ...actual, promptMultiSelect: vi.fn() };
});

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryTarget(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-init-multi-'));
  directories.push(directory);
  return directory;
}

/** Run `uco init <args...> --json` against a fresh program; capture the JSON payload. */
async function runInitJson(args: string[]): Promise<Record<string, unknown>> {
  const program = new Command().exitOverride().option('--json');
  registerInit(program);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('unexpected process.exit during a successful init run');
  }) as never);
  try {
    await program.parseAsync(['node', 'uco', ...args, '--json']);
  } finally {
    spy.mockRestore();
    exitSpy.mockRestore();
  }
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

/** Run `uco init <args...>` expecting failure; capture the printed error text. */
async function runInitExpectError(args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  registerInit(program);
  const chunks: string[] = [];
  const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    await program.parseAsync(['node', 'uco', ...args]);
    throw new Error('expected the command to reject');
  } catch (error) {
    expect((error as Error).message).toMatch(/^exit:1$/);
    return chunks.join('');
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

function expectEntrySkillsInstalled(skillsRoot: string): void {
  for (const skillId of ENTRY_SKILL_IDS) {
    expect(fs.existsSync(path.join(skillsRoot, skillId, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, skillId, '.uco-skill.json'))).toBe(true);
  }
}

describe('uco init multi-agent install', () => {
  it('installs for every listed agent, publishes one shared runtime, and writes the manifest', async () => {
    const target = temporaryTarget();
    const payload = await runInitJson(['init', target, '--agent', 'claude-code,cursor']);

    expectEntrySkillsInstalled(path.join(target, '.claude', 'skills'));
    expectEntrySkillsInstalled(path.join(target, '.cursor', 'skills'));
    // One shared support tree, not one per agent.
    const runtime = path.join(target, '.uco', 'agent-runtime');
    expect(fs.existsSync(path.join(runtime, 'bundle-manifest.json'))).toBe(true);

    const manifest = readInstallManifest(target).manifest!;
    expect(manifest.agents).toEqual([
      { id: 'claude-code', skillsPath: '.claude/skills' },
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);
    expect(manifest.ucoVersion).toBe(readPackageVersion());

    expect(payload['agent']).toBe('claude-code');
    expect(payload['selectedVia']).toBe('flag');
    expect(payload['status']).toBe('changed');
    expect((payload['agents'] as Array<Record<string, unknown>>).map((agent) => agent['id']))
      .toEqual(['claude-code', 'cursor']);
    expect(payload['manifestPath']).toBe(installManifestPath(target));
    expect(payload['removedAgents']).toEqual([]);
  });

  it('deduplicates a repeated agent list', async () => {
    const target = temporaryTarget();
    const payload = await runInitJson(['init', target, '--agent', 'cursor,cursor ,cursor']);

    expect((payload['agents'] as Array<Record<string, unknown>>).map((agent) => agent['id']))
      .toEqual(['cursor']);
    expect(fs.existsSync(path.join(target, '.claude'))).toBe(false);
  });

  it('keeps single-agent behavior for a single id', async () => {
    const target = temporaryTarget();
    const payload = await runInitJson(['init', target, '--agent', 'cursor']);

    expectEntrySkillsInstalled(path.join(target, '.cursor', 'skills'));
    expect(fs.existsSync(path.join(target, '.claude'))).toBe(false);
    expect(payload['agent']).toBe('cursor');
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);
  });

  it('records a --skills-path override in the manifest', async () => {
    const target = temporaryTarget();
    await runInitJson(['init', target, '--agent', 'claude-code', '--skills-path', '.claude/my-skills']);

    expectEntrySkillsInstalled(path.join(target, '.claude', 'my-skills'));
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'claude-code', skillsPath: '.claude/my-skills' },
    ]);
  });
});

describe('uco init re-run semantics', () => {
  it('shrinks the install: deselected dirs removed, shared runtime kept', async () => {
    const target = temporaryTarget();
    await runInitJson(['init', target, '--agent', 'claude-code,cursor']);
    const runtimeManifestBefore = fs.readFileSync(
      path.join(target, '.uco', 'agent-runtime', 'bundle-manifest.json'),
      'utf8',
    );

    const payload = await runInitJson(['init', target, '--agent', 'claude-code']);

    expect(payload['removedAgents']).toEqual(['cursor']);
    expect(fs.existsSync(path.join(target, '.cursor', 'skills', 'uco-setup'))).toBe(false);
    expectEntrySkillsInstalled(path.join(target, '.claude', 'skills'));
    expect(fs.existsSync(path.join(target, '.uco', 'agent-runtime', 'bundle-manifest.json'))).toBe(true);
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'claude-code', skillsPath: '.claude/skills' },
    ]);
    // The shared runtime is not churned by the shrink.
    expect(fs.readFileSync(
      path.join(target, '.uco', 'agent-runtime', 'bundle-manifest.json'),
      'utf8',
    )).toBe(runtimeManifestBefore);
  });

  it('keeps a shared skills directory when shrinking a shared-path multi-selection', async () => {
    const target = temporaryTarget();
    // vscode-copilot and github-copilot-cli share `.github/skills` in the registry.
    await runInitJson(['init', target, '--agent', 'vscode-copilot,github-copilot-cli']);
    expectEntrySkillsInstalled(path.join(target, '.github', 'skills'));

    const payload = await runInitJson(['init', target, '--agent', 'github-copilot-cli']);

    // The deselected agent's directories are NOT removed: the survivor still
    // records the same path and owns them now.
    expect(payload['removedAgents']).toEqual([]);
    expectEntrySkillsInstalled(path.join(target, '.github', 'skills'));
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'github-copilot-cli', skillsPath: '.github/skills' },
    ]);
  });

  it('is idempotent: an unchanged re-run rewrites nothing except the manifest timestamp', async () => {
    const target = temporaryTarget();
    await runInitJson(['init', target, '--agent', 'claude-code,cursor']);
    const before = snapshotTree(target);

    const payload = await runInitJson(['init', target, '--agent', 'claude-code,cursor']);

    expect(payload['status']).toBe('unchanged');
    expect(payload['written']).toEqual([]);
    // Every artifact is byte-identical; the manifest alone gets a fresh
    // updatedAt with identical agent content (project-install-manifest spec).
    expect(snapshotTree(target, ['.uco/install-manifest.json'])).toEqual(
      Object.fromEntries(Object.entries(before).filter(([key]) => key !== '.uco/install-manifest.json')),
    );
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'claude-code', skillsPath: '.claude/skills' },
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);
  });

  it('dry-run reports what would change and writes nothing, manifest included', async () => {
    const target = temporaryTarget();
    const payload = await runInitJson(['init', target, '--agent', 'claude-code,cursor', '--dry-run']);

    expect(payload['status']).toBe('would-change');
    expect((payload['written'] as string[]).length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(target, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.uco'))).toBe(false);
  });
});

describe('uco init selection resolution', () => {
  it('uses detected agent directories when non-interactive without --agent', async () => {
    const target = temporaryTarget();
    fs.mkdirSync(path.join(target, '.cursor'));
    const payload = await runInitJson(['init', target]);

    expect(payload['selectedVia']).toBe('detected');
    expect((payload['agents'] as Array<Record<string, unknown>>).map((agent) => agent['id']))
      .toEqual(['cursor']);
    expectEntrySkillsInstalled(path.join(target, '.cursor', 'skills'));
  });

  it('falls back to claude-code when nothing is detected', async () => {
    const target = temporaryTarget();
    const payload = await runInitJson(['init', target]);

    expect(payload['selectedVia']).toBe('default');
    expect((payload['agents'] as Array<Record<string, unknown>>).map((agent) => agent['id']))
      .toEqual(['claude-code']);
    expectEntrySkillsInstalled(path.join(target, '.claude', 'skills'));
  });

  it('installs the prompted multi-select choice (selectedVia "prompt")', async () => {
    const target = temporaryTarget();
    // An existing manifest preselects its agents in the prompt.
    await runInitJson(['init', target, '--agent', 'claude-code']);
    vi.mocked(promptMultiSelect).mockResolvedValue({ selected: ['cursor'], answer: '2' });

    const payload = await withInteractiveTerminal(() => runInitJson(['init', target]));

    expect(promptMultiSelect).toHaveBeenCalledTimes(1);
    // The prompt preselected the manifest's recorded agents.
    const choices = vi.mocked(promptMultiSelect).mock.calls[0]![0].choices;
    expect(choices.find((choice) => choice.value === 'claude-code')?.preSelected).toBe(true);
    expect(choices.find((choice) => choice.value === 'cursor')?.preSelected).toBe(false);
    // The prompted selection reaches the install loop and the manifest.
    expect(payload['selectedVia']).toBe('prompt');
    expect((payload['agents'] as Array<Record<string, unknown>>).map((agent) => agent['id']))
      .toEqual(['cursor']);
    expectEntrySkillsInstalled(path.join(target, '.cursor', 'skills'));
    expect(readInstallManifest(target).manifest!.agents).toEqual([
      { id: 'cursor', skillsPath: '.cursor/skills' },
    ]);
    // The deselected preselected agent was cleaned up.
    expect(payload['removedAgents']).toEqual(['claude-code']);
    expect(fs.existsSync(path.join(target, '.claude', 'skills', 'uco-setup'))).toBe(false);
  });
});

/** Run `fn` with stdin+stdout pretending to be a TTY; restores both after. */
async function withInteractiveTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const descriptors = [process.stdin, process.stdout].map((stream) => ({
    stream,
    descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  }));
  for (const { stream } of descriptors) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
  try {
    return await fn();
  } finally {
    for (const { stream, descriptor } of descriptors) {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  }
}

describe('uco init flag validation', () => {
  it('rejects an unknown agent id listing valid ids', async () => {
    const errorText = await runInitExpectError(['init', temporaryTarget(), '--agent', 'windsurf-legacy']);
    expect(errorText).toContain('windsurf-legacy');
    expect(errorText).toContain('claude-code');
    expect(errorText).toContain('windsurf');
  });

  it('rejects an agent without Skills support', async () => {
    const errorText = await runInitExpectError(['init', temporaryTarget(), '--agent', 'claude-desktop']);
    expect(errorText).toMatch(/does not support skills/i);
  });

  it('rejects an empty --agent value', async () => {
    const errorText = await runInitExpectError(['init', temporaryTarget(), '--agent', '']);
    expect(errorText).toMatch(/--agent requires/i);
  });

  it('rejects --skills-path with more than one agent', async () => {
    const errorText = await runInitExpectError([
      'init', temporaryTarget(), '--agent', 'claude-code,codex', '--skills-path', 'custom/skills',
    ]);
    expect(errorText).toMatch(/--skills-path applies to a single agent/i);
  });
});

function readPackageVersion(): string {
  const raw = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
  return raw.version;
}

function snapshotTree(root: string, exclude: string[] = []): Record<string, string> {
  const snap: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) {
        const relative = path.relative(root, abs).replace(/\\/g, '/');
        if (exclude.includes(relative)) continue;
        snap[relative] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  visit(root);
  return snap;
}
