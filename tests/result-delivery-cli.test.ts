import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const packageRoot = process.cwd();
const tsx = path.join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (path.basename(dir).startsWith('uco-evidence-cli-')) rmSync(dir, { recursive: true, force: true });
  }
});

function run(args: string[]) {
  return spawnSync(process.execPath, [tsx, 'src/index.ts', ...args], { cwd: packageRoot, encoding: 'utf8' });
}

describe('result delivery CLI routing', () => {
  it('rejects unsupported compact requests before connecting to Unity', () => {
    const result = run(['call', 'gameobject-create', '--result-view', 'compact', '--evidence-file', 'unused.json', '--json']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: { code: 'compact-view-unsupported' } });
  });

  it('reads hash-verified evidence locally with globals after the nested command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'uco-evidence-cli-'));
    dirs.push(dir);
    const file = path.join(dir, 'result.json');
    const bytes = Buffer.from(JSON.stringify({ values: [10, 20, 30] }), 'utf8');
    writeFileSync(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const result = run(['evidence', 'show', file, '--sha256', sha256, '--pointer', '/values', '--offset', '1', '--limit', '1', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ total: 3, shown: 1, value: [20] });
  });
});
