import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  EmptyMultiSelectionError,
  parseAnswer,
  promptMultiSelect,
  type MultiSelectChoice,
} from '../src/util/multi-select.js';

const choices: MultiSelectChoice[] = [
  { value: 'claude-code', label: 'Claude Code', preSelected: true },
  { value: 'cursor', label: 'Cursor', detected: true, preSelected: false },
  { value: 'windsurf', label: 'Windsurf', preSelected: false },
];

/** A stdin substitute whose lines can be scripted up front. */
class ScriptedInput extends Readable {
  pushLine(line: string): void {
    this.push(`${line}\n`);
  }
  _read(): void { /* data arrives via push */ }
}

class CapturingOutput extends Writable {
  readonly lines: string[] = [];
  _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error | null) => void): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.lines.push(...text.split('\n').filter((line) => line.length > 0));
    callback();
  }
  get text(): string {
    return this.lines.join('\n');
  }
}

describe('parseAnswer grammar', () => {
  it('selects by comma-separated numbers, deduplicated and ordered by choice order', () => {
    expect(parseAnswer('2,1,2', choices)).toEqual(['claude-code', 'cursor']);
    expect(parseAnswer(' 1, 3 ', choices)).toEqual(['claude-code', 'windsurf']);
  });

  it('accepts all', () => {
    expect(parseAnswer('all', choices)).toEqual(['claude-code', 'cursor', 'windsurf']);
    expect(parseAnswer('ALL', choices)).toEqual(['claude-code', 'cursor', 'windsurf']);
  });

  it('rejects none with a min-one failure', () => {
    expect(() => parseAnswer('none', choices)).toThrow(EmptyMultiSelectionError);
    expect(() => parseAnswer('none', choices)).toThrow(/at least one/i);
  });

  it('an empty answer accepts the pre-selected set', () => {
    expect(parseAnswer('', choices)).toEqual(['claude-code']);
    expect(parseAnswer('   ', choices)).toEqual(['claude-code']);
  });

  it('an empty answer with nothing pre-selected fails with min-one', () => {
    const none: MultiSelectChoice[] = [{ value: 'a', label: 'A', preSelected: false }];
    expect(() => parseAnswer('', none)).toThrow(EmptyMultiSelectionError);
  });

  it('rejects out-of-range numbers, non-numbers, and mixed reserved words', () => {
    expect(() => parseAnswer('9', choices)).toThrow(/no option 9/i);
    expect(() => parseAnswer('abc', choices)).toThrow(/not a number/i);
    expect(() => parseAnswer('1,all', choices)).toThrow(/cannot be combined/i);
  });
});

describe('promptMultiSelect over stubbed stdin/stdout', () => {
  it('renders the numbered list with markers and resolves a numeric answer', async () => {
    const input = new ScriptedInput();
    const output = new CapturingOutput();
    input.pushLine('1,3');
    const result = await promptMultiSelect({ message: 'Select agents:', choices, input, output });

    expect(result.selected).toEqual(['claude-code', 'windsurf']);
    expect(result.answer).toBe('1,3');
    expect(output.text).toContain('Select agents:');
    expect(output.text).toContain('1. Claude Code');
    expect(output.text).toContain('(pre-selected)');
    expect(output.text).toContain('(detected)');
    expect(output.text).toContain("'none'");
  });

  it('re-prompts with a hint on a bad answer and then accepts one', async () => {
    const input = new ScriptedInput();
    const output = new CapturingOutput();
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    // Push each line only after the previous question is pending — readline
    // drops buffered lines that arrive while no question is listening.
    const pending = promptMultiSelect({ message: 'Select agents:', choices, input, output });
    await delay(25);
    input.pushLine('nope');
    await delay(25);
    input.pushLine('9');
    await delay(25);
    input.pushLine('2');
    const result = await pending;

    expect(result.selected).toEqual(['cursor']);
    expect(output.text).toContain('Not a number: "nope"');
    expect(output.text).toContain('No option 9');
  });

  it('an empty line accepts the pre-selected set end to end', async () => {
    const input = new ScriptedInput();
    const output = new CapturingOutput();
    input.pushLine('');
    const result = await promptMultiSelect({ message: 'Select agents:', choices, input, output });

    expect(result.selected).toEqual(['claude-code']);
    expect(output.text).toContain('Enter to accept [1]');
  });

  it('fails the prompt on an explicit none', async () => {
    const input = new ScriptedInput();
    const output = new CapturingOutput();
    input.pushLine('none');
    await expect(promptMultiSelect({ message: 'Select agents:', choices, input, output }))
      .rejects.toThrow(EmptyMultiSelectionError);
  });

  it('all resolves to every choice', async () => {
    const input = new ScriptedInput();
    const output = new CapturingOutput();
    input.pushLine('all');
    const result = await promptMultiSelect({ message: 'Select agents:', choices, input, output });

    expect(result.selected).toEqual(['claude-code', 'cursor', 'windsurf']);
  });
});
