import type { Command, Option } from 'commander';

export interface ScannedOptionOccurrence {
  owner: 'root' | 'command';
  attribute: string;
  value: string | boolean | undefined;
}

export interface ScannedCommandInvocation {
  positionals: string[];
  passthrough: string[];
  options: ScannedOptionOccurrence[];
  unknownOptions: string[];
}

interface OptionMatch {
  option: Option;
  attachedValue?: string;
}

interface OwnedOptionDefinition {
  owner: ScannedOptionOccurrence['owner'];
  option: Option;
}

interface OwnedOptionMatch extends OptionMatch {
  owner: ScannedOptionOccurrence['owner'];
}

interface CompactShortMatch {
  matches: OwnedOptionMatch[];
  unknownOption?: string;
}

function matchOption(options: readonly Option[], token: string): OptionMatch | undefined {
  for (const option of options) {
    if (token === option.long || token === option.short) return { option };
    if (option.long !== undefined && token.startsWith(`${option.long}=`)) {
      return { option, attachedValue: token.slice(option.long.length + 1) };
    }
    if (
      option.short !== undefined
      && (option.required || option.optional)
      && token.startsWith(option.short)
      && token.length > option.short.length
    ) {
      return { option, attachedValue: token.slice(option.short.length) };
    }
  }
  return undefined;
}

function ownedOptionDefinitions(
  owner: ScannedOptionOccurrence['owner'],
  options: readonly Option[],
): OwnedOptionDefinition[] {
  return options.map((option) => ({ owner, option }));
}

/**
 * Match Commander's compact short-option grammar.
 *
 * A token may contain any number of registered boolean shorts followed by one
 * registered value-bearing short. That final option owns the rest of the token
 * (including option-looking text), or its next argument when no text remains.
 * Commander also retains a recognized boolean prefix before exposing an
 * unknown remainder, so return both pieces instead of discarding the prefix.
 */
function matchCompactShortOptions(
  definitions: readonly OwnedOptionDefinition[],
  token: string,
): CompactShortMatch | undefined {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return undefined;
  const body = token.slice(1);
  const matches: OwnedOptionMatch[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const definition = definitions.find(({ option }) => option.short === `-${body[index]}`);
    if (definition === undefined) {
      return { matches, unknownOption: `-${body.slice(index)}` };
    }
    if (definition.option.required || definition.option.optional) {
      const attachedValue = body.slice(index + 1);
      matches.push({
        ...definition,
        ...(attachedValue.length > 0 ? { attachedValue } : {}),
      });
      return { matches };
    }
    matches.push(definition);
  }
  return { matches };
}

function consumeCompactShortOptions(
  invocation: ScannedCommandInvocation,
  match: CompactShortMatch,
  tokens: readonly string[],
  index: number,
  opaqueValueAttributes: ReadonlySet<string>,
): number {
  let consumed = 1;
  for (const optionMatch of match.matches) {
    const attribute = optionMatch.option.attributeName();
    const parsed = optionValue(
      optionMatch,
      tokens,
      index,
      optionMatch.owner === 'command' && opaqueValueAttributes.has(attribute),
    );
    invocation.options.push({
      owner: optionMatch.owner,
      attribute,
      value: parsed.value,
    });
    consumed = Math.max(consumed, parsed.consumed);
  }
  if (match.unknownOption !== undefined) invocation.unknownOptions.push(match.unknownOption);
  return consumed;
}

function compactShortOptionsConsumed(
  match: CompactShortMatch,
  tokens: readonly string[],
  index: number,
): number {
  const finalMatch = match.matches.at(-1);
  return finalMatch === undefined
    ? 1
    : optionValue(finalMatch, tokens, index, false).consumed;
}

function optionValue(
  match: OptionMatch,
  tokens: readonly string[],
  index: number,
  consumeOptionLikeValue: boolean,
): { consumed: number; value: string | boolean | undefined } {
  if (match.attachedValue !== undefined) {
    return { consumed: 1, value: match.attachedValue };
  }
  if (match.option.required || match.option.optional) {
    const next = tokens[index + 1];
    const consumesNext = next !== undefined
      && (match.option.required || consumeOptionLikeValue || !next.startsWith('-'));
    return { consumed: consumesNext ? 2 : 1, value: consumesNext ? next : undefined };
  }
  return { consumed: 1, value: match.option.negate ? false : true };
}

function userArguments(command: Command): string[] {
  const raw = (command.parent as (Command & { rawArgs?: string[] }) | null)?.rawArgs ?? [];
  // uco and its parser tests use Commander's default `from: node` convention.
  return raw.slice(2);
}

function commandIndex(command: Command, tokens: readonly string[]): number {
  const rootOptions = command.parent?.options ?? [];
  const rootDefinitions = ownedOptionDefinitions('root', rootOptions);
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index] ?? '';
    const match = matchOption(rootOptions, token);
    if (match !== undefined) {
      index += optionValue(match, tokens, index, false).consumed;
      continue;
    }
    const compact = matchCompactShortOptions(rootDefinitions, token);
    if (compact !== undefined) {
      index += compactShortOptionsConsumed(compact, tokens, index);
      continue;
    }
    if (token === command.name() || command.aliases().includes(token)) return index;
    index += 1;
  }
  return -1;
}

/**
 * Reconstruct the selected command's token ownership from Commander's raw argv.
 *
 * Commander intentionally lets root options appear after subcommands. A command
 * option with the same spelling is consequently consumed by the root parser,
 * and required values which look like options need an explicit opaque boundary.
 * This scanner is the narrow adapter for those two cases; Commander still owns
 * normal parsing, help, aliases, and validation.
 */
export function scanCommandInvocation(
  command: Command,
  opaqueValueAttributes: readonly string[] = [],
): ScannedCommandInvocation {
  const tokens = userArguments(command);
  const selectedIndex = commandIndex(command, tokens);
  const invocation: ScannedCommandInvocation = {
    positionals: [],
    passthrough: [],
    options: [],
    unknownOptions: [],
  };
  if (selectedIndex === -1) return invocation;

  const rootOptions = command.parent?.options ?? [];
  const commandOptions = command.options;
  const rootDefinitions = ownedOptionDefinitions('root', rootOptions);
  const commandDefinitions = ownedOptionDefinitions('command', commandOptions);
  const allDefinitions = [...commandDefinitions, ...rootDefinitions];
  const opaque = new Set(opaqueValueAttributes);

  // Retain root option occurrences before the selected command so a colliding
  // command-local option can restore the root value after Commander parses.
  for (let index = 0; index < selectedIndex;) {
    const match = matchOption(rootOptions, tokens[index] ?? '');
    if (match === undefined) {
      const compact = matchCompactShortOptions(rootDefinitions, tokens[index] ?? '');
      if (compact !== undefined) {
        index += consumeCompactShortOptions(invocation, compact, tokens, index, opaque);
        continue;
      }
      index += 1;
      continue;
    }
    const parsed = optionValue(match, tokens, index, false);
    invocation.options.push({
      owner: 'root',
      attribute: match.option.attributeName(),
      value: parsed.value,
    });
    index += parsed.consumed;
  }

  for (let index = selectedIndex + 1; index < tokens.length;) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      invocation.passthrough = tokens.slice(index + 1);
      break;
    }

    const commandMatch = matchOption(commandOptions, token);
    if (commandMatch !== undefined) {
      const attribute = commandMatch.option.attributeName();
      const parsed = optionValue(commandMatch, tokens, index, opaque.has(attribute));
      invocation.options.push({ owner: 'command', attribute, value: parsed.value });
      index += parsed.consumed;
      continue;
    }

    const rootMatch = matchOption(rootOptions, token);
    if (rootMatch !== undefined) {
      const parsed = optionValue(rootMatch, tokens, index, false);
      invocation.options.push({
        owner: 'root',
        attribute: rootMatch.option.attributeName(),
        value: parsed.value,
      });
      index += parsed.consumed;
      continue;
    }

    const compact = matchCompactShortOptions(allDefinitions, token);
    if (compact !== undefined) {
      index += consumeCompactShortOptions(invocation, compact, tokens, index, opaque);
      continue;
    }

    if (token.startsWith('-')) invocation.unknownOptions.push(token);
    else invocation.positionals.push(token);
    index += 1;
  }
  return invocation;
}

export function lastCommandOption(
  invocation: ScannedCommandInvocation,
  attribute: string,
): string | boolean | undefined {
  return invocation.options
    .filter((option) => option.owner === 'command' && option.attribute === attribute)
    .at(-1)?.value;
}

export function commandOptionValues(
  invocation: ScannedCommandInvocation,
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const option of invocation.options) {
    if (option.owner === 'command' && option.value !== undefined) {
      values[option.attribute] = option.value;
    }
  }
  return values;
}

export function restoreRootOption(
  command: Command,
  invocation: ScannedCommandInvocation,
  attribute: string,
): void {
  const parent = command.parent;
  if (parent === null) return;
  const definition = parent.options.find((option) => option.attributeName() === attribute);
  if (definition === undefined) return;
  const occurrence = invocation.options
    .filter((option) => option.owner === 'root' && option.attribute === attribute)
    .at(-1);
  parent.setOptionValueWithSource(
    attribute,
    occurrence?.value ?? definition.defaultValue,
    occurrence === undefined ? 'default' : 'cli',
  );
}

export function restoreRootOptions(
  command: Command,
  invocation: ScannedCommandInvocation,
): void {
  for (const option of command.parent?.options ?? []) {
    restoreRootOption(command, invocation, option.attributeName());
  }
}
