#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const catalogPath = fileURLToPath(new URL('../catalog/tools.json', import.meta.url));
const indexPath = fileURLToPath(new URL('../catalog/tool-index.json', import.meta.url));
const tools = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const args = process.argv.slice(2);

function usage() {
  process.stderr.write('Usage: tool-info.mjs <exact-tool-name> | --search <text> | --list [domain]\n');
}
if (args[0] === '--list') {
  const domain = args[1];
  const entries = domain ? index.filter((entry) => entry.domain === domain) : index;
  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  process.exit(0);
}
if (args[0] === '--search' && args[1]) {
  const query = args.slice(1).join(' ').toLowerCase();
  const matches = index.filter((entry) =>
    `${entry.name} ${entry.title ?? ''} ${entry.description ?? ''}`.toLowerCase().includes(query))
    .slice(0, 20);
  process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
  process.exit(matches.length > 0 ? 0 : 1);
}
if (args.length !== 1) {
  usage();
  process.exit(2);
}
const tool = tools.find((entry) => entry.name === args[0]);
if (!tool) {
  process.stderr.write(`Unknown Unity tool: ${args[0]}\nRefresh the project Skills from a ready Editor catalog.\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(tool, null, 2)}\n`);
