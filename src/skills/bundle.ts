import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolCatalogEntry } from '../codegen/types.js';
import type { PromptInfo, ResourceInfo } from '../transport/index.js';
import { UCO_UNITY_PACKAGE_ID } from '../devops/utils/manifest.js';
import {
  canonicalJson,
  compareOrdinal,
  normalizeCatalogResponse,
  normalizeToolCatalog,
} from '../catalog.js';

export const ENTRY_SKILL_IDS = [
  'uco-setup',
  'unity-cli',
  'unity-editor',
] as const;

export type EntrySkillId = typeof ENTRY_SKILL_IDS[number];

export const DOMAIN_IDS = [
  'build-and-tests',
  'authoring',
  'code',
  'visuals',
  'physics',
  'diagnostics',
] as const;

export type SkillDomainId = typeof DOMAIN_IDS[number];

export interface SetupSkillBundleOptions {
  projectPath: string;
  skillsPath: string;
  tools: readonly ToolCatalogEntry[];
  prompts?: readonly PromptInfo[];
  resources?: readonly ResourceInfo[];
  ucoEntryPath?: string;
  dryRun?: boolean;
  migrateLegacy?: boolean;
}

export interface SetupSkillBundleResult {
  status: 'changed' | 'unchanged' | 'would-change';
  projectPath: string;
  destinations: Record<EntrySkillId, string>;
  supportDestination: string;
  skillEntryCount: 3;
  skillIds: typeof ENTRY_SKILL_IDS;
  toolCount: number;
  domainCounts: Record<SkillDomainId, number>;
  catalogFingerprint: string;
  written: string[];
  removed: string[];
  preserved: string[];
  warnings: string[];
}

interface PlannedFile {
  relativePath: string;
  content: string;
}

interface ToolIndexEntry {
  name: string;
  domain: SkillDomainId;
  enabled: boolean;
  title?: string;
  description?: string;
  readOnlyHint?: boolean | null;
  destructiveHint?: boolean | null;
  idempotentHint?: boolean | null;
  openWorldHint?: boolean | null;
}

interface OutputTarget {
  id: EntrySkillId | 'agent-runtime';
  destination: string;
  ownershipFile: string;
  files: PlannedFile[];
}

interface BundlePlan {
  projectPath: string;
  skillsRoot: string;
  destinations: Record<EntrySkillId, string>;
  supportDestination: string;
  targets: OutputTarget[];
  tools: ToolCatalogEntry[];
  domainCounts: Record<SkillDomainId, number>;
  catalogFingerprint: string;
  warnings: string[];
}

interface LegacyInspection {
  removable: string[];
  preserved: string[];
}

interface BackupRecord {
  destination: string;
  backup: string;
}

const BUNDLE_ID = 'uco-unity-three-surface-v2';
const BUNDLE_VERSION = 2;
/** bundle ids written by pre-rename (cocli) releases of this same bundle —
 *  still ours to replace, so ownership checks accept them. */
const LEGACY_BUNDLE_IDS = new Set(['cocli-unity-three-surface-v2']);
const V1_BUNDLE_ID = 'uco-unity-progressive-v1';
const LEGACY_V1_BUNDLE_IDS = new Set(['cocli-unity-progressive-v1']);
/** entry-skill directory names from pre-rename installs; superseded by the
 *  same id under its new name (cocli-setup -> uco-setup). */
const RENAMED_ENTRY_SKILLS = new Set(['cocli-setup']);
const V1_DIRECTORY_NAME = 'unity-copilot';
const V1_MANIFEST_PATH = 'catalog/bundle-manifest.json';
const SKILL_OWNERSHIP_PATH = '.uco-skill.json';
/** ownership marker filename written before the .cocli -> .uco leaf rename;
 *  accepted on read so pre-rename installs refresh in place. */
const LEGACY_SKILL_OWNERSHIP_PATH = '.cocli-skill.json';
const RUNTIME_MANIFEST_PATH = 'bundle-manifest.json';
const SUPPORT_RELATIVE_PATH = path.join('.uco', 'agent-runtime');
/** support directory used before the .cocli -> .uco leaf rename. */
const LEGACY_SUPPORT_RELATIVE_PATH = path.join('.cocli', 'agent-runtime');

function isOwnedBundleId(bundleId: unknown): boolean {
  return bundleId === BUNDLE_ID || LEGACY_BUNDLE_IDS.has(bundleId as string);
}

/** Ownership file path, falling back to the pre-rename marker filename so
 *  0.3.x installs refresh in place instead of being refused. The legacy file
 *  disappears with the next publish (targets are swapped wholesale). */
function resolveOwnershipFile(directory: string, ownershipFile: string): string {
  const current = path.join(directory, ownershipFile);
  if (fs.existsSync(current)) return current;
  if (ownershipFile === SKILL_OWNERSHIP_PATH) {
    const legacy = path.join(directory, LEGACY_SKILL_OWNERSHIP_PATH);
    if (fs.existsSync(legacy)) return legacy;
  }
  return current;
}

/** Remove the pre-rename `.cocli` support directory after a successful
 *  publish, but only when every entry is ours (bundle-owned agent-runtime,
 *  install manifest). Anything foreign is left in place. */
function removeLegacySupportDir(projectPath: string): void {
  const legacyRoot = path.join(projectPath, path.dirname(LEGACY_SUPPORT_RELATIVE_PATH));
  if (!fs.existsSync(legacyRoot)) return;
  try {
    const entries = fs.readdirSync(legacyRoot);
    const known = new Set(['agent-runtime', 'install-manifest.json']);
    if (!entries.every((entry) => known.has(entry))) return;
    const bundleManifestPath = path.join(legacyRoot, 'agent-runtime', RUNTIME_MANIFEST_PATH);
    if (fs.existsSync(bundleManifestPath)) {
      const ownership = JSON.parse(fs.readFileSync(bundleManifestPath, 'utf8')) as Record<string, unknown>;
      if (!isOwnedBundleId(ownership.bundleId)) return;
    }
    fs.rmSync(legacyRoot, { recursive: true, force: false });
  } catch {
    // Unreadable or foreign — leave it; a stale dir is harmless.
  }
}

function isV1BundleId(bundleId: unknown): boolean {
  return bundleId === V1_BUNDLE_ID || LEGACY_V1_BUNDLE_IDS.has(bundleId as string);
}
const TEMPLATE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills',
);

const STATIC_SKILL_FILES: Record<EntrySkillId, readonly string[]> = {
  'uco-setup': [
    'SKILL.md',
    'agents/openai.yaml',
    'references/recovery.md',
  ],
  'unity-cli': [
    'SKILL.md',
    'agents/openai.yaml',
    'references/installation-projects.md',
    'references/automation-services.md',
  ],
  'unity-editor': [
    'SKILL.md',
    'agents/openai.yaml',
  ],
};

const VISUAL_ASSET_TOOLS = new Set([
  'assets-material-create',
  'assets-shader-get-data',
  'assets-shader-list-all',
]);

const LEGACY_SYSTEM_SKILLS = new Set([
  'ping',
  'unity-initial-setup',
  'unity-skill-create',
  'unity-skill-generate',
]);

const PREFIX_DOMAIN: ReadonlyArray<readonly [string, SkillDomainId]> = [
  ['batch-', 'build-and-tests'],
  ['build-', 'build-and-tests'],
  ['tests-', 'build-and-tests'],
  ['gameobject-', 'authoring'],
  ['object-', 'authoring'],
  ['scene-', 'authoring'],
  ['assets-', 'authoring'],
  ['docs-', 'code'],
  ['package-', 'code'],
  ['reflection-', 'code'],
  ['script-', 'code'],
  ['type-', 'code'],
  ['camera-', 'visuals'],
  ['graphics-', 'visuals'],
  ['screenshot-', 'visuals'],
  ['texture-', 'visuals'],
  ['ui-', 'visuals'],
  ['vfx-', 'visuals'],
  ['physics-', 'physics'],
  ['console-', 'diagnostics'],
  ['editor-', 'diagnostics'],
  ['frame-', 'diagnostics'],
  ['instance-', 'diagnostics'],
  ['profiler-', 'diagnostics'],
  ['tool-', 'diagnostics'],
  ['tools-', 'diagnostics'],
  ['unity-', 'diagnostics'],
];

export function classifyTool(name: string): SkillDomainId {
  if (VISUAL_ASSET_TOOLS.has(name)) return 'visuals';
  return knownDomain(name) ?? 'diagnostics';
}

export function getDefaultCocliEntryPath(): string {
  // New wrappers point at the `uco` bin; the deprecated `cocli` bin keeps
  // working as an alias, so wrappers installed by older versions resolve too.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/uco.mjs');
}

export async function setupSkillBundle(
  options: SetupSkillBundleOptions,
): Promise<SetupSkillBundleResult> {
  const plan = planSkillBundle(options);
  assertManagedTargets(plan.targets);

  const managedV1 = inspectManagedV1(plan.skillsRoot);
  const legacy = options.migrateLegacy
    ? inspectLegacySkills(plan.skillsRoot, new Set(plan.tools.map((tool) => tool.name)))
    : { removable: [], preserved: [] };
  const changedFiles = plan.targets.flatMap((target) => findChangedFiles(plan, target));
  const removable = [
    ...(managedV1.removable.length > 0 ? [V1_DIRECTORY_NAME] : []),
    ...legacy.removable.map((entry) => path.basename(entry)),
  ];
  const preserved = [...managedV1.preserved, ...legacy.preserved].sort();
  if (managedV1.preserved.length > 0) {
    plan.warnings.push('An unrecognized unity-copilot directory was preserved during v2 setup.');
  }
  const outputsNeedPublish = changedFiles.length > 0 || managedV1.removable.length > 0;
  const wouldChange = outputsNeedPublish || legacy.removable.length > 0;

  if (options.dryRun) {
    return resultFromPlan(plan, {
      status: wouldChange ? 'would-change' : 'unchanged',
      written: changedFiles,
      removed: removable,
      preserved,
    });
  }

  if (outputsNeedPublish) {
    publishBundle(plan, managedV1.removable[0]);
    removeLegacySupportDir(plan.projectPath);
  }

  for (const directory of legacy.removable) {
    assertDescendant(plan.skillsRoot, directory);
    fs.rmSync(directory, { recursive: true, force: false });
  }

  return resultFromPlan(plan, {
    status: wouldChange ? 'changed' : 'unchanged',
    written: changedFiles,
    removed: removable,
    preserved,
  });
}

function planSkillBundle(options: SetupSkillBundleOptions): BundlePlan {
  const projectPath = path.resolve(options.projectPath);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Unity project directory does not exist: ${projectPath}`);
  }
  const skillsPath = validateProjectRelativeSkillsPath(options.skillsPath);
  const skillsRoot = path.resolve(projectPath, skillsPath);
  assertDescendant(projectPath, skillsRoot);
  const destinations = Object.fromEntries(ENTRY_SKILL_IDS.map((skillId) => [
    skillId,
    path.join(skillsRoot, skillId),
  ])) as Record<EntrySkillId, string>;
  const supportDestination = path.resolve(projectPath, SUPPORT_RELATIVE_PATH);
  assertDescendant(projectPath, supportDestination);

  const tools = normalizeTools(options.tools);
  const warnings: string[] = [];
  const index: ToolIndexEntry[] = tools.map((tool) => {
    const domain = classifyTool(tool.name);
    if (knownDomain(tool.name) === undefined && !VISUAL_ASSET_TOOLS.has(tool.name)) {
      warnings.push(`Unrecognized tool prefix routed to diagnostics: ${tool.name}`);
    }
    const entry: ToolIndexEntry = {
      name: tool.name,
      domain,
      enabled: tool.enabled,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
    };
    copySafetyHints(tool, entry);
    return entry;
  });
  const domainCounts = emptyDomainCounts();
  for (const entry of index) domainCounts[entry.domain] += 1;

  const prompts = [...(options.prompts ?? [])].sort((a, b) => compareOrdinal(a.name, b.name));
  const resources = [...(options.resources ?? [])].sort((a, b) => compareOrdinal(a.uri, b.uri));
  const catalogJson = stableJson(tools);
  const catalogFingerprint = createHash('sha256').update(catalogJson).digest('hex');
  const targets = ENTRY_SKILL_IDS.map((skillId) => buildSkillTarget(
    skillId,
    destinations[skillId],
    tools,
    prompts,
    resources,
  ));
  targets.push(buildRuntimeTarget(
    supportDestination,
    projectPath,
    path.resolve(options.ucoEntryPath ?? getDefaultCocliEntryPath()),
    tools,
    index,
    domainCounts,
    catalogFingerprint,
    skillsPath,
    prompts,
    resources,
  ));

  return {
    projectPath,
    skillsRoot,
    destinations,
    supportDestination,
    targets,
    tools,
    domainCounts,
    catalogFingerprint,
    warnings,
  };
}

function buildSkillTarget(
  skillId: EntrySkillId,
  destination: string,
  tools: readonly ToolCatalogEntry[],
  prompts: readonly PromptInfo[],
  resources: readonly ResourceInfo[],
): OutputTarget {
  const files = STATIC_SKILL_FILES[skillId].map((relativePath) => (
    templateFile(skillId, relativePath)
  ));
  if (skillId === 'unity-editor') {
    for (const domain of DOMAIN_IDS) {
      files.push({
        relativePath: `references/${domain}.md`,
        content: renderDomainReference(
          domain,
          tools.filter((tool) => classifyTool(tool.name) === domain),
        ),
      });
    }
    files.push({ relativePath: 'references/prompts.md', content: renderPromptReference(prompts) });
    files.push({ relativePath: 'references/resources.md', content: renderResourceReference(resources) });
  }
  const managedFiles = [...files.map((file) => file.relativePath), SKILL_OWNERSHIP_PATH].sort();
  files.push({
    relativePath: SKILL_OWNERSHIP_PATH,
    content: stableJson({
      bundleId: BUNDLE_ID,
      bundleVersion: BUNDLE_VERSION,
      skillId,
      managedFiles,
    }),
  });
  files.sort(comparePlannedFiles);
  return {
    id: skillId,
    destination,
    ownershipFile: SKILL_OWNERSHIP_PATH,
    files,
  };
}

function buildRuntimeTarget(
  destination: string,
  projectPath: string,
  ucoEntryPath: string,
  tools: ToolCatalogEntry[],
  index: ToolIndexEntry[],
  domainCounts: Record<SkillDomainId, number>,
  catalogFingerprint: string,
  skillsPath: string,
  prompts: readonly PromptInfo[],
  resources: readonly ResourceInfo[],
): OutputTarget {
  const files: PlannedFile[] = [
    templateFile('unity-editor', 'scripts/uco.mjs'),
    templateFile('unity-editor', 'scripts/tool-info.mjs'),
    { relativePath: 'catalog/tools.json', content: stableJson(tools) },
    { relativePath: 'catalog/tool-index.json', content: stableJson(index) },
    { relativePath: 'catalog/prompts.json', content: stableJson(prompts) },
    { relativePath: 'catalog/resources.json', content: stableJson(resources) },
    {
      relativePath: 'catalog/project.json',
      content: stableJson({ projectPath, ucoEntryPath }),
    },
  ];
  const managedFiles = [...files.map((file) => file.relativePath), RUNTIME_MANIFEST_PATH].sort();
  files.push({
    relativePath: RUNTIME_MANIFEST_PATH,
    content: stableJson({
      bundleId: BUNDLE_ID,
      bundleVersion: BUNDLE_VERSION,
      skillIds: ENTRY_SKILL_IDS,
      skillsPath,
      catalogFingerprint,
      toolCount: tools.length,
      domainCounts,
      managedFiles,
    }),
  });
  files.sort(comparePlannedFiles);
  return {
    id: 'agent-runtime',
    destination,
    ownershipFile: RUNTIME_MANIFEST_PATH,
    files,
  };
}

function buildStaticSupportTarget(
  destination: string,
  tools: ToolCatalogEntry[],
  index: ToolIndexEntry[],
  domainCounts: Record<SkillDomainId, number>,
  catalogFingerprint: string,
  skillsPath: string,
): OutputTarget {
  const files: PlannedFile[] = [
    { relativePath: 'catalog/tools.json', content: stableJson(tools) },
    { relativePath: 'catalog/tool-index.json', content: stableJson(index) },
  ];
  const managedFiles = [...files.map((file) => file.relativePath), RUNTIME_MANIFEST_PATH].sort();
  files.push({
    relativePath: RUNTIME_MANIFEST_PATH,
    content: stableJson({
      bundleId: BUNDLE_ID,
      bundleVersion: BUNDLE_VERSION,
      skillIds: ENTRY_SKILL_IDS,
      skillsPath,
      catalogFingerprint,
      toolCount: tools.length,
      domainCounts,
      managedFiles,
    }),
  });
  files.sort(comparePlannedFiles);
  return {
    id: 'agent-runtime',
    destination,
    ownershipFile: RUNTIME_MANIFEST_PATH,
    files,
  };
}

function normalizeTools(tools: readonly ToolCatalogEntry[]): ToolCatalogEntry[] {
  if (tools.length === 0) {
    throw new Error('Unity tool catalog is empty; wait for the Editor plugin to register its tools.');
  }
  return normalizeToolCatalog(tools);
}

function knownDomain(name: string): SkillDomainId | undefined {
  for (const [prefix, domain] of PREFIX_DOMAIN) {
    if (name.startsWith(prefix)) return domain;
  }
  return undefined;
}

function emptyDomainCounts(): Record<SkillDomainId, number> {
  return {
    'build-and-tests': 0,
    authoring: 0,
    code: 0,
    visuals: 0,
    physics: 0,
    diagnostics: 0,
  };
}

function templateFile(skillId: EntrySkillId, relativePath: string): PlannedFile {
  return {
    relativePath,
    content: readTemplate(skillId, relativePath),
  };
}

function readTemplate(skillId: EntrySkillId, relativePath: string): string {
  const skillRoot = path.resolve(TEMPLATE_ROOT, skillId);
  const templatePath = path.resolve(skillRoot, relativePath);
  assertDescendant(skillRoot, templatePath);
  return ensureFinalNewline(fs.readFileSync(templatePath, 'utf8'));
}

function renderDomainReference(domain: SkillDomainId, tools: readonly ToolCatalogEntry[]): string {
  const base = readTemplate('unity-editor', `references/${domain}.md`).trimEnd();
  if (tools.length === 0) return `${base}\n\n_No tools in the current live catalog._\n`;
  const groups = new Map<string, ToolCatalogEntry[]>();
  for (const tool of tools) {
    const group = tool.name.split('-', 1)[0] ?? tool.name;
    const entries = groups.get(group) ?? [];
    entries.push(tool);
    groups.set(group, entries);
  }
  const blocks = [...groups.entries()]
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([group, entries]) => {
      const toolBlocks = entries
        .sort((a, b) => compareOrdinal(a.name, b.name))
        .map((tool) => renderToolDefinition(tool))
        .join('\n\n');
      return `### ${group}\n\n${toolBlocks}`;
    });
  return `${base}\n\n${blocks.join('\n\n')}\n`;
}

function renderToolDefinition(tool: ToolCatalogEntry): string {
  let block = `#### \`${tool.name}\`${tool.enabled ? '' : ' (disabled)'}\n\n`;
  if (tool.description) block += `${tool.description}\n\n`;
  block += `**Safety hints (descriptive):** ${renderSafetyHints(tool)}\n\n`;
  const params = extractParams(tool.inputSchema);
  if (params.length > 0) {
    block += '**Parameters:**\n\n';
    block += params
      .map((p) => `- \`${p.name}\` (${p.type}${p.required ? ', required' : ''})${p.description ? ` — ${p.description}` : ''}`)
      .join('\n');
    block += '\n';
  }
  return block.trimEnd();
}

function extractParams(inputSchema: unknown): Array<{ name: string; type: string; required: boolean; description?: string }> {
  if (!inputSchema || typeof inputSchema !== 'object') return [];
  const schema = inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  if (!schema.properties) return [];
  const requiredSet = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: prop.type ?? 'any',
    required: requiredSet.has(name),
    description: prop.description,
  }));
}

function renderPromptReference(prompts: readonly PromptInfo[]): string {
  const base = readTemplate('unity-editor', 'references/prompts.md').trimEnd();
  if (prompts.length === 0) return `${base}\n\n_No prompts in the current live catalog._\n`;
  const rows = [...prompts]
    .sort((a, b) => compareOrdinal(a.name, b.name))
    .map((p) => {
      const parts = [`\`${p.name}\``];
      if (p.description) parts.push(`— ${p.description}`);
      return `- ${parts.join(' ')}`;
    });
  return `${base}\n\n${rows.join('\n')}\n`;
}

function renderResourceReference(resources: readonly ResourceInfo[]): string {
  const base = readTemplate('unity-editor', 'references/resources.md').trimEnd();
  if (resources.length === 0) return `${base}\n\n_No resources in the current live catalog._\n`;
  const groups = new Map<string, ResourceInfo[]>();
  for (const r of resources) {
    const scheme = r.uri.split(':', 1)[0] ?? r.uri;
    const list = groups.get(scheme) ?? [];
    list.push(r);
    groups.set(scheme, list);
  }
  const rows = [...groups.entries()]
    .sort(([a], [b]) => compareOrdinal(a, b))
    .map(([scheme, list]) => {
      const items = list
        .sort((a, b) => compareOrdinal(a.uri, b.uri))
        .map((r) => `\`${r.uri}\`${r.name ? ` (${r.name})` : ''}`);
      return `- **${scheme}**: ${items.join(', ')}`;
    });
  return `${base}\n\n${rows.join('\n')}\n`;
}

function stableJson(value: unknown): string {
  return canonicalJson(value);
}

function ensureFinalNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function comparePlannedFiles(left: PlannedFile, right: PlannedFile): number {
  return compareOrdinal(left.relativePath, right.relativePath);
}

function validateProjectRelativeSkillsPath(value: string): string {
  const trimmed = value.trim();
  const segments = trimmed.replace(/\\/g, '/').split('/');
  if (
    trimmed === ''
    || path.isAbsolute(trimmed)
    || path.win32.isAbsolute(trimmed)
    || segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Skills path must be a safe project-relative path: ${value}`);
  }
  return trimmed;
}

function findChangedFiles(plan: BundlePlan, target: OutputTarget): string[] {
  return target.files
    .filter((file) => {
      const installedPath = path.join(target.destination, file.relativePath);
      if (!fs.existsSync(installedPath) || !fs.statSync(installedPath).isFile()) return true;
      return fs.readFileSync(installedPath, 'utf8') !== file.content;
    })
    .map((file) => projectRelative(plan.projectPath, path.join(target.destination, file.relativePath)));
}

function publishBundle(plan: BundlePlan, obsoleteV1?: string): void {
  assertManagedTargets(plan.targets);
  if (obsoleteV1) assertDescendant(plan.skillsRoot, obsoleteV1);

  const nonce = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const stagingRoot = path.join(plan.projectPath, `.uco-skill-stage-${nonce}`);
  const backups: BackupRecord[] = [];
  const published: string[] = [];
  assertDescendant(plan.projectPath, stagingRoot);

  try {
    fs.mkdirSync(stagingRoot);
    plan.targets.forEach((target, index) => {
      const stagedTarget = path.join(stagingRoot, String(index));
      fs.mkdirSync(stagedTarget);
      for (const file of target.files) {
        const installedPath = path.join(stagedTarget, file.relativePath);
        assertDescendant(stagedTarget, installedPath);
        fs.mkdirSync(path.dirname(installedPath), { recursive: true });
        fs.writeFileSync(installedPath, file.content, { encoding: 'utf8' });
        assertStrictUtf8(installedPath);
      }
    });

    if (obsoleteV1) backupExisting(plan.projectPath, obsoleteV1, nonce, backups);
    plan.targets.forEach((target) => {
      backupExisting(plan.projectPath, target.destination, nonce, backups);
    });

    plan.targets.forEach((target, index) => {
      const stagedTarget = path.join(stagingRoot, String(index));
      fs.mkdirSync(path.dirname(target.destination), { recursive: true });
      fs.renameSync(stagedTarget, target.destination);
      published.push(target.destination);
    });
  } catch (error) {
    rollbackPublish(plan.projectPath, published, backups);
    throw error;
  } finally {
    if (fs.existsSync(stagingRoot)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  for (const record of backups) {
    if (fs.existsSync(record.backup)) {
      fs.rmSync(record.backup, { recursive: true, force: false });
    }
  }
}

function backupExisting(
  projectPath: string,
  destination: string,
  nonce: string,
  backups: BackupRecord[],
): void {
  if (!fs.existsSync(destination)) return;
  assertDescendant(projectPath, destination);
  const backup = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.backup-${nonce}`,
  );
  assertDescendant(projectPath, backup);
  fs.renameSync(destination, backup);
  backups.push({ destination, backup });
}

function rollbackPublish(
  projectPath: string,
  published: string[],
  backups: BackupRecord[],
): void {
  for (const destination of [...published].reverse()) {
    assertDescendant(projectPath, destination);
    if (fs.existsSync(destination)) {
      fs.rmSync(destination, { recursive: true, force: true });
    }
  }
  for (const record of [...backups].reverse()) {
    assertDescendant(projectPath, record.destination);
    assertDescendant(projectPath, record.backup);
    if (fs.existsSync(record.backup) && !fs.existsSync(record.destination)) {
      fs.renameSync(record.backup, record.destination);
    }
  }
}

function assertManagedTargets(targets: OutputTarget[]): void {
  for (const target of targets) assertManagedTarget(target);
}

function assertManagedTarget(target: OutputTarget): void {
  if (!fs.existsSync(target.destination)) return;
  const ownershipPath = resolveOwnershipFile(target.destination, target.ownershipFile);
  if (!fs.existsSync(ownershipPath)) {
    throw new Error(`Refusing to replace unmanaged Skill output: ${target.destination}`);
  }
  const ownership = readOwnership(ownershipPath, target.destination);
  const expectedId = target.id === 'agent-runtime' ? undefined : target.id;
  if (
    !isOwnedBundleId(ownership.bundleId)
    || ownership.bundleVersion !== BUNDLE_VERSION
    || (expectedId !== undefined && ownership.skillId !== expectedId)
    || !validManagedFiles(ownership.managedFiles)
  ) {
    throw new Error(`Refusing to replace output with an invalid ownership manifest: ${target.destination}`);
  }
  assertNoUnmanagedFiles(target.destination, ownership.managedFiles as string[], {
    // resolveOwnershipFile may have fallen back to the pre-rename marker
    // (.uco-skill.json renamed to .cocli-skill.json by a 0.3.x install).
    // That file IS the ownership manifest we just validated — it must not
    // count as unmanaged, or the in-place refresh of every pre-rename
    // install is refused by its own marker.
    alsoAllow: path.basename(ownershipPath),
  });
}

/**
 * True when an entry-skill directory under a skills root is a uco-owned
 * managed output: present on disk, carrying a parseable `.uco-skill.json`
 * for the current bundle whose `skillId` matches and whose inventory matches
 * the directory contents. The non-throwing twin of the ownership guard in
 * {@link assertManagedTarget}; the install-manifest seed uses it to recognize
 * pre-manifest installs, and deselection cleanup refuses to remove any
 * directory it rejects. An entry the walk cannot classify (a symlink or
 * junction inside the directory) makes the inventory unverifiable, so the
 * directory is treated as not uco-owned — callers warn and skip it rather
 * than crash; it is never deleted on that basis.
 */
export function isCocliOwnedSkillDirectory(skillsRoot: string, skillId: EntrySkillId): boolean {
  const destination = path.join(skillsRoot, skillId);
  if (!fs.existsSync(destination) || !fs.statSync(destination).isDirectory()) return false;
  const ownershipPath = resolveOwnershipFile(destination, SKILL_OWNERSHIP_PATH);
  if (!fs.existsSync(ownershipPath)) return false;
  let ownership: Record<string, unknown>;
  try {
    ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    !isOwnedBundleId(ownership.bundleId)
    || ownership.skillId !== skillId
    || !validManagedFiles(ownership.managedFiles)
  ) {
    return false;
  }
  const managedFiles = new Set(ownership.managedFiles as string[]);
  let inventory: string[];
  try {
    inventory = listRelativeFiles(destination);
  } catch {
    // Unsupported entry (symlink/junction): ownership cannot be verified.
    return false;
  }
  const unmanagedFiles = inventory.filter((entry) => !managedFiles.has(entry));
  return unmanagedFiles.length === 0;
}

function inspectManagedV1(skillsRoot: string): LegacyInspection {
  const destination = path.join(skillsRoot, V1_DIRECTORY_NAME);
  if (!fs.existsSync(destination)) return { removable: [], preserved: [] };
  const manifestPath = path.join(destination, V1_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) return { removable: [], preserved: [V1_DIRECTORY_NAME] };
  let ownership: Record<string, unknown>;
  try {
    ownership = readOwnership(manifestPath, destination);
  } catch {
    return { removable: [], preserved: [V1_DIRECTORY_NAME] };
  }
  if (!isV1BundleId(ownership.bundleId)) {
    return { removable: [], preserved: [V1_DIRECTORY_NAME] };
  }
  if (!validManagedFiles(ownership.managedFiles)) {
    throw new Error(`Refusing to migrate v1 with an invalid ownership manifest: ${destination}`);
  }
  assertNoUnmanagedFiles(destination, ownership.managedFiles as string[]);
  return { removable: [destination], preserved: [] };
}

function readOwnership(filePath: string, destination: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`Refusing to replace output with an invalid ownership manifest: ${destination}`);
  }
}

function validManagedFiles(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && isSafeRelativePath(entry));
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return normalized !== ''
    && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value)
    && segments.every((segment) => segment !== '' && segment !== '..');
}

function assertNoUnmanagedFiles(
  destination: string,
  managedEntries: string[],
  options: { alsoAllow?: string } = {},
): void {
  const managedFiles = new Set(managedEntries);
  if (options.alsoAllow !== undefined) managedFiles.add(options.alsoAllow);
  const unmanagedFiles = listRelativeFiles(destination)
    .filter((entry) => !managedFiles.has(entry));
  if (unmanagedFiles.length > 0) {
    throw new Error(
      `Refusing to replace output containing unmanaged files: ${unmanagedFiles.join(', ')}`,
    );
  }
}

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute).replace(/\\/g, '/'));
      else throw new Error(`Unsupported generated bundle entry: ${absolute}`);
    }
  };
  visit(root);
  return files.sort();
}

function inspectLegacySkills(
  skillsRoot: string,
  toolNames: Set<string>,
): LegacyInspection {
  if (!fs.existsSync(skillsRoot)) return { removable: [], preserved: [] };
  const removable: string[] = [];
  const preserved: string[] = [];
  const entrySkills = new Set<string>(ENTRY_SKILL_IDS);
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entrySkills.has(entry.name) || entry.name === V1_DIRECTORY_NAME) {
      continue;
    }
    if (RENAMED_ENTRY_SKILLS.has(entry.name)) {
      const directory = path.join(skillsRoot, entry.name);
      if (isOwnedRenamedEntrySkill(directory)) removable.push(directory);
      else preserved.push(entry.name);
      continue;
    }
    if (!toolNames.has(entry.name) && !LEGACY_SYSTEM_SKILLS.has(entry.name)) continue;
    const directory = path.join(skillsRoot, entry.name);
    if (isRecognizableLegacyLeaf(directory, entry.name)) removable.push(directory);
    else preserved.push(entry.name);
  }
  removable.sort();
  preserved.sort();
  return { removable, preserved };
}

/**
 * A renamed entry-skill directory (e.g. cocli-setup) is ours to remove when it
 * still carries a parseable `.uco-skill.json` owned by this bundle (current
 * or legacy bundle id) whose managedFiles still match the directory inventory.
 * Anything else — missing marker, foreign bundle, user-added files — is
 * preserved for manual review.
 */
function isOwnedRenamedEntrySkill(directory: string): boolean {
  const markerPath = path.join(directory, SKILL_OWNERSHIP_PATH);
  if (!fs.existsSync(markerPath)) return false;
  try {
    const ownership = readOwnership(markerPath, directory);
    if (!isOwnedBundleId(ownership.bundleId)) return false;
    assertNoUnmanagedFiles(directory, ownership.managedFiles as string[]);
    return true;
  } catch {
    return false;
  }
}

function isRecognizableLegacyLeaf(directory: string, name: string): boolean {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || entries[0].name !== 'SKILL.md') return false;
  const content = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matchingName = new RegExp(`^---\\r?\\n(?:.|\\r?\\n)*?name:\\s*["']?${escaped}["']?\\s*\\r?\\n`, 'm')
    .test(content);
  const generatorMarker = content.includes('## How to Call')
    && (content.includes('uco') || content.includes('cocli') || content.includes('unity-mcp-cli'));
  return matchingName && generatorMarker;
}

function assertStrictUtf8(filePath: string): void {
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error(`Generated file unexpectedly contains a UTF-8 BOM: ${filePath}`);
  }
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const LIVE_RUNTIME_SCRIPTS = ['scripts/uco.mjs', 'scripts/tool-info.mjs'] as const;

export interface LiveRuntimeRefreshResult {
  status: 'updated' | 'unchanged' | 'would-change';
  /** Refreshed files, relative to the runtime directory. */
  written: string[];
  warnings: string[];
}

/**
 * Refresh the script files of a LIVE-installed `.uco/agent-runtime` (one
 * produced by `uco setup-skills`, marked by `catalog/project.json`) from the
 * current templates while leaving the live catalog content in place — the
 * live-catalog non-regression rule. Only files the runtime's own ownership
 * manifest lists as managed are refreshed. A runtime without a live catalog
 * is not handled here (the static republish path covers it).
 */
export function refreshLiveAgentRuntimeScripts(options: {
  projectPath: string;
  dryRun?: boolean;
  force?: boolean;
}): LiveRuntimeRefreshResult {
  const runtime = path.resolve(options.projectPath, SUPPORT_RELATIVE_PATH);
  const manifestPath = path.join(runtime, RUNTIME_MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    return { status: 'unchanged', written: [], warnings: [] };
  }
  if (!fs.existsSync(path.join(runtime, 'catalog', 'project.json'))) {
    return { status: 'unchanged', written: [], warnings: [] };
  }
  let ownership: Record<string, unknown>;
  try {
    ownership = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {
      status: 'unchanged',
      written: [],
      warnings: [`Runtime ownership manifest is unparseable; scripts left untouched: ${manifestPath}`],
    };
  }
  if (!isOwnedBundleId(ownership.bundleId) || ownership.bundleVersion !== BUNDLE_VERSION
    || !validManagedFiles(ownership.managedFiles)) {
    return {
      status: 'unchanged',
      written: [],
      warnings: [`Runtime ownership manifest has an invalid managed-files list; scripts left untouched: ${manifestPath}`],
    };
  }
  const managed = new Set(ownership.managedFiles as string[]);

  const written: string[] = [];
  const warnings: string[] = [];
  const scriptsPath = path.join(runtime, 'scripts');
  const scriptsInfo = fs.lstatSync(scriptsPath, { throwIfNoEntry: false });
  const resolvedRelative = path.relative(fs.realpathSync(options.projectPath), fs.realpathSync(runtime));
  if (fs.lstatSync(runtime).isSymbolicLink() || fs.lstatSync(manifestPath).isSymbolicLink()
    || resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)
    || (scriptsInfo && (!scriptsInfo.isDirectory() || scriptsInfo.isSymbolicLink()))) {
    return { status: 'unchanged', written: [], warnings: ['Runtime script refresh refused: linked or non-directory paths.'] };
  }
  for (const relativePath of LIVE_RUNTIME_SCRIPTS) {
    const installedPath = path.join(runtime, relativePath);
    assertDescendant(runtime, installedPath);
    const installedInfo = fs.lstatSync(installedPath, { throwIfNoEntry: false });
    if (!managed.has(relativePath)) continue;
    if (installedInfo && !installedInfo.isFile()) {
      warnings.push(`Non-regular runtime script preserved: ${relativePath}`);
      continue;
    }
    const content = readTemplate('unity-editor', relativePath);
    const needsWrite = options.force === true
      || !fs.existsSync(installedPath)
      || !fs.statSync(installedPath).isFile()
      || fs.readFileSync(installedPath, 'utf8') !== content;
    if (!needsWrite) continue;
    written.push(relativePath);
    if (options.dryRun !== true) {
      fs.mkdirSync(path.dirname(installedPath), { recursive: true });
      fs.writeFileSync(installedPath, content, 'utf8');
      assertStrictUtf8(installedPath);
    }
  }
  const status: LiveRuntimeRefreshResult['status'] = options.dryRun === true
    ? (written.length > 0 ? 'would-change' : 'unchanged')
    : (written.length > 0 ? 'updated' : 'unchanged');
  return { status, written, warnings };
}

function assertDescendant(parent: string, candidate: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new Error(`Path escapes the intended directory: ${candidate}`);
}

function projectRelative(projectPath: string, target: string): string {
  return path.relative(projectPath, target).replace(/\\/g, '/');
}

function resultFromPlan(
  plan: BundlePlan,
  changes: Pick<SetupSkillBundleResult, 'status' | 'written' | 'removed' | 'preserved'>,
): SetupSkillBundleResult {
  return {
    ...changes,
    projectPath: plan.projectPath,
    destinations: plan.destinations,
    supportDestination: plan.supportDestination,
    skillEntryCount: 3,
    skillIds: ENTRY_SKILL_IDS,
    toolCount: plan.tools.length,
    domainCounts: plan.domainCounts,
    catalogFingerprint: plan.catalogFingerprint,
    warnings: plan.warnings,
  };
}

export interface InstallStaticOptions {
  /** Root selected by `uco init`; all generated output must remain below it. */
  projectPath: string;
  skillsRoot: string;
  dryRun?: boolean;
  /** Tools from the plugin's offline manifest. When provided, the unity-editor
   *  skill's reference docs are populated with tool definitions. When absent
   *  or empty, the reference docs show the "no tools" placeholder (graceful
   *  offline fallback for older plugins without a manifest). */
  tools?: readonly ToolCatalogEntry[];
  /**
   * Skills path recorded in the shared `.uco/agent-runtime` bundle manifest.
   * With several agents installed from one target the runtime is published
   * once per call, so callers pass the primary agent's path here to keep the
   * recorded value (and therefore the output bytes) stable across calls.
   * Defaults to this call's own skills root.
   */
  runtimeSkillsPath?: string;
  /** Republish even when every planned file is content-identical (`--force`). */
  force?: boolean;
  /**
   * Skip the shared `.uco/agent-runtime` target in this call. `uco update`
   * sets it per agent when a live catalog is installed (the live runtime
   * carries files beyond the static managed set) and refreshes the runtime
   * separately via {@link refreshLiveAgentRuntimeScripts}.
   */
  skipRuntime?: boolean;
}

export interface InstallStaticResult {
  status: 'changed' | 'unchanged' | 'would-change';
  skillsRoot: string;
  destinations: Record<EntrySkillId, string>;
  supportDestination: string;
  written: string[];
  warnings: string[];
  /** Number of tools from the manifest baked into the reference docs (0 = offline fallback). */
  toolCount: number;
}

/**
 * Install the three uco entry Skills as STATIC templates (no live tool
 * catalog) into an arbitrary skills directory — the bootstrap path used by
 * `uco init`. Unlike setupSkillBundle, this needs no Unity project and no
 * running server: it writes the fixed SKILL.md / agents / reference files plus
 * an ownership manifest whose format matches setupSkillBundle, so a later
 * `uco setup-skills` in the same directory can recognize and refresh them
 * with the live catalog. It also publishes the same hidden agent-runtime
 * support catalog/index as live setup, rooted safely below the init target;
 * project-bound scripts and project.json remain deferred to live setup.
 *
 * When `options.tools` is provided (from the plugin's offline tools-manifest.json),
 * the unity-editor skill's domain reference docs are populated with real tool
 * definitions instead of the "no tools" placeholder. This gives the agent an
 * eager preview of the tool surface before any server is running. The live
 * `setup-skills` command later replaces these with the authoritative catalog.
 */
export function installStaticSkillBundle(options: InstallStaticOptions): InstallStaticResult {
  const projectPath = path.resolve(options.projectPath);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Init target directory does not exist: ${projectPath}`);
  }
  const skillsRoot = path.resolve(options.skillsRoot);
  assertDescendant(projectPath, skillsRoot);
  const destinations = Object.fromEntries(
    ENTRY_SKILL_IDS.map((id) => [id, path.join(skillsRoot, id)]),
  ) as Record<EntrySkillId, string>;

  // Sort provided tools (manifest snapshot) or fall back to empty array.
  const providedTools = options.tools ?? [];
  const tools = providedTools.length > 0 ? normalizeToolCatalog(providedTools) : [];
  const emptyPrompts: PromptInfo[] = [];
  const emptyResources: ResourceInfo[] = [];
  const warnings: string[] = [];
  const index: ToolIndexEntry[] = tools.map((tool) => {
    const domain = classifyTool(tool.name);
    if (knownDomain(tool.name) === undefined && !VISUAL_ASSET_TOOLS.has(tool.name)) {
      warnings.push(`Unrecognized tool prefix routed to diagnostics: ${tool.name}`);
    }
    const entry: ToolIndexEntry = {
      name: tool.name,
      domain,
      enabled: tool.enabled,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description ? { description: tool.description } : {}),
    };
    copySafetyHints(tool, entry);
    return entry;
  });
  const domainCounts = emptyDomainCounts();
  for (const entry of index) domainCounts[entry.domain] += 1;
  const catalogFingerprint = createHash('sha256').update(stableJson(tools)).digest('hex');
  const supportDestination = path.resolve(projectPath, SUPPORT_RELATIVE_PATH);
  assertDescendant(projectPath, supportDestination);
  const targets = ENTRY_SKILL_IDS.map((skillId) =>
    buildSkillTarget(skillId, destinations[skillId], tools, emptyPrompts, emptyResources),
  );
  if (options.skipRuntime !== true) {
    targets.push(buildStaticSupportTarget(
      supportDestination,
      tools,
      index,
      domainCounts,
      catalogFingerprint,
      options.runtimeSkillsPath ?? projectRelative(projectPath, skillsRoot),
    ));
  }

  // Refuse to clobber a user-owned Skill directory (must carry a valid managed manifest).
  assertManagedTargets(targets);

  const written = targets.flatMap((target) => target.files
    .filter((file) => {
      const installedPath = path.join(target.destination, file.relativePath);
      return !fs.existsSync(installedPath)
        || !fs.statSync(installedPath).isFile()
        || fs.readFileSync(installedPath, 'utf8') !== file.content;
    })
    .map((file) => `${target.id}/${file.relativePath}`));

  if (!options.dryRun && (written.length > 0 || options.force === true)) {
    const plan: BundlePlan = {
      projectPath,
      skillsRoot,
      destinations,
      supportDestination,
      targets,
      tools,
      domainCounts,
      catalogFingerprint,
      warnings,
    };
    publishBundle(plan);
    removeLegacySupportDir(projectPath);
  }

  const status: InstallStaticResult['status'] = options.dryRun
    ? (written.length > 0 ? 'would-change' : 'unchanged')
    : (written.length > 0 ? 'changed' : 'unchanged');
  return {
    status,
    skillsRoot,
    destinations,
    supportDestination,
    written,
    warnings,
    toolCount: tools.length,
  };
}

// ---------------------------------------------------------------------------
// Offline tools-manifest support
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the plugin's <c>tools-manifest.json</c> by checking
 * standard locations: bundled <c>vendor/</c> first (self-contained tgz
 * install), then the dev workspace (local checkout). Returns the vendor path
 * as a default even if neither exists — the caller handles absence gracefully.
 *
 * The manifest is generated by the Unity editor script
 * <c>ToolsManifestGenerator.cs</c> (menu: Tools / AI Game Developer / Generate
 * Tools Manifest) and ships inside the plugin package at its root.
 */
export function resolvePluginManifestPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // bundle.ts is at src/skills/bundle.ts → ../../vendor
  const vendorRoot = path.resolve(here, '..', '..', 'vendor');
  const vendorManifest = path.join(vendorRoot, 'plugin', UCO_UNITY_PACKAGE_ID, 'tools-manifest.json');
  if (fs.existsSync(vendorManifest)) return vendorManifest;

  // Dev workspace: walk up to find uco-plugin + cocli (uco) siblings
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'uco-plugin')) && fs.existsSync(path.join(dir, 'cocli'))) {
      const devManifest = path.join(
        dir,
        'uco-plugin',
        'uco-unity-project',
        'Packages',
        UCO_UNITY_PACKAGE_ID,
        'tools-manifest.json',
      );
      if (fs.existsSync(devManifest)) return devManifest;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Default: return vendor path even if it doesn't exist yet.
  return vendorManifest;
}

/**
 * Read and parse a <c>tools-manifest.json</c> file — the offline snapshot of
 * the plugin's <c>/api/tools</c> catalog that ships with the package. Returns
 * an empty array if the file is absent or unparseable (graceful offline
 * fallback so <c>uco init</c> never crashes).
 *
 * The manifest entries are in the SAME shape as the server's <c>/api/tools</c>
 * response (the <c>ToolInfo</c> interface), so this function applies the same
 * <c>ToolInfo → ToolCatalogEntry</c> mapping that <c>setup-skills</c> uses for
 * the live path — no new format.
 */
export function loadToolsFromManifest(manifestPath: string): ToolCatalogEntry[] {
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return normalizeCatalogResponse(raw);
}

const SAFETY_HINT_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

function copySafetyHints(
  source: ToolCatalogEntry,
  destination: ToolIndexEntry,
): void {
  for (const key of SAFETY_HINT_KEYS) {
    if (Object.hasOwn(source, key)) destination[key] = source[key];
  }
}

function renderSafetyHints(tool: ToolCatalogEntry): string {
  return SAFETY_HINT_KEYS
    .map((key) => `${key}=${typeof tool[key] === 'boolean' ? String(tool[key]) : 'unknown'}`)
    .join(', ');
}
