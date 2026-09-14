import type { ToolCatalogEntry } from './codegen/types.js';

type JsonObject = Record<string, unknown>;

export function compareOrdinal(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function normalizeCatalogResponse(value: unknown): ToolCatalogEntry[] {
  if (Array.isArray(value)) return normalizeToolCatalog(value);
  if (isObject(value) && Array.isArray(value['tools'])) {
    return normalizeToolCatalog(value['tools']);
  }
  throw new Error('Unexpected /api/tools shape: not an array or { tools: [...] }');
}

export function normalizeToolCatalog(value: readonly unknown[]): ToolCatalogEntry[] {
  const tools: ToolCatalogEntry[] = [];
  const names = new Set<string>();

  for (const candidate of value) {
    if (!isObject(candidate) || typeof candidate['name'] !== 'string' || candidate['name'].trim() === '') {
      throw new Error('Unity tool catalog contains an entry without a valid name.');
    }

    const name = candidate['name'];
    if (names.has(name)) {
      throw new Error(`Unity tool catalog contains a duplicate name: ${name}`);
    }
    names.add(name);

    const entry = canonicalizeValue(candidate) as JsonObject;
    if (!Object.hasOwn(entry, 'enabled')) entry['enabled'] = true;
    tools.push(canonicalizeValue(entry) as ToolCatalogEntry);
  }

  return tools.sort((left, right) => compareOrdinal(left.name, right.name));
}

export function canonicalCatalogJson(value: readonly unknown[]): string {
  return canonicalJson(normalizeToolCatalog(value));
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeValue(value), null, 2)}\n`;
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry));
  if (!isObject(value)) return value;

  // Object.fromEntries uses CreateDataProperty for every member. In particular,
  // an own JSON "__proto__" member is defined as data instead of invoking the
  // legacy Object.prototype setter and changing the intermediate prototype.
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareOrdinal)
      .map((key) => [key, canonicalizeValue(value[key])]),
  ) as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
