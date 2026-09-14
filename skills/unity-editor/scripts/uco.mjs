#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const configPath = fileURLToPath(new URL('../catalog/project.json', import.meta.url));
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  process.stderr.write(`uco project wrapper could not read ${configPath}: ${error.message}\n`);
  process.exit(1);
}
if (!fs.existsSync(config.ucoEntryPath)) {
  process.stderr.write(`uco entry does not exist: ${config.ucoEntryPath}\nRegenerate project Skills from the uco checkout.\n`);
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  [config.ucoEntryPath, '--project', config.projectPath, ...process.argv.slice(2)],
  { cwd: config.projectPath, stdio: 'inherit', windowsHide: true },
);
if (result.error) {
  process.stderr.write(`uco project wrapper failed: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
