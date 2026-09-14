import * as path from 'node:path';
import process from 'node:process';
import { CliError } from '../../util/cli-context.js';

export interface OperationSignalHost {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export function resolveUnityOperationProject(
  positionalProject: string | undefined,
  rootProject: string | undefined,
  cwd: string = process.cwd(),
): string {
  const selected = positionalProject ?? rootProject ?? cwd;
  requireNonEmpty(selected, 'Unity project');
  return path.resolve(cwd, selected);
}

export function requireNonEmpty(value: string, label: string): string {
  if (!value.trim()) {
    throw new CliError(`${label} must be a non-empty value.`, 'invalid-unity-option');
  }
  return value;
}

export function requireOneOf<const T extends string>(
  value: string,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new CliError(
      `${label} must be one of: ${allowed.join(', ')}.`,
      'invalid-unity-option',
    );
  }
  return value as T;
}

export function parsePositiveBase10Integer(
  value: string,
  label: string,
  maximum?: number,
): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new CliError(`${label} must be a positive base-10 integer.`, 'invalid-unity-option');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) {
    if (maximum !== undefined) {
      throw new CliError(
        `${label} must be a positive base-10 integer no greater than ${maximum}.`,
        'invalid-unity-option',
      );
    }
    throw new CliError(`${label} must be a positive base-10 integer.`, 'invalid-unity-option');
  }
  return parsed;
}

export function requireAndroidKeystoreDependencies(options: {
  androidKeystoreBase64?: string;
  androidKeystorePassword?: string;
  androidKeyAlias?: string;
}): void {
  if (options.androidKeystoreBase64 === undefined) return;
  if (options.androidKeystorePassword === undefined || options.androidKeyAlias === undefined) {
    throw new CliError(
      '--android-keystore-base64 requires --android-keystore-password and --android-key-alias.',
      'invalid-unity-option',
    );
  }
}

export async function withOperationCancellation<T>(
  controller: AbortController,
  operation: () => Promise<T>,
  signalHost: OperationSignalHost = process,
): Promise<T> {
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };
  signalHost.on('SIGINT', abort);
  signalHost.on('SIGTERM', abort);
  try {
    return await operation();
  } finally {
    signalHost.removeListener('SIGINT', abort);
    signalHost.removeListener('SIGTERM', abort);
  }
}
