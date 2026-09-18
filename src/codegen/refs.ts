// Resolve JSON Schema $ref pointers inside the tool's local $defs.
//
// The bridge emits self-contained schemas: each tool's inputSchema has
// its own $defs map, and refs look like `#/$defs/UnityEngine.Vector3`.

import type { JsonSchema } from './types.js';

export function resolveRef(schema: JsonSchema | undefined, $defs: Record<string, JsonSchema>): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema ?? {};
  if (typeof schema.$ref !== 'string') return schema;
  const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
  if (!m) return schema;
  const key = m[1]!;
  const target = $defs[key];
  if (!target) return schema;
  // Preserve description from the referring site so it surfaces in --help.
  return { ...target, ...(schema.description ? { description: schema.description } : {}) };
}

/**
 * Classify a $ref target so we can pick a coercer.
 * Returns one of: 'vec3' | 'gameobject-ref' | undefined.
 */
export function classifyRefTarget(refName: string): 'vec3' | 'gameobject-ref' | undefined {
  if (refName === 'UnityEngine.Vector3') return 'vec3';
  if (refName === 'AIGD.GameObjectRef') return 'gameobject-ref';
  return undefined;
}

/** Pull the bare type name out of a `#/$defs/Foo.Bar` ref. */
export function refName(schema: JsonSchema): string | undefined {
  if (typeof schema.$ref !== 'string') return undefined;
  const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
  return m ? m[1] : undefined;
}
