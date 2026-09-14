import { readFileSync, readSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { CliError } from './errors.js';

let stdinBytes: Buffer | undefined;

/** Read a path or `-` as strict UTF-8. Invalid byte sequences are rejected. */
export function readUtf8Source(source: string, optionName: string): string {
  let bytes: Buffer;
  try {
    bytes = source === '-' ? readStdinBytesOnce() : readFileSync(source);
  } catch (err) {
    throw new CliError(
      `Failed to read ${optionName} ${source}: ${(err as Error).message}`,
      'input-read',
    );
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    throw new CliError(
      `${optionName} ${source} is not valid UTF-8: ${(err as Error).message}`,
      'input-invalid-utf8',
    );
  }
}

/** Resolve mutually exclusive inline text and path/stdin text sources. */
export function resolveTextInput(
  inline: unknown,
  source: unknown,
  inlineName: string,
  sourceName: string,
): string {
  const hasInline = typeof inline === 'string';
  const hasSource = typeof source === 'string' && source.length > 0;
  if (hasInline && hasSource) {
    throw new CliError(`${inlineName} and ${sourceName} are mutually exclusive`, 'input-conflict');
  }
  if (hasSource) return readUtf8Source(source, sourceName);
  if (hasInline && inline.length > 0) return inline;
  throw new CliError(`Provide ${inlineName} or ${sourceName} <path|->`, 'input-required');
}

/** Parse a complete JSON object from inline text or path/stdin. */
export function resolveJsonObjectInput(
  inline: unknown,
  source: unknown,
  inlineName = '--args',
  sourceName = '--args-file',
): Record<string, unknown> {
  const hasInline = typeof inline === 'string';
  const hasSource = typeof source === 'string' && source.length > 0;
  if (hasInline && hasSource) {
    throw new CliError(`${inlineName} and ${sourceName} are mutually exclusive`, 'input-conflict');
  }
  const raw = hasSource
    ? readUtf8Source(source, sourceName)
    : hasInline
      ? inline
      : '{}';
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError(`${hasSource ? sourceName : inlineName} must contain a JSON object`, 'args-not-object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `Invalid JSON in ${hasSource ? sourceName : inlineName}: ${(err as Error).message}`,
      'args-invalid-json',
    );
  }
}

/** Resolve `@path` / `@-` before a generated structured-value parser runs. */
export function expandStructuredReference(raw: string): string {
  if (!raw.startsWith('@')) return raw;
  const source = raw.slice(1);
  if (!source) throw new CliError('Structured @ reference requires a path or @-', 'input-reference');
  return readUtf8Source(source, '@reference');
}

function readStdinBytesOnce(): Buffer {
  if (stdinBytes !== undefined) return stdinBytes;
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  while (true) {
    const bytes = readSync(0, buffer, 0, buffer.length, null);
    if (bytes === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, bytes)));
  }
  stdinBytes = Buffer.concat(chunks);
  return stdinBytes;
}

/** Test hook; production processes normally consume stdin only once. */
export function resetStdinCacheForTests(): void {
  stdinBytes = undefined;
}
