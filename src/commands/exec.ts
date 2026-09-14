// uco exec — Roslyn-execute arbitrary C# inside the Unity Editor (or
// runtime build). This is Unity-MCP's killer primitive: when no
// pre-registered tool covers your need, you can write a C# snippet that
// reaches anything in Unity's API and have it compiled + run on the
// main thread.
//
// Maps to the upstream `script-execute` tool. Default mode is full code: the
// input must define a complete class with a static entry method. Body-only
// snippets need --method-body (+ --return-type when the body returns a value).

import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../util/cli-context.js';
import { resolveTextInput } from '../util/input.js';
import {
  addToolCallControlOptions,
  toolCallOptionsFromCli,
  type ToolCallCliOptions,
} from '../util/call-control.js';

interface ExecOptions extends ToolCallCliOptions {
  code?: string;
  file?: string;
  codeFile?: string;
  methodBody?: boolean;
  returnType?: string;
  className?: string;
  methodName?: string;
  async?: boolean;
}

export function registerExec(program: Command): void {
  const command = program
    .command('exec')
    .description('Compile and execute C# code inside Unity (script-execute / Roslyn).')
    .addOption(new Option('-c, --code <csharp>', 'Inline C# code').conflicts(['file', 'codeFile']))
    .addOption(new Option('-f, --file <path>', 'Compatibility alias: read strict UTF-8 C# from a path or -').conflicts(['code', 'codeFile']))
    .addOption(new Option('--code-file <path>', 'Read strict UTF-8 C# from a path or - (stdin)').conflicts(['code', 'file']))
    .addOption(new Option('--method-body', 'Treat the input as method-body statements only; the tool wraps them in a generated class/method (isMethodBody=true). Combine with --return-type when the body ends in a return.'))
    .addOption(new Option('--return-type <type>', 'Return type of the generated method in --method-body mode (e.g. int, string, UnityEngine.Vector3). The body must end with a return statement.'))
    .addOption(new Option('--class-name <name>', 'Class name for --method-body mode (default: Script). In full-code mode the class must already define it.'))
    .addOption(new Option('--method-name <name>', 'Method name for --method-body mode (default: Main). In full-code mode the class must already define it.'))
    .addOption(new Option('--async', 'Fire-and-forget: dispatch the call, print the accepted envelope with its callId, and return immediately. Resolve the outcome later with `uco call get <callId> --wait`.').conflicts(['wait', 'waitUntilIdle']))
    .addHelpText(
      'after',
      `
Modes:
  Full code (default): the input must be a complete class with a static method —
  no top-level statements.
  Body-only (--method-body): provide just the method body; the tool generates
  the usings, class, and method header. Use --return-type to read a value back.

Authoring confirmation:
  A risky execution can first return confirmation_required without running the
  code. Re-run the exact same command (including identical --code/--code-file
  content) and append the printed Retry fragment. It preserves the bound logical
  context and opaque one-use token; do not edit or replay it after success.

Examples:
  uco exec --code "using UnityEngine; public class Script { public static void Main() { Debug.Log(\\"hi\\"); } }"
  uco exec --method-body --return-type int --code "return UnityEngine.Selection.gameObjects.Length;"
  uco exec --file snippets/spawn-grid.cs --call-id script-1 --correlation-id authoring-1
  uco exec --file snippets/spawn-grid.cs <printed Retry fragment>
  echo 'return GameObject.FindObjectsOfType<Camera>().Length;' | uco exec --method-body --return-type int --code-file -
      `,
    )
    .action(function (this: Command, opts: ExecOptions) {
      return runCommand(this, async (ctx) => {
        const control = toolCallOptionsFromCli(opts);
        if (opts.async === true) {
          // The async path needs a caller-known callId so the printed envelope
          // can be followed up; generate one unless the caller supplied ids.
          if (control.callId === undefined && control.context?.callId === undefined && control.requestID === undefined) {
            control.callId = `c-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
          }
          control.asyncRequest = true;
        }
        return ctx.transport.callTool(
          'script-execute',
          buildExecArguments(opts),
          control,
        );
      })();
    });
  addToolCallControlOptions(command);
}

export function loadCode(opts: ExecOptions): string {
  return resolveTextInput(opts.code, opts.codeFile ?? opts.file, '--code', '--code-file');
}

export function buildExecArguments(opts: ExecOptions): Record<string, unknown> {
  const args: Record<string, unknown> = { csharpCode: loadCode(opts) };
  if (opts.methodBody) args.isMethodBody = true;
  if (opts.returnType !== undefined) args.returnType = opts.returnType;
  if (opts.className !== undefined) args.className = opts.className;
  if (opts.methodName !== undefined) args.methodName = opts.methodName;
  return args;
}
