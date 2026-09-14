import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emitToolCommands } from '../src/codegen/emit.js';
import { GENERATED_TOOL_NAMES } from '../src/generated/tools.js';
import type { ToolCatalogEntry } from '../src/codegen/types.js';
import { canonicalCatalogJson } from '../src/catalog.js';

const PACKAGE_ROOT = path.resolve(
  process.cwd(),
  '..',
  'uco-plugin',
  'uco-unity-project',
  'Packages',
  'com.atelierai.unity.copilot',
);
const SOURCE_TOOL_ROOT = path.join(PACKAGE_ROOT, 'Editor', 'Scripts', 'API', 'Tool');
const GENERATED_JSON = path.resolve('src', 'generated', 'tools.json');
const GENERATED_TYPESCRIPT = path.resolve('src', 'generated', 'tools.ts');
const MANIFEST_JSON = path.join(PACKAGE_ROOT, 'tools-manifest.json');
const VENDOR_MANIFEST_JSON = path.resolve(
  'vendor',
  'plugin',
  'com.atelierai.unity.copilot',
  'tools-manifest.json',
);
const CATALOG_METADATA_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
  'executionAffinity',
  'threadSafeRead',
] as const;
const GENERATED_TOOL_COUNT = 163;
const GENERATED_NAME_DIGEST = '53c657751874ecc1824372edbf01062f12f932f1710176baf7aea6cf1693d18b';
// Parent semantics plus the intentional g-006 operation/readiness schemas, including
// the BuildJobInfo.Progress projection, the COCli-09/11/13 additions (script-execute
// `defines`, BuildJobInfo durable OperationId + QueuedSeconds/Blocked), the
// COCli-12 test-flow schemas, and the 0.75.1 zero-parameter-tool params
// (build-scene-list/instance-get-current/tools-list-groups/graphics-*).
// Metadata is checked separately so one scheduling annotation cannot conceal
// schema churn.
const GENERATED_NON_METADATA_DIGEST = '7b9ae638662802c9513b226e8626d9f659ef999093098d948f23dbb5a6fc326d';

function catalog(): ToolCatalogEntry[] {
  return JSON.parse(fs.readFileSync(GENERATED_JSON, 'utf8')) as ToolCatalogEntry[];
}

function manifestCatalog(): ToolCatalogEntry[] {
  return JSON.parse(fs.readFileSync(MANIFEST_JSON, 'utf8')) as ToolCatalogEntry[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function withoutCatalogMetadata(tool: ToolCatalogEntry): ToolCatalogEntry {
  return Object.fromEntries(
    Object.entries(tool).filter(([key]) => !CATALOG_METADATA_KEYS.includes(
      key as typeof CATALOG_METADATA_KEYS[number],
    )),
  ) as ToolCatalogEntry;
}

function sourceToolNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(SOURCE_TOOL_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/public\s+const\s+string\s+\w*(?:ToolId|Id)\s*=\s*"([^"]+)"/g)) {
      names.add(match[1]!);
    }
    for (const match of source.matchAll(/\[UcoTool\s*\(\s*"([^"]+)"/g)) {
      names.add(match[1]!);
    }
  }
  return [...names].sort();
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(resolved));
    else if (entry.isFile() && entry.name.endsWith('.cs')) files.push(resolved);
  }
  return files;
}

describe('generated catalog matches the controlled g-006 source plugin', () => {
  it('keeps the controlled 163-tool catalog and generated command source synchronized', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { version?: string };
    const tools = catalog();
    const names = tools.map((tool) => tool.name);

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(names).toHaveLength(GENERATED_TOOL_COUNT);
    expect(sha256(`${names.join('\n')}\n`)).toBe(GENERATED_NAME_DIGEST);
    expect(sha256(canonicalCatalogJson(tools.map(withoutCatalogMetadata))))
      .toBe(GENERATED_NON_METADATA_DIGEST);
    expect(GENERATED_TOOL_NAMES).toEqual(names);
    expect(fs.readFileSync(GENERATED_TYPESCRIPT, 'utf8')).toBe(emitToolCommands(tools));
  });

  it('includes only the seven g-006 operation tools and excludes sibling additions', () => {
    const names = new Set(catalog().map((tool) => tool.name));
    const g006Tools = [
      'build-job-cancel',
      'editor-operation-cancel',
      'editor-operation-get',
      'editor-operation-list',
      'tests-job-cancel',
      'tests-job-get',
      'tests-job-list',
    ];
    for (const name of g006Tools) expect(names.has(name), name).toBe(true);
    expect(names.has('editor-application-request-close')).toBe(false);
    expect(names.has('type-list-members')).toBe(false);
  });

  it('keeps every generated safety and scheduling field synchronized with the authoritative manifest', () => {
    const tools = catalog();
    const manifestByName = new Map(manifestCatalog().map((tool) => [tool.name, tool]));
    for (const tool of tools) {
      const authoritative = manifestByName.get(tool.name);
      expect(authoritative, tool.name).toBeDefined();
      for (const key of CATALOG_METADATA_KEYS) {
        expect(Object.hasOwn(tool, key), `${tool.name}.${key}`).toBe(true);
        expect(tool[key], `${tool.name}.${key}`).toBe(authoritative![key]);
      }
    }

    const rawJson = fs.readFileSync(GENERATED_JSON, 'utf8');
    expect(rawJson).toBe(canonicalCatalogJson(tools));
    expect(Buffer.from(rawJson).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      .toBe(false);

    const shuffled = [...tools].reverse().map((tool) => ({ ...tool }));
    expect(emitToolCommands(shuffled)).toBe(emitToolCommands(tools));
    expect(emitToolCommands(tools)).toContain('.command("script-apply-edits")');
  });

  it('keeps the controlled 163-tool manifest, vendor, generated catalog, and source boundary in parity', () => {
    const rawManifest = fs.readFileSync(MANIFEST_JSON, 'utf8');
    const tools = manifestCatalog();
    const names = tools.map((tool) => tool.name);
    const sourceNames = sourceToolNames();

    expect(tools).toHaveLength(163);
    expect(names).toEqual(catalog().map((tool) => tool.name));
    expect(sourceNames.filter((name) => !names.includes(name))).toEqual([
      'editor-application-request-close',
      'type-list-members',
    ]);
    expect(tools.every((tool) => CATALOG_METADATA_KEYS.every((key) => Object.hasOwn(tool, key))))
      .toBe(true);
    expect(rawManifest.endsWith('\n')).toBe(true);
    expect(rawManifest.endsWith('\n\n')).toBe(false);
    expect(Buffer.from(rawManifest).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      .toBe(false);
    expect(fs.readFileSync(VENDOR_MANIFEST_JSON, 'utf8')).toBe(rawManifest);
  });
});
