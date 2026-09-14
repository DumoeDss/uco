import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeSetupSkills,
  registerSetupSkills,
  type SetupSkillsExecutor,
} from '../src/commands/devops/setup-skills.js';
import { getAgentById } from '../src/devops/utils/agents.js';
import type { CommandContext } from '../src/util/cli-context.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-setup-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('setup-skills command', () => {
  it('uses the official Codex repository Skill root', () => {
    expect(getAgentById('codex')?.skillsPath).toBe('.agents/skills');
  });

  it('passes positional project into both the request and transport context', async () => {
    const projectPath = temporaryProject();
    const execute = vi.fn<SetupSkillsExecutor>(async (request, context) => ({
      status: 'would-change',
      projectPath: request.projectPath,
      destinations: {
        'uco-setup': path.join(request.projectPath, request.skillsPath, 'uco-setup'),
        'unity-cli': path.join(request.projectPath, request.skillsPath, 'unity-cli'),
        'unity-editor': path.join(request.projectPath, request.skillsPath, 'unity-editor'),
      },
      supportDestination: path.join(request.projectPath, '.uco', 'agent-runtime'),
      skillEntryCount: 3,
      skillIds: ['uco-setup', 'unity-cli', 'unity-editor'],
      toolCount: 156,
      domainCounts: {
        'build-and-tests': 9,
        authoring: 34,
        code: 19,
        visuals: 48,
        physics: 20,
        diagnostics: 26,
      },
      catalogFingerprint: 'abc',
      written: ['SKILL.md'],
      removed: [],
      preserved: [],
      warnings: context.resolved.projectPath === request.projectPath ? [] : ['wrong-project'],
    }));
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command().exitOverride().option('--json');
    registerSetupSkills(program, execute);

    await program.parseAsync([
      'node', 'uco', '--json', 'setup-skills', 'codex', projectPath,
      '--dry-run', '--migrate-legacy',
    ]);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      agentId: 'codex',
      projectPath: path.resolve(projectPath),
      skillsPath: '.agents/skills',
      dryRun: true,
      migrateLegacy: true,
    });
    expect(execute.mock.calls[0]?.[1].resolved.projectPath).toBe(path.resolve(projectPath));
    const output = JSON.parse(String(stdout.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      agent: 'codex',
      skillsPath: '.agents/skills',
      skillEntryCount: 3,
      skillIds: ['uco-setup', 'unity-cli', 'unity-editor'],
      warnings: [],
    });
  });

  it('passes the normalized metadata-bearing live catalog into bundle publication', async () => {
    const projectPath = temporaryProject();
    const context = {
      timeoutMs: 1_000,
      output: { json: true, verbose: false },
      resolved: { baseUrl: 'http://127.0.0.1:1', source: 'test', projectPath },
      transport: {
        listTools: async () => [{
          name: 'scene-live',
          enabled: false,
          destructiveHint: false,
          idempotentHint: null,
          futureSafetyMember: 'retained',
          inputSchema: { additionalProperties: false },
        }],
        listPrompts: async () => [],
        listResources: async () => [],
      },
    } as unknown as CommandContext;

    const result = await executeSetupSkills({
      agentId: 'codex',
      projectPath,
      skillsPath: '.agents/skills',
      dryRun: false,
      migrateLegacy: false,
    }, context);
    const catalog = JSON.parse(fs.readFileSync(
      path.join(result.supportDestination, 'catalog', 'tools.json'),
      'utf8',
    )) as Array<Record<string, unknown>>;
    expect(catalog[0]).toMatchObject({
      destructiveHint: false,
      idempotentHint: null,
      futureSafetyMember: 'retained',
      inputSchema: { additionalProperties: false },
    });
  });
});
