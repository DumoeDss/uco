// uco setup-skills — compile the live Unity catalog into three focused project Skills.

import { Command } from 'commander';
import type { ToolCatalogEntry } from '../../codegen/types.js';
import { normalizeToolCatalog } from '../../catalog.js';
import { setupSkillBundle, type SetupSkillBundleResult } from '../../skills/bundle.js';
import {
  runCommand,
  CliError,
  type CommandContext,
} from '../../util/cli-context.js';
import { getAgentById, getAgentIds, listSkillsCapableAgents } from '../../devops/utils/agents.js';
import { resolveProjectArg } from './_helpers.js';

interface SetupSkillsOpts {
  list?: boolean;
  dryRun?: boolean;
  migrateLegacy?: boolean;
}

export interface SetupSkillsRequest {
  agentId: string;
  projectPath: string;
  skillsPath: string;
  dryRun: boolean;
  migrateLegacy: boolean;
}

export type SetupSkillsExecutor = (
  request: SetupSkillsRequest,
  context: CommandContext,
) => Promise<SetupSkillBundleResult>;

export async function executeSetupSkills(
  request: SetupSkillsRequest,
  context: CommandContext,
): Promise<SetupSkillBundleResult> {
  const opts = { timeoutMs: context.timeoutMs };
  const [liveTools, livePrompts, liveResources] = await Promise.all([
    context.transport.listTools(opts),
    safeList(context.transport.listPrompts(opts)),
    safeList(context.transport.listResources(opts)),
  ]);
  const tools: ToolCatalogEntry[] = normalizeToolCatalog(liveTools);
  return setupSkillBundle({
    projectPath: request.projectPath,
    skillsPath: request.skillsPath,
    tools,
    prompts: livePrompts,
    resources: liveResources,
    dryRun: request.dryRun,
    migrateLegacy: request.migrateLegacy,
  });
}

async function safeList<T>(p: Promise<T[]>): Promise<T[]> {
  // Soft-degrade when the server has no /api/prompts or /api/resources yet (older builds).
  try {
    return await p;
  } catch {
    return [];
  }
}

export function registerSetupSkills(
  program: Command,
  execute: SetupSkillsExecutor = executeSetupSkills,
): void {
  program
    .command('setup-skills [agent] [project]')
    .description('Generate three focused Unity Skills and a shared runtime from the live Editor catalog.')
    .option('--list', 'List agents that support skills and exit')
    .option('--dry-run', 'Plan generated and migrated files without changing the project')
    .option(
      '--migrate-legacy',
      'Remove recognizable one-tool-per-Skill output in the destination while preserving user content',
    )
    .action(function (
      this: Command,
      agentArg: string | undefined,
      projectArg: string | undefined,
      options: SetupSkillsOpts,
    ) {
      return runCommand(this, async (context) => {
        if (options.list) {
          return { agents: listSkillsCapableAgents() };
        }
        if (!agentArg) {
          throw new CliError(
            `Missing <agent>. Available: ${getAgentIds().join(', ')}. Use --list for details.`,
            'missing-agent',
          );
        }
        const agent = getAgentById(agentArg);
        if (!agent) throw new CliError(`Unknown agent: "${agentArg}"`, 'unknown-agent');
        if (!agent.skillsPath) {
          throw new CliError(
            `Agent "${agent.name}" does not support skills generation`,
            'no-skills-support',
          );
        }

        const projectPath = resolveProjectArg(context, projectArg);
        const result = await execute({
          agentId: agent.id,
          projectPath,
          skillsPath: agent.skillsPath,
          dryRun: options.dryRun === true,
          migrateLegacy: options.migrateLegacy === true,
        }, context);
        return {
          agent: agent.id,
          name: agent.name,
          skillsPath: agent.skillsPath,
          ...result,
        };
      }, projectArg ? { project: projectArg } : undefined)();
    });
}
