import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverResult, validateResultDelivery } from '../src/util/result-delivery.js';
import { showEvidence } from '../src/commands/evidence.js';

const dirs: string[] = [];
function evidencePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'uco-evidence-test-'));
  dirs.push(dir);
  return path.join(dir, 'result.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    if (path.basename(dir).startsWith('uco-evidence-test-')) rmSync(dir, { recursive: true, force: true });
  }
});

describe('result delivery', () => {
  it('keeps default full output unchanged and rejects unsupported compact before execution', () => {
    const value = { answer: 42 };
    expect(deliverResult(value, { toolName: 'any-tool' }).value).toBe(value);
    expect(() => validateResultDelivery({ view: 'compact', toolName: 'gameobject-create', evidenceFile: 'x' }))
      .toThrow(/No compact view/);
    expect(() => validateResultDelivery({ view: 'ref', toolName: 'any-tool' })).toThrow(/requires --evidence-file/);
  });

  it('saves the complete redacted result, links atomically, and does not overwrite evidence', () => {
    const file = evidencePath();
    const result = { structured: { result: { secret: 'private', payload: [1, 2] } }, token: 'sensitive' };
    const first = deliverResult(result, { view: 'ref', evidenceFile: file, toolName: 'any-tool' });
    const ref = first.value as { evidence: { sha256: string; bytes: number } };
    const bytes = readFileSync(file);
    expect(bytes.toString('utf8')).not.toContain('sensitive');
    expect(bytes.toString('utf8')).not.toContain('private');
    expect(ref.evidence.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(ref.evidence.bytes).toBe(bytes.length);
    expect(readdirSync(path.dirname(file))).toEqual(['result.json']);
    const second = deliverResult({ value: 2 }, { view: 'ref', evidenceFile: file, toolName: 'any-tool' });
    expect(second.warning).toMatchObject({ code: 'evidence-write-failed', operationExecuted: true });
    expect(second.value).toEqual({ value: 2 });
    expect(readFileSync(file)).toEqual(bytes);
  });

  it('keeps full output when evidence was requested, including after a write failure', () => {
    const file = evidencePath();
    const value = { structured: { result: { count: 3 } } };
    const first = deliverResult(value, { view: 'full', evidenceFile: file, toolName: 'scene-get-data' });
    expect(first.value).toEqual(value);
    expect(first.warning).toBeUndefined();
    const second = deliverResult(value, { view: 'full', evidenceFile: file, toolName: 'scene-get-data' });
    expect(second.value).toEqual(value);
    expect(second.warning).toMatchObject({ code: 'evidence-write-failed', operationExecuted: true });
  });

  it('auto keeps small results full and creates no evidence file', () => {
    const dir = path.dirname(evidencePath());
    const value = { structured: { result: { Entries: [{ Message: 'short' }], DroppedEntries: 0, TruncatedEntries: 0 } } };
    const delivered = deliverResult(value, { view: 'auto', toolName: 'console-get-logs', autoReadOnly: true, evidenceDir: dir });
    expect(delivered).toMatchObject({ view: 'full', value });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('auto compacts a large read-only scene and generates an evidence path', () => {
    const dir = path.dirname(evidencePath());
    const children = Array.from({ length: 120 }, (_, index) => ({
      name: `Node${index}`, path: `Canvas/SectionWithLongName/Node${index}`, instanceID: index + 2,
      activeSelf: true, activeInHierarchy: true,
    }));
    const value = { structured: { result: { RootCount: 1, RootGameObjects: [
      { Hierarchy: { name: 'Canvas', path: 'Canvas', instanceID: 1, activeSelf: true, activeInHierarchy: true, children } },
    ] } } };
    const delivered = deliverResult(value, { view: 'auto', toolName: 'scene-get-data', autoReadOnly: true, evidenceDir: dir });
    const compact = delivered.value as { resultView: string; evidence: { path: string; sha256: string }; hierarchy: { total: number; omitted: number } };
    expect(delivered.view).toBe('compact');
    expect(compact.hierarchy).toMatchObject({ total: 121, omitted: 41 });
    expect(path.dirname(compact.evidence.path)).toBe(dir);
    expect(showEvidence(compact.evidence.path, { sha256: compact.evidence.sha256, pointer: '/structured/result/RootGameObjects/0/Hierarchy/children/119/name' }).value)
      .toBe('Node119');
  });

  it('auto references a large read-only noncompact result, but not mutations or inline images', () => {
    const dir = path.dirname(evidencePath());
    const value = { structured: { result: { data: 'x'.repeat(40_000) } } };
    const read = deliverResult(value, { view: 'auto', toolName: 'assets-get-data', autoReadOnly: true, evidenceDir: dir });
    expect(read.view).toBe('ref');
    expect((read.value as { evidence: { path: string } }).evidence.path).toMatch(/uco-evidence-assets-get-data-.*\.json$/);
    const mutation = deliverResult(value, { view: 'auto', toolName: 'gameobject-create', evidenceDir: dir });
    expect(mutation).toMatchObject({ view: 'full', value });
    const screenshot = deliverResult(value, { view: 'auto', toolName: 'screenshot-scene-view', autoReadOnly: true, evidenceDir: dir });
    expect(screenshot.view).toBe('full');
    const image = deliverResult({ content: [{ type: 'image', data: 'x'.repeat(40_000) }] },
      { view: 'auto', toolName: 'assets-get-data', autoReadOnly: true, evidenceDir: dir });
    expect(image.view).toBe('full');
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('auto honors an explicit evidence file even for a small result and validates path options', () => {
    const file = evidencePath();
    const value = { answer: 1 };
    expect(deliverResult(value, { view: 'auto', toolName: 'editor-application-get-state',
      autoReadOnly: true, evidenceFile: file })).toMatchObject({ view: 'full', value });
    expect(readFileSync(file, 'utf8')).toContain('"answer": 1');
    expect(() => validateResultDelivery({ view: 'auto', toolName: 'scene-get-data', evidenceFile: file,
      evidenceDir: path.dirname(file) })).toThrow(/mutually exclusive/);
    expect(() => validateResultDelivery({ view: 'auto', toolName: 'scene-get-data',
      evidenceDir: path.join(path.dirname(file), 'missing') })).toThrow(/existing directory/);
  });

  it('supports directory-named ref evidence and treats a vanished directory as post-call write failure', () => {
    const dir = path.dirname(evidencePath());
    const value = { answer: 2 };
    const first = deliverResult(value, { view: 'ref', toolName: 'editor-application-get-state', evidenceDir: dir });
    expect(first.view).toBe('ref');
    expect((first.value as { evidence: { path: string } }).evidence.path).toMatch(/uco-evidence-editor-application-get-state-.*\.json$/);
    rmSync(dir, { recursive: true });
    const second = deliverResult(value, { view: 'ref', toolName: 'editor-application-get-state', evidenceDir: dir });
    expect(second).toMatchObject({ view: 'full', value, warning: { code: 'evidence-write-failed', operationExecuted: true } });
  });

  it('summarizes a scene hierarchy and preserves exact evidence for drill-down', () => {
    const file = evidencePath();
    const result = { structured: { result: { Name: 'Sample', RootCount: 1, RootGameObjects: [
      { Hierarchy: { name: 'Canvas', path: 'Canvas', instanceID: 1, activeSelf: true, activeInHierarchy: true,
        children: [{ name: 'Confirm', path: 'Canvas/Confirm', instanceID: 2, activeSelf: false, activeInHierarchy: false }] } },
    ] } } };
    const delivered = deliverResult(result, { view: 'compact', evidenceFile: file, toolName: 'scene-get-data' });
    const compact = delivered.value as { hierarchy: { total: number; rows: unknown[][]; columns: string[] }; sourcePointer: string; evidence: { sha256: string } };
    expect(compact.hierarchy.total).toBe(2);
    expect(compact.hierarchy.columns).toEqual(['pathOrName', 'instanceID', 'activeSelf', 'activeInHierarchy']);
    expect(compact.hierarchy.rows).toContainEqual(['Canvas/Confirm', 2, false, false]);
    expect(compact.sourcePointer).toBe('/structured/result');
    expect(showEvidence(file, { sha256: compact.evidence.sha256, pointer: '/structured/result/RootGameObjects/0/Hierarchy/children/0' }).value)
      .toMatchObject({ path: 'Canvas/Confirm', instanceID: 2 });
  });

  it('includes console loss accounting and original indexes while bounding messages', () => {
    const file = evidencePath();
    const result = { structured: { result: { Entries: [{ LogType: 'Error', Timestamp: 'now', Message: 'x'.repeat(1000), StackTrace: 'trace' }],
      DroppedEntries: 2, TruncatedEntries: 3 } } };
    const compact = deliverResult(result, { view: 'compact', evidenceFile: file, toolName: 'console-get-logs' }).value as
      { DroppedEntries: number; TruncatedEntries: number; entries: Array<{ index: number; Message: string; hasStackTrace: boolean }> };
    expect(compact).toMatchObject({ DroppedEntries: 2, TruncatedEntries: 3 });
    expect(compact.entries[0]).toMatchObject({ index: 0, hasStackTrace: true });
    expect(compact.entries[0].Message.length).toBeLessThan(250);
  });

  it('keeps failed batch children visible ahead of successful children', () => {
    const file = evidencePath();
    const results = Array.from({ length: 110 }, (_, index) => ({ Tool: `read-${index}`, Ok: true, Data: { large: 'x'.repeat(100) } }));
    results.push({ Tool: 'write-last', Ok: false, Error: 'failed', Transaction: { rollback: 'partial', mutated: true, aborted: true } } as never);
    const result = { structured: { result: { TotalCommands: 111, Succeeded: 110, Failed: 1, Aborted: false, RanInParallel: false, Results: results } } };
    const compact = deliverResult(result, { view: 'compact', evidenceFile: file, toolName: 'batch-execute' }).value as
      { Failed: number; omitted: number; omittedFailures: number; results: Array<{ index: number; Tool: string; transaction?: unknown }> };
    expect(compact.Failed).toBe(1);
    expect(compact.omitted).toBe(11);
    expect(compact.omittedFailures).toBe(0);
    expect(compact.results).toContainEqual(expect.objectContaining({ index: 110, Tool: 'write-last', transaction: {
      present: true, rollback: 'partial', mutated: true, aborted: true,
    } }));
  });
});

describe('evidence show', () => {
  it('verifies the hash before parsing and pages arrays', () => {
    const file = evidencePath();
    const bytes = Buffer.from(JSON.stringify({ 'a/b': [0, 1, 2, 3] }), 'utf8');
    writeFileSync(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(showEvidence(file, { sha256, pointer: '/a~1b', offset: '1', limit: '2' })).toMatchObject({
      total: 4, offset: 1, shown: 2, value: [1, 2],
    });
    expect(() => showEvidence(file, { sha256: '0'.repeat(64) })).toThrow(/mismatch/);
    expect(() => showEvidence(file, { sha256, pointer: '/a~2b' })).toThrow(/escape/);
  });

  it('rejects invalid UTF-8 and requires explicit --all for large values', () => {
    const file = evidencePath();
    const invalid = Buffer.from([0xff, 0xfe]);
    writeFileSync(file, invalid);
    expect(() => showEvidence(file, { sha256: createHash('sha256').update(invalid).digest('hex') })).toThrow(/UTF-8 JSON/);
    const large = Buffer.from(JSON.stringify({ long: 'x'.repeat(40_000) }), 'utf8');
    writeFileSync(file, large);
    const sha256 = createHash('sha256').update(large).digest('hex');
    expect(() => showEvidence(file, { sha256 })).toThrow(/32 KiB/);
    expect(showEvidence(file, { sha256, all: true }).value).toEqual({ long: 'x'.repeat(40_000) });
  });
});
