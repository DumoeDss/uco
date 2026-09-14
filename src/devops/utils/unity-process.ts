import { execSync } from 'child_process';
import { platform } from 'os';
import * as path from 'path';
import { verbose } from './ui.js';

export interface UnityProcess {
  pid: number;
  projectPath: string;
  commandLine: string;
}

/**
 * Check if a Unity Editor process is running with the given project path.
 * Returns process info if found, null otherwise. `detectionError` explains
 * why the answer could not be established (probe timeout/failure) so callers
 * can distinguish "confirmed not running" from "could not detect".
 */
export interface UnityProcessLookup {
  process: UnityProcess | null;
  detectionError?: string;
}

export function findUnityProcess(projectPath: string): UnityProcess | null {
  return lookupUnityProcess(projectPath).process;
}

export function lookupUnityProcess(projectPath: string): UnityProcessLookup {
  const isWindows = platform() === 'win32';
  const resolvedTarget = path.resolve(projectPath);
  const normalizedTarget = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;
  const listing = listUnityProcesses();

  if (listing.error !== undefined && listing.processes.length === 0) {
    return { process: null, detectionError: listing.error };
  }

  for (const proc of listing.processes) {
    const normalizedProc = isWindows ? proc.projectPath.toLowerCase() : proc.projectPath;
    if (normalizedProc === normalizedTarget) {
      verbose(`Found Unity process PID ${proc.pid} with project: ${proc.projectPath}`);
      return { process: proc };
    }
  }

  verbose(`No Unity process found for project: ${projectPath}`);
  return { process: null };
}

interface UnityProcessListing {
  processes: UnityProcess[];
  error?: string;
}

/**
 * List all running Unity Editor processes with their project paths.
 */
function listUnityProcesses(): UnityProcessListing {
  const os = platform();
  const results: UnityProcess[] = [];

  try {
    let lines: string[];

    if (os === 'win32') {
      const psCommand = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='Unity.exe'\\" | Select-Object ProcessId,CommandLine | ForEach-Object { $_.ProcessId.ToString() + '|||' + $_.CommandLine }"`;
      const output = execSync(
        psCommand,
        { encoding: 'utf-8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      lines = output.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        const sepIdx = line.indexOf('|||');
        if (sepIdx === -1) continue;

        const pid = parseInt(line.substring(0, sepIdx).trim(), 10);
        const commandLine = line.substring(sepIdx + 3).trim();

        if (!Number.isFinite(pid) || pid === 0) continue;

        const projectPathMatch = commandLine.match(/-projectPath\s+"([^"]+)"/i)
          ?? commandLine.match(/-projectPath\s+(\S+)/i);

        if (projectPathMatch) {
          results.push({
            pid,
            projectPath: path.resolve(projectPathMatch[1].trim()),
            commandLine,
          });
        }
      }
    } else {
      // macOS / Linux
      const output = execSync(
        "ps -eo pid,args | grep -i '[U]nity' || true",
        { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      lines = output.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        if (!match) continue;

        const pid = parseInt(match[1], 10);
        const commandLine = match[2];

        if (!commandLine.includes('-projectPath')) continue;

        const projectPathMatch = commandLine.match(/-projectPath\s+"([^"]+)"/)
          ?? commandLine.match(/-projectPath\s+(\S+)/);

        if (projectPathMatch) {
          results.push({
            pid,
            projectPath: path.resolve(projectPathMatch[1].trim()),
            commandLine,
          });
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    verbose(`Failed to list Unity processes: ${message}`);
    verbose(`Found ${results.length} Unity process(es) before the failure`);
    return { processes: results, error: message };
  }

  verbose(`Found ${results.length} Unity process(es)`);
  return { processes: results };
}
