// uco init — bootstrap AI agents with uco's static Skills.
//
// The "chicken-and-egg" solver: before any Unity project exists and before any
// server is running, `uco init` copies the three uco entry Skills
// (uco-setup / unity-cli / unity-editor) as static templates into each
// selected agent's skills folder. The agents (Claude Code by default) then
// know uco's command surface and can drive the rest: install-unity →
// create-project → install → open → setup-skills. No Unity project or running
// server required.
//
// Selection resolution order: the `--agent` flag (single id or a
// comma-separated list) → interactive multi-select on a TTY → agents detected
// at the target → `claude-code`. A successful install is recorded in
// `.uco/install-manifest.json`; re-running with a smaller set removes the
// deselected agents' uco-owned skill directories.

import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import { Command } from 'commander';
import kleur from 'kleur';
import { runCommand, CliError } from '../util/cli-context.js';
import {
  installStaticSkillBundle,
  ENTRY_SKILL_IDS,
  resolvePluginManifestPath,
  loadToolsFromManifest,
} from '../skills/bundle.js';
import {
  getAgentById,
  getSkillsCapableAgents,
  getSkillsCapableAgentIds,
  detectAgentsAt,
  listSkillsCapableAgents,
  type AgentDefinition,
} from '../devops/utils/agents.js';
import {
  detectUnitySeed,
  getUcoVersion,
  readInstallManifest,
  removeDeselectedAgentSkills,
  writeInstallManifest,
  type InstallManifestAgent,
} from '../skills/install-manifest.js';
import { promptMultiSelect, EmptyMultiSelectionError } from '../util/multi-select.js';

interface InitOpts {
  agent?: string;
  skillsPath?: string;
  dryRun?: boolean;
  list?: boolean;
}

/** How the agent set was chosen — surfaced in the summary for transparency. */
type SelectionSource = 'flag' | 'prompt' | 'detected' | 'default';

interface AgentSelection {
  /** Selected agents in registry order (stable install + manifest ordering). */
  agents: AgentDefinition[];
  /** Effective skills path per agent id (the `--skills-path` override when applied). */
  skillsPathById: Map<string, string>;
  source: SelectionSource;
}

export function registerInit(program: Command): void {
  program
    .command('init [target]')
    .description(
      'Bootstrap AI agents with uco Skills so they can drive Unity. No Unity project or running server required. Default target: current directory.',
    )
    .option('--agent <ids>', 'Target agents: a single id or a comma-separated list (e.g. claude-code,cursor). Use --list to see all.')
    .option('--skills-path <rel>', 'Override the agent skills folder (single agent only; default: agent-specific, e.g. .claude/skills)')
    .option('--dry-run', 'Show which Skill files would be written without writing')
    .option('--list', 'List agents that support Skills and exit')
    .action(function (this: Command, targetArg: string | undefined, opts: InitOpts) {
      return runCommand(this, async (ctx) => {
        if (opts.list) {
          return { agents: listSkillsCapableAgents() };
        }

        const target = path.resolve(targetArg ?? process.cwd());
        if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
          throw new CliError(`Target directory does not exist or is not a directory: ${target}`, 'missing-target');
        }

        const previous = readInstallManifest(target);
        const selection = await resolveAgentSelection(target, opts, previous.manifest?.agents ?? []);
        const tools = loadToolsFromManifest(resolvePluginManifestPath());

        const primary = selection.agents[0]!;
        const primarySkillsPath = selection.skillsPathById.get(primary.id)!;

        const perAgent = selection.agents.map((agent) => {
          const skillsPath = selection.skillsPathById.get(agent.id)!;
          const result = installStaticSkillBundle({
            projectPath: target,
            skillsRoot: path.resolve(target, skillsPath),
            dryRun: opts.dryRun === true,
            tools,
            // The shared runtime is published per call; recording the primary
            // agent's path keeps its manifest byte-stable across agents/runs.
            runtimeSkillsPath: primarySkillsPath,
          });
          return { agent, skillsPath, result };
        });

        const warnings = [...new Set(perAgent.flatMap((entry) => entry.result.warnings))];
        const written = perAgent.flatMap((entry) =>
          entry.result.written.map((file) => `${entry.agent.id}: ${file}`));
        const anyChanged = perAgent.some((entry) => entry.result.status !== 'unchanged');
        const status: InitPayload['status'] = opts.dryRun === true
          ? (anyChanged ? 'would-change' : 'unchanged')
          : (anyChanged ? 'changed' : 'unchanged');

        // Manifest write + deselection cleanup happen only for real installs.
        let manifestRecordPath: string | undefined;
        let removedAgents: string[] = [];
        let removedDirectories: string[] = [];
        if (opts.dryRun !== true) {
          const newAgents: InstallManifestAgent[] = selection.agents.map((agent) => ({
            id: agent.id,
            skillsPath: selection.skillsPathById.get(agent.id)!,
          }));
          manifestRecordPath = writeInstallManifest(target, {
            schemaVersion: 1,
            ucoVersion: getUcoVersion(),
            updatedAt: new Date().toISOString(),
            agents: newAgents,
            // Preserve a previously recorded unity surface; on a first init
            // over a target that already carries a uco Unity install (the
            // pre-manifest migration case), seed it from detection instead of
            // silently forgetting it.
            unity: previous.manifest?.unity ?? detectUnitySeed(target),
          });
          const selectedIds = new Set(selection.agents.map((agent) => agent.id));
          const deselected = (previous.manifest?.agents ?? []).filter((entry) => !selectedIds.has(entry.id));
          // Survivors are passed so cleanup can spare a skills path that a
          // retained agent still records (shared `.github/skills` etc.).
          const cleanup = removeDeselectedAgentSkills(target, deselected, newAgents);
          removedAgents = cleanup.removedAgents;
          removedDirectories = cleanup.removedDirectories;
          warnings.push(...cleanup.warnings);
        }

        const primaryResult = perAgent[0]!.result;
        const payload: InitPayload = {
          agent: primary.id,
          agents: perAgent.map((entry) => ({
            id: entry.agent.id,
            skillsPath: entry.skillsPath,
            skillsRoot: entry.result.skillsRoot,
            status: entry.result.status,
            writtenCount: entry.result.written.length,
            destinations: entry.result.destinations,
          })),
          skillsRoot: primaryResult.skillsRoot,
          destinations: primaryResult.destinations,
          supportDestination: primaryResult.supportDestination,
          status,
          written,
          warnings,
          toolCount: primaryResult.toolCount,
          selectedVia: selection.source,
          manifestPath: manifestRecordPath,
          removedAgents,
        };

        if (!ctx.output.json) {
          printInitSummary(payload, removedDirectories);
          return undefined;
        }
        return payload;
      })();
    });
}

/**
 * Resolve the agent set: `--agent` flag → interactive multi-select (TTY) →
 * detected agents → `claude-code`. Never prompts when non-interactive.
 */
async function resolveAgentSelection(
  target: string,
  opts: InitOpts,
  previousAgents: readonly InstallManifestAgent[],
): Promise<AgentSelection> {
  if (opts.agent !== undefined) {
    return buildSelection(parseAgentListArgument(opts.agent), opts, 'flag');
  }

  const previousIds = previousAgents.map((entry) => entry.id);
  if (isInteractiveTerminal()) {
    const detected = new Set(detectAgentsAt(target));
    const configured = new Set(previousIds);
    const preselected = configured.size > 0
      ? configured
      : (detected.size > 0 ? detected : new Set(['claude-code']));
    const choices = orderChoicesForPrompt(
      getSkillsCapableAgents().map((agent) => ({
        agent,
        preSelected: preselected.has(agent.id),
        detected: detected.has(agent.id),
      })),
    );
    try {
      // Checkbox UI (space toggles, arrows move, enter confirms) on a real TTY;
      // anything that cannot host the interactive renderer (non-TTY stdin,
      // piped output) falls back to the numbered promptMultiSelect grammar.
      let selected: string[];
      try {
        const { checkbox } = await import('@inquirer/prompts');
        selected = await checkbox({
          message: `Select agents to install uco Skills for (${choices.length} available):`,
          choices: choices.map((entry) => ({
            value: entry.agent.id,
            name: entry.agent.name
              + (entry.detected && !entry.preSelected ? ' (detected)' : ''),
            checked: entry.preSelected,
          })),
        });
        if (selected.length === 0) throw new EmptyMultiSelectionError('no agents checked');
      } catch {
        const result = await promptMultiSelect({
          message: `Select agents to install uco Skills for (${choices.length} available):`,
          choices: choices.map((entry) => ({
            value: entry.agent.id,
            label: entry.agent.name,
            preSelected: entry.preSelected,
            detected: entry.detected && !entry.preSelected,
          })),
        });
        selected = result.selected;
      }
      return buildSelection(selected, opts, 'prompt');
    } catch (error) {
      if (error instanceof EmptyMultiSelectionError) {
        throw new CliError('At least one agent must be selected. Re-run `uco init` and choose agents, or pass --agent <ids>.', 'empty-agent-selection');
      }
      throw error;
    }
  }

  const detected = detectAgentsAt(target);
  if (detected.length > 0) {
    return buildSelection(detected, opts, 'detected');
  }
  return buildSelection(['claude-code'], opts, 'default');
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** Sort configured > detected > rest (stable within groups by registry order). */
function orderChoicesForPrompt<T extends { preSelected: boolean; detected: boolean }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => {
    if (left.preSelected !== right.preSelected) return left.preSelected ? -1 : 1;
    if (left.detected !== right.detected) return left.detected ? -1 : 1;
    return 0;
  });
}

function buildSelection(
  ids: readonly string[],
  opts: InitOpts,
  source: SelectionSource,
): AgentSelection {
  if (ids.length === 0) {
    throw new CliError('At least one agent must be selected. Use --list to see supported agents.', 'empty-agent-selection');
  }

  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const agent = getAgentById(id);
    if (!agent) {
      throw new CliError(
        `Unknown agent: "${id}". Valid agent ids: ${getSkillsCapableAgentIds().join(', ')}. Use --list for details.`,
        'unknown-agent',
      );
    }
    if (!agent.skillsPath) {
      throw new CliError(
        `Agent "${agent.name}" does not support Skills. Use --list for supported agents.`,
        'no-skills-support',
      );
    }
  }

  if (opts.skillsPath !== undefined && seen.size > 1) {
    throw new CliError(
      `--skills-path applies to a single agent; ${seen.size} agents are selected (${[...seen].join(', ')}). Drop --skills-path or install one agent at a time.`,
      'ambiguous-skills-path',
    );
  }

  // Registry order: stable install loop order, manifest order, prompt numbering.
  const agents = getSkillsCapableAgents().filter((agent) => seen.has(agent.id));
  const skillsPathById = new Map(agents.map((agent) => [
    agent.id,
    opts.skillsPath !== undefined ? validateSkillsPath(opts.skillsPath) : (agent.skillsPath as string),
  ]));
  return { agents, skillsPathById, source };
}

/**
 * Parse the `--agent` value: a comma-separated list (or a single id), trimmed
 * and deduplicated preserving order. Fails on an empty value or token-less
 * input; per-id validity (unknown id, skills support) is checked in
 * {@link buildSelection}.
 */
function parseAgentListArgument(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CliError(
      '--agent requires a value: a single agent id or a comma-separated list (e.g. claude-code,cursor). Use --list to see supported agents.',
      'invalid-agent',
    );
  }
  const tokens = trimmed.split(',').map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new CliError(
      '--agent requires at least one agent id (e.g. claude-code,cursor). Use --list to see supported agents.',
      'invalid-agent',
    );
  }
  const ids: string[] = [];
  for (const token of tokens) {
    if (!ids.includes(token)) ids.push(token);
  }
  return ids;
}

function validateSkillsPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/');
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new CliError(`--skills-path must be a relative path: ${raw}`, 'invalid-skills-path');
  }
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) {
    throw new CliError(`--skills-path must be a safe relative path: ${raw}`, 'invalid-skills-path');
  }
  return normalized;
}

interface InitPayloadAgent {
  id: string;
  skillsPath: string;
  skillsRoot: string;
  status: 'changed' | 'unchanged' | 'would-change';
  writtenCount: number;
  destinations: Record<string, string>;
}

interface InitPayload {
  /** Primary agent id (back-compat single-agent field). */
  agent: string;
  agents: InitPayloadAgent[];
  skillsRoot: string;
  destinations: Record<string, string>;
  supportDestination: string;
  status: 'changed' | 'unchanged' | 'would-change';
  written: string[];
  warnings: string[];
  toolCount: number;
  selectedVia: SelectionSource;
  manifestPath?: string;
  removedAgents: string[];
}

function printInitSummary(payload: InitPayload, removedDirectories: string[]): void {
  const out = process.stderr;
  const w = (s: string): void => { out.write(s + '\n'); };

  if (payload.status === 'would-change') {
    w(kleur.bold().yellow('uco init — DRY RUN (no files written)'));
  } else if (payload.status === 'unchanged') {
    w(kleur.bold().gray('uco init — already up to date'));
  } else {
    w(kleur.bold().green('uco init — done'));
  }
  const sourceNotes: Record<SelectionSource, string> = {
    flag: 'via --agent',
    prompt: 'via interactive selection',
    detected: 'non-interactive: detected agent directories',
    default: 'non-interactive: default',
  };
  w(kleur.gray(`  agents     : ${payload.agents.map((agent) => agent.id).join(', ')} (${sourceNotes[payload.selectedVia]})`));
  if (payload.toolCount > 0) {
    w(kleur.gray(`  tools      : ${payload.toolCount} from offline manifest`));
  }

  w('');
  w(kleur.bold('Agents:'));
  for (const agent of payload.agents) {
    const mark = agent.status === 'unchanged'
      ? kleur.gray('  unchanged')
      : kleur.green(`✓ ${agent.writtenCount} file${agent.writtenCount === 1 ? '' : 's'} written`);
    w(`  ${kleur.cyan(agent.id.padEnd(16))} ${kleur.gray(agent.skillsRoot)}  ${mark}`);
  }

  if (payload.agents.length === 1 && payload.status !== 'unchanged') {
    const touchedSkills = new Set(
      payload.written.map((entry) => entry.split(': ')[1]?.split('/')[0]).filter((value): value is string => value !== undefined),
    );
    w('');
    w(kleur.bold('Skills:'));
    for (const id of ENTRY_SKILL_IDS) {
      const mark = touchedSkills.has(id) ? kleur.green('✓ written') : kleur.gray('  unchanged');
      w(`  ${kleur.cyan(id.padEnd(14))} ${mark}`);
    }
  } else if (payload.status === 'unchanged') {
    w('');
    w(kleur.gray(`All ${ENTRY_SKILL_IDS.length} Skills already installed and current for every selected agent.`));
  }

  if (payload.removedAgents.length > 0) {
    w('');
    w(kleur.bold('Removed (deselected agents):'));
    for (const directory of removedDirectories) {
      w(`  ${kleur.gray('-')} ${directory}`);
    }
  }

  if (payload.manifestPath !== undefined) {
    w('');
    w(kleur.gray(`  manifest   : ${payload.manifestPath}`));
  }

  if (payload.warnings.length > 0) {
    w('');
    w(kleur.bold().yellow('Warnings:'));
    for (const warning of payload.warnings) w(`  ${warning}`);
  }

  w('');
  w(kleur.bold('Next steps:'));
  w('  - Restart your AI agent session (skills are scanned at startup) so it sees the new Skills.');
  w('  - Then the agent can drive Unity end-to-end, e.g.:');
  w(`    ${kleur.gray('uco install-unity')}          # install the official Unity CLI`);
  w(`    ${kleur.gray('uco create-project <dir>')}   # create a new Unity project`);
  w(`    ${kleur.gray('uco install <project>')}      # integrate the runtime (plugin + NuGet + config)`);
  w(`    ${kleur.gray('uco setup-skills')}           # compile live tool catalog (needs a running Editor)`);
  w(`    ${kleur.gray('uco update')}                 # refresh installed Skills / Unity toolchain after a uco upgrade`);
}
