import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_RELATIVE_PATH,
  createDefaultConfig,
  getOrCreateConfig,
  readConfig,
  writeConfig,
  type AtomicConfigWriteDependencies,
} from '../src/devops/utils/config.js';
import { installAll } from '../src/devops/lib/install.js';

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-secure-config-'));
  temporaryDirectories.push(project);
  return project;
}

function descriptorPath(project: string): string {
  return path.join(project, CONFIG_RELATIVE_PATH);
}

function makeUnityProject(): string {
  const project = temporaryProject();
  fs.mkdirSync(path.join(project, 'Packages'));
  fs.writeFileSync(path.join(project, 'Packages', 'manifest.json'), '{"dependencies":{}}\n', 'utf8');
  return project;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('secure Unity connection descriptor', () => {
  it('creates a required-auth default with a 32-byte unpadded base64url token', () => {
    const project = temporaryProject();
    const config = getOrCreateConfig(project);

    expect(config.authOption).toBe('required');
    expect(config.connectionMode).toBe('Custom');
    expect(config.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(config.token as string, 'base64url')).toHaveLength(32);
    expect(readConfig(project)).toEqual(config);
  });

  it('atomically preserves unknown fields when a known field is updated', () => {
    const project = temporaryProject();
    writeConfig(project, { ...createDefaultConfig(project), futureSetting: { enabled: true } });
    const current = readConfig(project)!;

    writeConfig(project, { ...current, authOption: 'required' });

    expect(readConfig(project)).toMatchObject({
      authOption: 'required',
      futureSetting: { enabled: true },
    });
  });

  it('refuses to overwrite a malformed descriptor and preserves its bytes', () => {
    const project = temporaryProject();
    fs.mkdirSync(path.dirname(descriptorPath(project)), { recursive: true });
    fs.writeFileSync(descriptorPath(project), '{ definitely-not-json', 'utf8');

    expect(() => writeConfig(project, createDefaultConfig(project))).toThrow(/Malformed JSON/);
    expect(fs.readFileSync(descriptorPath(project), 'utf8')).toBe('{ definitely-not-json');
  });

  it('preserves the original and cleans its temporary file when replacement fails', () => {
    const project = temporaryProject();
    const original = { ...createDefaultConfig(project), marker: 'original' };
    writeConfig(project, original);
    const dependencies: AtomicConfigWriteDependencies = {
      openSync: fs.openSync,
      writeFileSync: fs.writeFileSync,
      fsyncSync: fs.fsyncSync,
      closeSync: fs.closeSync,
      renameSync: () => { throw new Error('simulated atomic replacement failure'); },
      unlinkSync: fs.unlinkSync,
    };

    expect(() => writeConfig(project, { ...original, marker: 'replacement' }, dependencies))
      .toThrow(/simulated atomic replacement failure/);
    expect(readConfig(project)).toMatchObject({ marker: 'original' });
    expect(fs.readdirSync(path.dirname(descriptorPath(project))).filter((name) => name.endsWith('.tmp')))
      .toEqual([]);
  });
});

describe('install secure descriptor integration', () => {
  it('uses the shared secure default and atomic writer', async () => {
    const project = makeUnityProject();
    const result = await installAll({
      unityProjectPath: project,
      pluginSource: { kind: 'file', path: 'unused' },
      skipPlugin: true,
      skipNuget: true,
    });

    expect(result.kind).toBe('success');
    const config = readConfig(project)!;
    expect(config).toMatchObject({ authOption: 'required', connectionMode: 'Custom' });
    expect(Buffer.from(config.token!, 'base64url')).toHaveLength(32);
  });

  it('does not overwrite malformed config even with overwriteConfig requested', async () => {
    const project = makeUnityProject();
    fs.mkdirSync(path.dirname(descriptorPath(project)), { recursive: true });
    fs.writeFileSync(descriptorPath(project), '{ malformed-install-config', 'utf8');

    const result = await installAll({
      unityProjectPath: project,
      pluginSource: { kind: 'file', path: 'unused' },
      skipPlugin: true,
      skipNuget: true,
      overwriteConfig: true,
    });

    expect(result.kind).toBe('failure');
    expect(fs.readFileSync(descriptorPath(project), 'utf8')).toBe('{ malformed-install-config');
  });
});
