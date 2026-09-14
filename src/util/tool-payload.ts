const TOOL_PAYLOAD_WRAPPER_KEYS = [
  'structured',
  'Structured',
  'structuredContent',
  'StructuredContent',
  'result',
  'Result',
  'value',
  'Value',
] as const;

const DEFAULT_MAX_DEPTH = 8;

/**
 * Visit only the bridge's known response wrappers. This intentionally does not
 * recurse through arbitrary result data, so an application object's `Ok`
 * property cannot be mistaken for the tool's own status contract.
 */
export function toolPayloadRecords(
  value: unknown,
  maxDepth = DEFAULT_MAX_DEPTH,
): ReadonlyArray<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.shift()!;
    if (!isRecord(current.value) || seen.has(current.value)) continue;
    seen.add(current.value);
    records.push(current.value);
    if (current.depth >= maxDepth) continue;

    for (const key of TOOL_PAYLOAD_WRAPPER_KEYS) {
      const nested = current.value[key];
      if (isRecord(nested)) pending.push({ value: nested, depth: current.depth + 1 });
    }
  }

  return records;
}

/** Follow the first known wrapper at each level and return the deepest record. */
export function unwrapToolPayload(
  value: unknown,
  maxDepth = DEFAULT_MAX_DEPTH,
): Record<string, unknown> {
  let current = value;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (!isRecord(current) || seen.has(current)) return {};
    seen.add(current);
    const record = current;
    const next = TOOL_PAYLOAD_WRAPPER_KEYS
      .map((key) => record[key])
      .find(isRecord);
    if (next === undefined) return record;
    current = next;
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
