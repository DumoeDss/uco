import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { CliError } from '../util/errors.js';
import { printError, printResult } from '../util/output.js';
import { redactSensitiveValue } from '../util/redaction.js';

interface ShowOptions {
  sha256?: string;
  pointer?: string;
  offset?: string;
  limit?: string;
  all?: boolean;
}

export function registerEvidence(program: Command): void {
  program.command('evidence').description('Inspect a local, hash-verified result evidence file.')
    .command('show <file>')
    .description('Verify SHA-256, then read a JSON Pointer from redacted evidence; arrays are paged by default.')
    .requiredOption('--sha256 <hex>', 'SHA-256 from the original uco result reference')
    .option('--pointer <json-pointer>', 'RFC 6901 JSON Pointer, e.g. /structured/result/Entries/0')
    .option('--offset <n>', 'Array page offset (default 0)', '0')
    .option('--limit <n>', 'Array page size (default 50, maximum 500)', '50')
    .option('--all', 'Explicitly allow complete array/object output')
    .action(function (this: Command, file: string, opts: ShowOptions) {
      const globals = this.optsWithGlobals() as { json?: boolean; verbose?: boolean };
      const output = { json: Boolean(globals.json), verbose: Boolean(globals.verbose) };
      try {
        printResult(output, showEvidence(file, opts));
      } catch (error) {
        printError(output, error);
        process.exitCode = 1;
      }
    });
}

export function showEvidence(file: string, options: ShowOptions): Record<string, unknown> {
  if (!options.sha256 || !/^[a-fA-F0-9]{64}$/.test(options.sha256)) {
    throw new CliError('--sha256 must be a 64-digit hexadecimal digest.', 'evidence-invalid-hash');
  }
  const target = path.resolve(file);
  const bytes = readFileSync(target);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== options.sha256.toLowerCase()) {
    throw new CliError('Evidence SHA-256 mismatch; file may be incomplete or modified.', 'evidence-hash-mismatch');
  }
  let root: unknown;
  try {
    root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CliError('Evidence is not strict UTF-8 JSON.', 'evidence-invalid-json');
  }
  const pointer = options.pointer ?? '';
  const selected = atPointer(root, pointer);
  const offset = parseNonnegative(options.offset ?? '0', '--offset');
  const limit = parseNonnegative(options.limit ?? '50', '--limit');
  if (limit < 1 || limit > 500) throw new CliError('--limit must be between 1 and 500.', 'evidence-invalid-limit');
  if (!Array.isArray(selected) && (offset !== 0 || options.limit !== undefined && options.limit !== '50')) {
    throw new CliError('--offset and --limit require an array selection.', 'evidence-not-array');
  }
  const value = Array.isArray(selected) && !options.all ? selected.slice(offset, offset + limit) : selected;
  const encoded = JSON.stringify(value);
  if (!options.all && Buffer.byteLength(encoded ?? 'null', 'utf8') > 32_768) {
    throw new CliError('Selected evidence exceeds 32 KiB; use a narrower --pointer or explicitly pass --all.', 'evidence-output-too-large');
  }
  return redactSensitiveValue({ evidence: { path: target, sha256: actual, bytes: bytes.length }, pointer,
    ...(Array.isArray(selected) ? { total: selected.length, offset: options.all ? 0 : offset,
      shown: Array.isArray(value) ? value.length : 0, omitted: options.all ? 0 : selected.length - (value as unknown[]).length } : {}), value }) as Record<string, unknown>;
}

function atPointer(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  if (!pointer.startsWith('/')) throw new CliError('--pointer must be an RFC 6901 JSON Pointer.', 'evidence-invalid-pointer');
  let current = root;
  for (const escaped of pointer.slice(1).split('/')) {
    if (/~(?![01])/.test(escaped)) throw new CliError('Invalid JSON Pointer escape.', 'evidence-invalid-pointer');
    const key = escaped.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) {
        throw new CliError(`JSON Pointer does not exist: ${pointer}`, 'evidence-pointer-not-found');
      }
      current = current[Number(key)];
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      throw new CliError(`JSON Pointer does not exist: ${pointer}`, 'evidence-pointer-not-found');
    }
  }
  return current;
}

function parseNonnegative(raw: string, option: string): number {
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new CliError(`${option} must be a nonnegative integer.`, 'evidence-invalid-page');
  }
  return Number(raw);
}
