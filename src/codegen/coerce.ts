// Runtime value coercers used by generated commands.
//
// CLI flags are always strings; tool parameters expect typed objects.
// These helpers translate the raw flag value into the shape the
// upstream uco bridge wants, with friendly shorthands for
// Vector3 ("1,2,3") and GameObjectRef ("/Player" or "1234").

import { expandStructuredReference } from '../util/input.js';
import { CliError } from '../util/errors.js';

export interface Vec3 { x: number; y: number; z: number }
export interface GameObjectRef {
  instanceID?: number;
  path?: string;
  name?: string;
}

export function coerceVec3(raw: string): Vec3 {
  const referenced = raw.startsWith('@');
  const expanded = expandStructuredReference(raw);
  if (referenced || expanded.trim().startsWith('{')) {
    const parsed = parseStructuredJson(expanded, 'Vector3');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Vector3 JSON must be an object, got: ${expanded}`);
    }
    const obj = parsed as Partial<Vec3>;
    const x = Number(obj.x);
    const y = Number(obj.y);
    const z = Number(obj.z);
    if (![x, y, z].every(Number.isFinite)) {
      throw new Error(`Vector3 JSON missing numeric x/y/z: ${expanded}`);
    }
    return { x, y, z };
  }
  const parts = expanded.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Expected "x,y,z" or JSON {x,y,z}, got: ${expanded}`);
  }
  return { x: parts[0]!, y: parts[1]!, z: parts[2]! };
}

export function coerceGameObjectRef(raw: string): GameObjectRef {
  const referenced = raw.startsWith('@');
  const trimmed = expandStructuredReference(raw).trim();
  if (referenced || trimmed.startsWith('{')) {
    const parsed = parseStructuredJson(trimmed, 'GameObjectRef');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`GameObjectRef JSON must be an object, got: ${trimmed}`);
    }
    return parsed as GameObjectRef;
  }
  // Pure integer → instance ID
  if (/^-?\d+$/.test(trimmed)) {
    return { instanceID: parseInt(trimmed, 10) };
  }
  // Looks like a hierarchy path (contains slash) or anything else → treat as path
  if (trimmed.includes('/')) {
    return { path: trimmed };
  }
  // Single token, non-numeric → could be either name or path; upstream
  // priority is instanceID > path > name, so default to path which is
  // the most common positional match.
  return { path: trimmed };
}

export function coerceInteger(raw: string, minimum?: number, maximum?: number): number {
  const trimmed = raw.trim();
  const expectation = integerExpectation(minimum, maximum);
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`Expected ${expectation}, got: ${raw}`);
  }
  const n = Number(trimmed);
  if (
    !Number.isSafeInteger(n)
    || (minimum !== undefined && n < minimum)
    || (maximum !== undefined && n > maximum)
  ) {
    throw new Error(`Expected ${expectation}, got: ${raw}`);
  }
  return n;
}

export function coerceNumber(raw: string): number {
  if (typeof raw !== 'string') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Expected number, got: ${raw}`);
  return n;
}

export function coerceBoolean(raw: string | boolean | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new Error(`Expected true|false, got: ${raw}`);
}

export function coerceJson(raw: string): unknown {
  try {
    return JSON.parse(expandStructuredReference(raw));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
}

function parseStructuredJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid ${label} JSON: ${(err as Error).message}`);
  }
}

function integerExpectation(minimum: number | undefined, maximum: number | undefined): string {
  if (minimum !== undefined && maximum !== undefined) {
    return `a safe integer from ${minimum} to ${maximum}`;
  }
  if (minimum !== undefined) return `a safe integer greater than or equal to ${minimum}`;
  if (maximum !== undefined) return `a safe integer less than or equal to ${maximum}`;
  return 'a safe integer';
}
