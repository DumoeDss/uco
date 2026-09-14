// uco entry — wires the global options to all subcommands.

import { buildProgram } from './program.js';
import { printError } from './util/output.js';

const program = buildProgram();
program.parseAsync(process.argv).catch((err) => {
  // Commander throws on unknown commands etc. before our runCommand
  // wrapper catches anything.
  // eslint-disable-next-line no-console
  printError({ json: process.argv.includes('--json'), verbose: process.argv.includes('--verbose') }, err);
  process.exit(1);
});
