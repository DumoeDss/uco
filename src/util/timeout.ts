import { CliError } from './errors.js';

/** Maximum delay accepted by Node's timer APIs without truncation. */
export const MAX_TIMER_MILLISECONDS = 2_147_483_647;
export const MAX_TIMER_SECONDS = Math.floor(MAX_TIMER_MILLISECONDS / 1_000);

export function parseBoundedInteger(
  raw: string,
  options: {
    option: string;
    unit: 'milliseconds' | 'seconds';
    maximum: number;
    code?: string;
  },
): number {
  const message = `Invalid ${options.option}: ${raw}. Expected an integer in ${options.unit} from 1 to ${options.maximum}.`;
  if (!/^[0-9]+$/.test(raw)) {
    throw new CliError(message, options.code ?? 'invalid-timeout');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > options.maximum) {
    throw new CliError(message, options.code ?? 'invalid-timeout');
  }
  return value;
}
