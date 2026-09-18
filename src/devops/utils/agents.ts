import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Agent Definition
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  id: string;
  name: string;
  skillsPath: string | null;
  /**
   * Project-relative paths whose presence marks the agent as active at a
   * target (its config directory, e.g. `.claude`, `.cursor`). Purely advisory
   * input to install selection — detection never installs or removes anything.
   * Empty for agents with no reliable project-local marker (global-only config).
   */
  detectionPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Agent Registry
// ---------------------------------------------------------------------------


export const agentRegistry: readonly AgentDefinition[] = [
  // ── Claude Code ──────────────────────────────────────────────
  {
    id: 'claude-code',
    name: 'Claude Code',
    skillsPath: '.claude/skills',
    detectionPaths: ['.claude'],
  },

  // ── Claude Desktop ───────────────────────────────────────────
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    skillsPath: null,
    detectionPaths: [],
  },

  // ── Cursor ───────────────────────────────────────────────────
  {
    id: 'cursor',
    name: 'Cursor',
    skillsPath: '.cursor/skills',
    detectionPaths: ['.cursor'],
  },

  // ── VS Code (Copilot) ───────────────────────────────────────
  {
    id: 'vscode-copilot',
    name: 'Visual Studio Code (Copilot)',
    skillsPath: '.github/skills',
    detectionPaths: ['.vscode'],
  },

  // ── Visual Studio (Copilot) ──────────────────────────────────
  {
    id: 'vs-copilot',
    name: 'Visual Studio (Copilot)',
    skillsPath: '.github/skills',
    detectionPaths: ['.vs'],
  },

  // ── Rider (Junie) ───────────────────────────────────────────
  {
    id: 'rider-junie',
    name: 'Rider (Junie)',
    skillsPath: '.junie/skills',
    detectionPaths: ['.junie'],
  },

  // ── GitHub Copilot CLI ──────────────────────────────────────
  {
    id: 'github-copilot-cli',
    name: 'GitHub Copilot CLI',
    skillsPath: '.github/skills',
    // Config is user-global; the repo-local Copilot instructions file is the
    // only specific project marker (a bare `.github` probe would fire in
    // nearly every repository).
    detectionPaths: ['.github/copilot-instructions.md'],
  },

  // ── Gemini ──────────────────────────────────────────────────
  {
    id: 'gemini',
    name: 'Gemini',
    skillsPath: '.gemini/skills',
    detectionPaths: ['.gemini'],
  },

  // ── Antigravity ─────────────────────────────────────────────
  {
    id: 'antigravity',
    name: 'Antigravity',
    skillsPath: '.agent/skills',
    detectionPaths: ['.agent'],
  },

  // ── Cline ───────────────────────────────────────────────────
  {
    id: 'cline',
    name: 'Cline',
    skillsPath: '.cline/skills',
    detectionPaths: ['.cline'],
  },

  // ── Open Code ───────────────────────────────────────────────
  {
    id: 'open-code',
    name: 'Open Code',
    skillsPath: '.opencode/skills',
    detectionPaths: ['.opencode'],
  },

  // ── Codex ───────────────────────────────────────────────────
  {
    id: 'codex',
    name: 'Codex',
    skillsPath: '.codex/skills',
    detectionPaths: ['.codex'],
  },

  // ── Kilo Code ───────────────────────────────────────────────
  {
    id: 'kilo-code',
    name: 'Kilo Code',
    skillsPath: '.kilocode/skills',
    detectionPaths: ['.kilocode'],
  },

  // ── Windsurf ────────────────────────────────────────────────
  {
    id: 'windsurf',
    name: 'Windsurf',
    skillsPath: '.windsurf/skills',
    detectionPaths: ['.windsurf'],
  },

  // ── Unity AI ────────────────────────────────────────────────
  {
    id: 'unity-ai',
    name: 'Unity AI',
    skillsPath: null,
    detectionPaths: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function getAgentById(id: string): AgentDefinition | undefined {
  return agentRegistry.find((a) => a.id === id);
}

export function getAgentIds(): string[] {
  return agentRegistry.map((a) => a.id);
}

/** Registry entries that accept Skills installs — the install-selection surface. */
export function getSkillsCapableAgents(): AgentDefinition[] {
  return agentRegistry.filter((a) => a.skillsPath !== null);
}

export function getSkillsCapableAgentIds(): string[] {
  return getSkillsCapableAgents().map((a) => a.id);
}

/**
 * Detect which skills-capable agents already have a presence at a target by
 * probing each entry's detection paths (file or directory) under it. Advisory
 * only — detection never installs, refreshes, or removes anything.
 */
export function detectAgentsAt(target: string): string[] {
  const detected: string[] = [];
  for (const agent of getSkillsCapableAgents()) {
    if (agent.detectionPaths.some((relative) => fs.existsSync(path.join(target, relative)))) {
      detected.push(agent.id);
    }
  }
  return detected;
}

export interface AgentListEntry {
  id: string;
  name: string;
  skillsPath: string;
  detectionPaths: readonly string[];
}

/** Shared `--list` payload for commands that target skills-capable agents. */
export function listSkillsCapableAgents(): AgentListEntry[] {
  return getSkillsCapableAgents().map((agent) => ({
    id: agent.id,
    name: agent.name,
    skillsPath: agent.skillsPath as string,
    detectionPaths: agent.detectionPaths,
  }));
}

export function listAgentTable(
  heading: string,
  locationLabel: string,
  locationFn: (agent: AgentDefinition) => string,
): void {
  const sorted = [...agentRegistry].sort((a, b) => a.id.localeCompare(b.id));

  const colId = 'ID';
  const colLoc = locationLabel;

  const wId = Math.max(colId.length, ...sorted.map((a) => a.id.length));
  const wLoc = Math.max(colLoc.length, ...sorted.map((a) => locationFn(a).length));

  const sep = chalk.dim;
  const hBar = (w: number) => '\u2500'.repeat(w);

  console.log(`\n${chalk.bold.cyan(heading)}\n`);

  // Header
  console.log(
    sep('  \u250C\u2500') + sep(hBar(wId)) + sep('\u2500\u252C\u2500') + sep(hBar(wLoc)) + sep('\u2500\u2510'),
  );
  console.log(
    sep('  \u2502 ') + chalk.bold.white(colId.padEnd(wId)) + sep(' \u2502 ') + chalk.bold.white(colLoc.padEnd(wLoc)) + sep(' \u2502'),
  );
  console.log(
    sep('  \u251C\u2500') + sep(hBar(wId)) + sep('\u2500\u253C\u2500') + sep(hBar(wLoc)) + sep('\u2500\u2524'),
  );

  // Rows
  for (const agent of sorted) {
    const loc = locationFn(agent);
    console.log(
      sep('  \u2502 ') + chalk.yellow(agent.id.padEnd(wId)) + sep(' \u2502 ') + chalk.green(loc.padEnd(wLoc)) + sep(' \u2502'),
    );
  }

  // Footer
  console.log(
    sep('  \u2514\u2500') + sep(hBar(wId)) + sep('\u2500\u2534\u2500') + sep(hBar(wLoc)) + sep('\u2500\u2518'),
  );
  console.log('');
}
