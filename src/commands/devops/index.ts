// Barrel — register every devops command on the program.

import type { Command } from 'commander';
import { registerInstallPlugin } from './install-plugin.js';
import { registerRemovePlugin } from './remove-plugin.js';
import { registerConfigure } from './configure.js';
import { registerOpen } from './open.js';
import { registerClose } from './close.js';
import { registerWaitForReady } from './wait-for-ready.js';
import { registerStatus } from './status.js';
import { registerSetupSkills } from './setup-skills.js';
import { registerInstallUnity } from './install-unity.js';
import { registerCreateProject } from './create-project.js';
import { registerEditors } from './editors.js';
import { registerBuild } from './build.js';
import { registerTest } from './test.js';
import { registerSetupUnityCli } from './setup-unity-cli.js';

export function registerDevopsCommands(program: Command): void {
  registerInstallPlugin(program);
  registerRemovePlugin(program);
  registerConfigure(program);
  registerOpen(program);
  registerClose(program);
  registerWaitForReady(program);
  registerStatus(program);
  registerSetupSkills(program);
  registerInstallUnity(program);
  registerCreateProject(program);
  registerEditors(program);
  registerBuild(program);
  registerTest(program);
  registerSetupUnityCli(program);
}
