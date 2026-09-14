import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  findUnityProcess: vi.fn(),
  readLockfilePid: vi.fn(),
  isProcessAlive: vi.fn(),
  waitForExit: vi.fn(),
}));

vi.mock('../src/devops/utils/unity-process.js', () => ({
  findUnityProcess: mocks.findUnityProcess,
}));

vi.mock('../src/devops/utils/unity-shutdown.js', () => ({
  readLockfilePid: mocks.readLockfilePid,
  isProcessAlive: mocks.isProcessAlive,
  waitForExit: mocks.waitForExit,
}));

vi.mock('../src/util/cli-context.js', async () => {
  const actual = await vi.importActual<typeof import('../src/util/cli-context.js')>(
    '../src/util/cli-context.js',
  );
  return {
    ...actual,
    runCommand: (_command: Command, action: (ctx: unknown) => Promise<unknown>) => (
      async () => action({ transport: { callTool: mocks.callTool } })
    ),
  };
});

import { registerClose } from '../src/commands/devops/close.js';

const temporaryDirectories: string[] = [];

function unityProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-close-'));
  temporaryDirectories.push(project);
  fs.mkdirSync(path.join(project, 'ProjectSettings'));
  fs.writeFileSync(
    path.join(project, 'ProjectSettings', 'ProjectVersion.txt'),
    'm_EditorVersion: 6000.5.6f1\n',
  );
  return project;
}

function program(): Command {
  const result = new Command().exitOverride();
  registerClose(result);
  return result;
}

beforeEach(() => {
  mocks.callTool.mockReset();
  mocks.findUnityProcess.mockReset().mockReturnValue({ pid: 4242, commandLine: 'Unity' });
  mocks.readLockfilePid.mockReset().mockReturnValue(null);
  mocks.isProcessAlive.mockReset().mockReturnValue(false);
  mocks.waitForExit.mockReset();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('safe Editor close regressions', () => {
  it('requests normal close and succeeds only after the resolved PID exits', async () => {
    const project = unityProject();
    mocks.callTool.mockResolvedValue({ StructuredContent: { Ok: true, Accepted: true, EditorPid: 4242 } });
    mocks.waitForExit.mockResolvedValue(true);

    await program().parseAsync(['node', 'uco', 'close', project, '--timeout-seconds', '7']);

    expect(mocks.callTool).toHaveBeenCalledWith(
      'editor-application-request-close',
      {},
      { timeoutMs: 7_000 },
    );
    expect(mocks.waitForExit).toHaveBeenCalledWith(4242, 7_000, expect.any(String));
  });

  it('surfaces saved-or-idle blockers without waiting or terminating the process', async () => {
    const project = unityProject();
    mocks.callTool.mockResolvedValue({
      result: { Ok: false, Accepted: false, Blockers: ['dirty-scene: Assets/Test.unity'] },
    });

    await expect(program().parseAsync(['node', 'uco', 'close', project]))
      .rejects.toMatchObject({ code: 'close-refused' });
    expect(mocks.waitForExit).not.toHaveBeenCalled();
  });

  it('rejects the deprecated force flag before contacting the Editor', async () => {
    const project = unityProject();

    await expect(program().parseAsync(['node', 'uco', 'close', project, '--force']))
      .rejects.toMatchObject({ code: 'force-close-disabled' });
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.waitForExit).not.toHaveBeenCalled();
  });

  it('returns final state diagnostics after a bounded normal-close timeout', async () => {
    const project = unityProject();
    mocks.callTool
      .mockResolvedValueOnce({ Ok: true, Accepted: true, EditorPid: 4242 })
      .mockResolvedValueOnce({ isCompiling: true, retryCount: 0 });
    mocks.waitForExit.mockResolvedValue(false);

    await expect(program().parseAsync([
      'node', 'uco', 'close', project, '--timeout-seconds', '1',
    ])).rejects.toMatchObject({
      code: 'graceful-timeout',
      details: {
        pid: 4242,
        timeoutSeconds: 1,
        finalState: { isCompiling: true, retryCount: 0 },
      },
    });
    expect(mocks.waitForExit).toHaveBeenCalledTimes(1);
  });
});
