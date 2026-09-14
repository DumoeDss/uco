// A numbered multi-select prompt built on Node's built-in readline — no new
// runtime dependency (uco bundles its deps into the tgz; a prompt library
// is not worth the bytes). Rendering goes to stderr so stdout stays clean for
// JSON output.
//
// Answer grammar: a comma-separated list of numbers (`1,3,5`), `all`, `none`,
// or an empty line to accept the pre-selected set. Selection requires at
// least one choice; an explicit `none` (or an empty answer with nothing
// pre-selected) fails with {@link EmptyMultiSelectionError} so the command
// can surface "at least one agent must be selected".

import * as readline from 'node:readline';
import process from 'node:process';
import kleur from 'kleur';

export interface MultiSelectChoice {
  value: string;
  label: string;
  /** Checked by default; an empty Enter answer resolves to exactly these. */
  preSelected: boolean;
  /** Listed with a "detected" marker (advisory presence at the target). */
  detected?: boolean;
}

export interface MultiSelectOptions {
  message: string;
  choices: readonly MultiSelectChoice[];
  /** Defaults to `process.stdin`; injectable for tests. */
  input?: NodeJS.ReadableStream;
  /** Defaults to `process.stderr`; injectable for tests. */
  output?: NodeJS.WritableStream;
}

export interface MultiSelectResult {
  /** Selected values in choice order. */
  selected: string[];
  /** The raw answer line that produced the selection. */
  answer: string;
}

/** The user explicitly chose nothing (`none`, or Enter with nothing pre-selected). */
export class EmptyMultiSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyMultiSelectionError';
  }
}

export async function promptMultiSelect(options: MultiSelectOptions): Promise<MultiSelectResult> {
  if (options.choices.length === 0) {
    throw new EmptyMultiSelectionError('Nothing to select: the choice list is empty.');
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const preSelectedIndexes = options.choices
    .map((choice, index) => (choice.preSelected ? index + 1 : 0))
    .filter((index) => index > 0);

  const lines = [
    `${options.message}`,
    ...options.choices.map((choice, index) => {
      const marker = choice.preSelected
        ? kleur.green('(pre-selected)')
        : choice.detected
          ? kleur.yellow('(detected)')
          : '';
      const markerText = marker ? ` ${marker}` : '';
      return `  ${kleur.cyan(String(index + 1).padStart(2))}. ${choice.label}${markerText}`;
    }),
  ];
  const hint = preSelectedIndexes.length > 0
    ? kleur.dim(`Enter to accept [${preSelectedIndexes.join(',')}]`)
    : kleur.dim('Enter is not a shortcut here — nothing is pre-selected');
  const promptLine = `Answer with numbers (e.g. 1,3), 'all', 'none' — ${hint}: `;

  const rl = readline.createInterface({ input, output, terminal: false });
  const write = (line: string): void => {
    output.write(line + '\n');
  };
  try {
    write(lines.join('\n'));
    for (;;) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(promptLine, (value) => resolve(value));
      });
      try {
        return { selected: parseAnswer(answer, options.choices), answer: answer.trim() };
      } catch (error) {
        if (error instanceof EmptyMultiSelectionError) throw error;
        write(kleur.yellow(`  ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  } finally {
    rl.close();
  }
}

/** Parse one answer line. Throws EmptyMultiSelectionError for `none`. */
export function parseAnswer(answer: string, choices: readonly MultiSelectChoice[]): string[] {
  const trimmed = answer.trim();
  if (trimmed === '') {
    const preSelected = choices.filter((choice) => choice.preSelected).map((choice) => choice.value);
    if (preSelected.length === 0) {
      throw new EmptyMultiSelectionError('At least one option must be selected.');
    }
    return preSelected;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'all') {
    return choices.map((choice) => choice.value);
  }
  if (normalized === 'none') {
    throw new EmptyMultiSelectionError('At least one option must be selected.');
  }

  const tokens = trimmed.split(/[,\s]+/).filter((token) => token.length > 0);
  if (tokens.some((token) => token.toLowerCase() === 'all' || token.toLowerCase() === 'none')) {
    throw new Error(`'all' and 'none' cannot be combined with numbers — answer again, e.g. 1,3.`);
  }

  const indexes: number[] = [];
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) {
      throw new Error(`Not a number: "${token}" — answer again, e.g. 1,3, or 'all' / 'none'.`);
    }
    const index = Number.parseInt(token, 10);
    if (index < 1 || index > choices.length) {
      throw new Error(`No option ${index} (valid: 1-${choices.length}) — answer again.`);
    }
    if (!indexes.includes(index - 1)) indexes.push(index - 1);
  }
  if (indexes.length === 0) {
    throw new EmptyMultiSelectionError('At least one option must be selected.');
  }
  return indexes.sort((left, right) => left - right).map((index) => choices[index]!.value);
}
