import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExecArguments, loadCode, registerExec } from '../src/commands/exec.js';
import { loadArgs, registerCall } from '../src/commands/call.js';
import { coerceGameObjectRef, coerceJson, coerceVec3 } from '../src/codegen/coerce.js';
import { emitToolCommands } from '../src/codegen/emit.js';
import { CliError, TransportError } from '../src/util/errors.js';
import { ToolCallControlError } from '../src/tool-call-control.js';
import { runCommand } from '../src/util/cli-context.js';
import { toolCallOptionsFromCli } from '../src/util/call-control.js';
import { redactSensitiveValue } from '../src/util/redaction.js';
import { printError, printInfo, printResult, serializeError } from '../src/util/output.js';
import { RestTransport } from '../src/transport/rest.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(name: string, value: string | Buffer): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-input-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, name);
  fs.writeFileSync(file, value);
  return file;
}

describe('UCO feedback command contracts', () => {
  it('maps exec code to csharpCode and reads strict UTF-8 code files', () => {
    expect(buildExecArguments({ code: 'class Inline {}' })).toEqual({
      csharpCode: 'class Inline {}',
    });
    const file = fixture('脚本.cs', 'public class 脚本 { public static void Main() {} }\r\n');
    expect(loadCode({ codeFile: file })).toBe('public class 脚本 { public static void Main() {} }\r\n');
  });

  it('maps exec body-only mode flags onto script-execute arguments', () => {
    expect(buildExecArguments({
      code: 'return Selection.gameObjects.Length;',
      methodBody: true,
      returnType: 'int',
    })).toEqual({
      csharpCode: 'return Selection.gameObjects.Length;',
      isMethodBody: true,
      returnType: 'int',
    });
    expect(buildExecArguments({
      code: 'go.SetActive(false);',
      methodBody: true,
      className: 'Snippets',
      methodName: 'Run',
    })).toEqual({
      csharpCode: 'go.SetActive(false);',
      isMethodBody: true,
      className: 'Snippets',
      methodName: 'Run',
    });
    // Full-code mode (default) never invents entrypoint arguments.
    expect(buildExecArguments({ code: 'public class Script {}' })).toEqual({
      csharpCode: 'public class Script {}',
    });
  });

  it('rejects conflicting or invalid UTF-8 code sources', () => {
    expect(() => loadCode({ code: 'inline', codeFile: 'file.cs' })).toThrow(/mutually exclusive/);
    const file = fixture('invalid.cs', Buffer.from([0xc3, 0x28]));
    expect(() => loadCode({ codeFile: file })).toThrow(/not valid UTF-8/);
  });

  it.each([
    ['call', registerCall],
    ['exec', registerExec],
  ])('documents the %s confirmation retry flow in command help', (commandName, register) => {
    const program = new Command().name('uco');
    register(program);
    const command = program.commands.find((candidate) => candidate.name() === commandName);
    expect(command).toBeDefined();

    let help = '';
    command!.configureOutput({ writeOut: (chunk) => { help += chunk; } });
    command!.outputHelp();
    expect(help).toContain('first return confirmation_required without');
    expect(help).toContain('Re-run the exact same command');
    expect(help).toContain('append the printed Retry fragment');
    expect(help).toContain('do not edit');
  });

  it('loads a complete JSON object and generated @file structured values', () => {
    const file = fixture('参数.json', '{"text":"引号 \\\" 与反斜杠 \\\\","lines":["一","二"]}');
    expect(loadArgs({ argsFile: file })).toEqual({ text: '引号 " 与反斜杠 \\', lines: ['一', '二'] });
    expect(coerceJson(`@${file}`)).toEqual({ text: '引号 " 与反斜杠 \\', lines: ['一', '二'] });
    expect(() => loadArgs({ args: '{}', argsFile: file })).toThrow(/mutually exclusive/);
  });

  it('loads every generated structured coercer from strict UTF-8 @files', () => {
    const objectFile = fixture('对象.json', '{"name":"玩家"}');
    const arrayFile = fixture('数组.json', '["一","二"]');
    const vectorFile = fixture('向量.json', '{"x":1,"y":2.5,"z":-3}');
    const referenceFile = fixture('引用.json', '{"instanceID":42,"name":"玩家"}');

    expect(coerceJson(`@${objectFile}`)).toEqual({ name: '玩家' });
    expect(coerceJson(`@${arrayFile}`)).toEqual(['一', '二']);
    expect(coerceVec3(`@${vectorFile}`)).toEqual({ x: 1, y: 2.5, z: -3 });
    expect(coerceGameObjectRef(`@${referenceFile}`)).toEqual({ instanceID: 42, name: '玩家' });
  });

  it('rejects invalid UTF-8 consistently for every generated structured coercer', () => {
    const invalid = fixture('invalid.json', Buffer.from([0xc3, 0x28]));
    for (const coerce of [coerceJson, coerceVec3, coerceGameObjectRef]) {
      expect(() => coerce(`@${invalid}`)).toThrowError(expect.objectContaining({
        code: 'input-invalid-utf8',
      }));
    }
  });

  it('requires referenced Vector3 and GameObjectRef files to contain JSON objects', () => {
    const vectorShorthand = fixture('vector.txt', '1,2,3');
    const referenceShorthand = fixture('reference.txt', '/Player');
    expect(() => coerceVec3(`@${vectorShorthand}`)).toThrow(/JSON/);
    expect(() => coerceGameObjectRef(`@${referenceShorthand}`)).toThrow(/JSON/);
  });

  it.each([
    ['coerceJson', '{"text":"标准输入"}', { text: '标准输入' }],
    ['coerceJson', '[1,2,3]', [1, 2, 3]],
    ['coerceVec3', '{"x":4,"y":5,"z":6}', { x: 4, y: 5, z: 6 }],
    ['coerceGameObjectRef', '{"path":"/玩家"}', { path: '/玩家' }],
  ])('loads @- through the production %s coercer', (functionName, stdin, expected) => {
    const script = [
      `import { ${functionName} } from './src/codegen/coerce.ts';`,
      `process.stdout.write(JSON.stringify(${functionName}('@-')));`,
    ].join('\n');
    const result = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', script,
    ], {
      cwd: process.cwd(),
      input: stdin,
      encoding: 'utf8',
      shell: false,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it('keeps generated script execution file transport after regeneration', () => {
    const output = emitToolCommands([{
      name: 'script-execute',
      title: 'Script Execute',
      description: 'execute',
      inputSchema: {
        type: 'object',
        required: ['csharpCode'],
        properties: { csharpCode: { type: 'string', description: 'code' } },
      },
    }]);
    expect(output).toContain('--code-file <path>');
    expect(output).toContain('resolveTextInput(opts["csharpCode"], opts["codeFile"]');
    expect(output).not.toContain('code\").makeOptionMandatory(true)');
  });

  it('emits the canonical failure shape with retryability', () => {
    expect(serializeError(new CliError('bad input', 'bad-input'))).toEqual({
      ok: false,
      error: {
        code: 'bad-input',
        message: 'bad input',
        retryable: false,
      },
    });
    expect(serializeError(new TransportError({
      kind: 'timeout', url: 'http://localhost', method: 'GET', message: 'late',
    }))).toMatchObject({ ok: false, error: { code: 'transport-timeout', retryable: true } });
  });

  it('renders the complete production retry as one unambiguous control object', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printError({ json: false, verbose: false }, new TransportError({
      kind: 'http',
      url: 'http://localhost/api/tools/script-execute',
      method: 'POST',
      message: 'This tool call requires confirmation before it can execute.',
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_required',
          message: 'This tool call requires confirmation before it can execute.',
          retryable: false,
          details: {
            confirmationPlan: { planLevel: 'none' },
            retryWith: {
              requestID: "request-o'clock",
              control: {
                futureFlag: true,
                opaqueState: { generation: 7 },
                version: 1,
                callId: "call-o'clock",
                correlationId: 'trace-abc',
                parentCallId: 'parent-abc',
                deadlineUnixMs: 4_102_444_800_000,
                cancellationId: 'cancel-opaque',
                idempotencyKey: 'idempotency-opaque',
                confirm: true,
                dryRun: 'none',
                confirmation: {
                  planId: "plan-o'clock",
                  planHash: 'sha256-def',
                  expiresAtUnixMs: 4_102_444_800_000,
                },
              },
            },
          },
        },
      },
    }));

    const rendered = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(rendered).toContain(
      "Retry: --request-id 'request-o'\"'\"'clock' --control '{\"futureFlag\":true,\"opaqueState\":{\"generation\":7},\"version\":1,\"callId\":\"call-o'\"'\"'clock\",\"correlationId\":\"trace-abc\",\"parentCallId\":\"parent-abc\",\"deadlineUnixMs\":4102444800000,\"cancellationId\":\"cancel-opaque\",\"idempotencyKey\":\"idempotency-opaque\",\"confirm\":true,\"dryRun\":\"none\",\"confirmation\":{\"planId\":\"plan-o'\"'\"'clock\",\"planHash\":\"sha256-def\",\"expiresAtUnixMs\":4102444800000}}'",
    );
    expect(rendered.match(/--control/g)).toHaveLength(1);
    expect(rendered).not.toContain(' --confirm');
    expect(rendered).not.toContain(' --confirmation');
  });

  it('round-trips the rendered production retry through CLI parsing and REST serialization', async () => {
    const retryWith = {
      requestID: 'request-round-trip',
      control: {
        futureControl: { generation: 7, enabled: true },
        version: 1,
        callId: 'call-round-trip',
        correlationId: 'trace-round-trip',
        parentCallId: 'parent-round-trip',
        deadlineUnixMs: 4_102_444_800_000,
        cancellationId: 'cancel-round-trip',
        idempotencyKey: 'idempotency-round-trip',
        confirm: true,
        dryRun: 'none',
        confirmation: {
          planId: 'plan-round-trip',
          planHash: 'sha256-round-trip',
          expiresAtUnixMs: 4_102_444_800_000,
        },
      },
    } as const;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printError({ json: false, verbose: false }, new TransportError({
      kind: 'http',
      url: 'http://localhost/api/tools/script-execute',
      method: 'POST',
      message: 'This tool call requires confirmation before it can execute.',
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_required',
          message: 'This tool call requires confirmation before it can execute.',
          retryable: false,
          details: { retryWith },
        },
      },
    }));

    const rendered = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    const retryFragment = /Retry: ([^\r\n]+)/.exec(rendered)?.[1];
    expect(retryFragment).toBeDefined();
    expect(retryFragment!.match(/--control/g)).toHaveLength(1);
    expect(retryFragment!.match(/--request-id/g)).toHaveLength(1);
    expect(retryFragment).not.toContain(' --confirm');
    expect(retryFragment).not.toContain(' --confirmation');
    const parsedFragment = /^--request-id '([^']*)' --control '([^']*)'$/.exec(retryFragment!);
    expect(parsedFragment).not.toBeNull();
    const renderedRequestID = parsedFragment![1]!;
    const renderedControlJson = parsedFragment![2]!;
    expect(renderedRequestID).toBe(retryWith.requestID);
    expect(renderedControlJson).toBe(JSON.stringify(retryWith.control));

    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    });
    const transport = new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });
    await transport.callTool(
      'script-execute',
      { csharpCode: 'return;' },
      toolCallOptionsFromCli({ requestId: renderedRequestID, control: renderedControlJson }),
    );

    const changedControl = JSON.parse(renderedControlJson) as Record<string, unknown>;
    changedControl['futureControl'] = { generation: 8, enabled: true };
    await transport.callTool(
      'script-execute',
      { csharpCode: 'return;' },
      toolCallOptionsFromCli({ requestId: renderedRequestID, control: JSON.stringify(changedControl) }),
    );
    const droppedControl = JSON.parse(renderedControlJson) as Record<string, unknown>;
    delete droppedControl['futureControl'];
    await transport.callTool(
      'script-execute',
      { csharpCode: 'return;' },
      toolCallOptionsFromCli({ requestId: renderedRequestID, control: JSON.stringify(droppedControl) }),
    );

    const forwarded = bodies[0] as { requestID?: string; control: Record<string, unknown> };
    expect(forwarded.requestID).toBe(retryWith.requestID);
    expect(forwarded.control).toEqual(retryWith.control);
    expect(JSON.stringify(forwarded.control['futureControl']))
      .toBe(JSON.stringify(retryWith.control.futureControl));
    expect(JSON.stringify(forwarded.control['confirmation']))
      .toBe(JSON.stringify(retryWith.control.confirmation));
    const normalizedControlInputs = bodies.map((body) => JSON.stringify(body['control']));
    expect(normalizedControlInputs[1]).not.toBe(normalizedControlInputs[0]);
    expect(normalizedControlInputs[2]).not.toBe(normalizedControlInputs[0]);
  });

  it('suppresses incomplete token-only retries from older or fabricated responses', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printError({ json: false, verbose: false }, new ToolCallControlError(
      'confirmation_required',
      'This tool call requires confirmation before it can execute.',
      {
        details: {
          retryWith: {
            control: {
              confirm: true,
              confirmation: {
                planId: 'plan-direct',
                planHash: 'sha256-direct',
                expiresAtUnixMs: 5678,
              },
            },
          },
        },
      },
    ));

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain('Retry:');
  });

  it.each([
    ['oversized control', {
      retryWith: {
        requestID: 'request-safe',
        control: {
          version: 1,
          callId: 'call-safe',
          correlationId: 'trace-safe',
          opaqueState: 'x'.repeat(16_385),
          confirm: true,
          dryRun: 'none',
          confirmation: { planId: 'plan', planHash: 'hash', expiresAtUnixMs: 1234 },
        },
      },
    }],
    ['credential-bearing control', {
      retryWith: {
        requestID: 'request-safe',
        control: {
          version: 1,
          callId: 'call-safe',
          correlationId: 'trace-safe',
          authorization: 'Bearer fixture-control-secret',
          confirm: true,
          dryRun: 'none',
          confirmation: { planId: 'plan', planHash: 'hash', expiresAtUnixMs: 1234 },
        },
      },
    }],
    ['credential-bearing request id', {
      retryWith: {
        requestID: 'Bearer fixture-request-secret',
        control: {
          version: 1,
          callId: 'call-safe',
          correlationId: 'trace-safe',
          confirm: true,
          dryRun: 'none',
          confirmation: { planId: 'plan', planHash: 'hash', expiresAtUnixMs: 1234 },
        },
      },
    }],
  ])('suppresses retry output for %s production details', (_label, details) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    printError({ json: false, verbose: false }, new ToolCallControlError(
      'confirmation_required',
      'This tool call requires confirmation before it can execute.',
      { details },
    ));

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain('Retry:');
  });

  it('preserves redacted CliError diagnostics without duplicating the error envelope', () => {
    expect(serializeError(new CliError(
      'Timed out waiting for editor.',
      'wait-timeout',
      3,
      true,
      { stage: 'editor', cause: 'IsCompiling', attempts: 4, nested: { token: 'fixture-secret' } },
    ))).toEqual({
      ok: false,
      error: {
        code: 'wait-timeout',
        message: 'Timed out waiting for editor.',
        retryable: true,
        details: {
          stage: 'editor',
          cause: 'IsCompiling',
          attempts: 4,
          nested: { token: '[REDACTED]' },
        },
      },
    });

    expect(serializeError(new CliError(
      'Editor refused close.',
      'close-refused',
      1,
      false,
      { EditorPid: 4242, Blockers: ['dirty-scene'] },
    ))).toEqual({
      ok: false,
      error: {
        code: 'close-refused',
        message: 'Editor refused close.',
        retryable: false,
        details: { EditorPid: 4242, Blockers: ['dirty-scene'] },
      },
    });
  });

  it('turns the installed nested PascalCase tool failure into stderr-only JSON and exit 5', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const program = new Command()
      .exitOverride()
      .option('--json')
      .option('--url <url>');
    program.command('installed-shape').action(function (this: Command) {
      return runCommand(this, async () => ({
        status: 'success',
        Structured: {
          Result: {
            Ok: false,
            Error: 'GameObject reference is required.',
            diagnostics: { accessToken: 'fixture-secret' },
          },
        },
      }))();
    });

    await expect(program.parseAsync([
      'node', 'uco', '--json', '--url', 'http://127.0.0.1:1', 'installed-shape',
    ])).rejects.toThrow('exit:5');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'tool-reported-failure',
        message: 'GameObject reference is required.',
        retryable: false,
        details: {
          Ok: false,
          Error: 'GameObject reference is required.',
          diagnostics: { accessToken: '[REDACTED]' },
        },
      },
    });
  });

  it('structurally redacts access tokens bearer headers URLs JSON and argument arrays', () => {
    const redacted = redactSensitiveValue({
      accessToken: 'fixture-access',
      nested: { Authorization: 'Bearer fixture-header' },
      url: 'https://example.invalid/path?access_token=fixture-query&safe=yes',
      args: ['-accessToken', 'fixture-arg', '--target', 'WebGL'],
      json: '{"accessToken":"fixture-json","safe":"visible"}',
    });
    const serialized = JSON.stringify(redacted);
    for (const secret of ['fixture-access', 'fixture-header', 'fixture-query', 'fixture-arg', 'fixture-json']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('visible');
    expect(serialized).toContain('WebGL');
  });

  it('redacts synthetic credentials in human JSON error and informational renderers', () => {
    const secret = 'fixture-renderer-secret';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    printResult({ json: false, verbose: false }, `Authorization: Bearer ${secret}`);
    printResult({ json: true, verbose: false }, { accessToken: secret, safe: 'visible' });
    printError({ json: true, verbose: false }, new CliError(
      `failed token=${secret}`,
      'fixture-error',
      1,
      false,
      { authorization: `Bearer ${secret}` },
    ));
    printInfo({ json: false, verbose: false }, `Bearer ${secret}`);

    const rendered = [
      ...stdout.mock.calls.map(([chunk]) => String(chunk)),
      ...stderr.mock.calls.map(([chunk]) => String(chunk)),
    ].join('');
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).toContain('visible');
  });

  it('does not implicitly retry transient Editor state across a generation boundary', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: {
        code: 'editor_settling',
        message: 'Editor generation is settling.',
        retryable: true,
      },
    }), { status: 503, statusText: 'Service Unavailable' }));
    const transport = new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });

    await expect(transport.callTool('editor-application-get-state', {}, { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns a successful Editor-state probe without attaching synthetic retry state', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ isCompiling: false }), { status: 200 }));
    const transport = new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });

    await expect(transport.callTool('editor-application-get-state', {}, { timeoutMs: 5_000 }))
      .resolves.toEqual({ isCompiling: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-transient Editor-state failure', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid request' }), {
      status: 400,
      statusText: 'Bad Request',
    }));
    const transport = new RestTransport({ baseUrl: 'http://localhost:23456', fetchImpl });

    await expect(transport.callTool('editor-application-get-state', {})).rejects.toMatchObject({
      kind: 'http',
      status: 400,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
