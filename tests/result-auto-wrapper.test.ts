import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    if (path.basename(dir).startsWith('uco-auto-wrapper-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('installed agent wrapper auto default', () => {
  it('injects auto before user arguments, leaving an explicit full override available', () => {
    const project = mkdtempSync(path.join(tmpdir(), 'uco-auto-wrapper-'));
    temporaryDirectories.push(project);
    const runtime = path.join(project, '.uco', 'agent-runtime');
    mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
    mkdirSync(path.join(runtime, 'catalog'), { recursive: true });
    const wrapper = path.join(runtime, 'scripts', 'uco.mjs');
    const fakeEntry = path.join(project, 'fake-uco.mjs');
    copyFileSync(path.resolve('skills/unity-editor/scripts/uco.mjs'), wrapper);
    writeFileSync(fakeEntry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
    writeFileSync(path.join(runtime, 'catalog', 'project.json'), JSON.stringify({
      projectPath: project, ucoEntryPath: fakeEntry,
    }), 'utf8');
    const run = spawnSync(process.execPath, [wrapper, 'scene-get-data', '--result-view', 'full'], {
      cwd: project, encoding: 'utf8', shell: false,
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      '--project', project, '--result-view', 'auto', 'scene-get-data', '--result-view', 'full',
    ]);
  });
});
