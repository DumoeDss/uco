import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advise, compactResult, configuration, readLogSource, runBatch, validateAnswer } from '../skills/unity-editor/scripts/logjev.mjs';
import { installStaticSkillBundle, refreshLiveAgentRuntimeScripts, setupSkillBundle } from '../src/skills/bundle.js';

const env = { UCO_LOGJEV_URL: 'http://127.0.0.1:8013', UCO_LOGJEV_PROVIDER: 'deepseek' };
const input = { task: 'Find the scene button', candidates: [{ id: 'button', description: 'Scene Button' }] };
const temporaryDirectories: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uco-logjev-'));
  temporaryDirectories.push(directory);
  return directory;
}
function answer(q: any, selected = 'c0') {
  if (q.type === 'noul') return { type: 'noul', noul: 0.83 };
  const keys = Object.keys(q.criteria);
  return { type: 'choice', choice: selected, confidence: 0.95,
    probabilities: Object.fromEntries(keys.map(key => [key, key === selected ? 0.95 : 0.05 / (keys.length - 1)])) };
}
function response(payload: any, selected = 'c0') {
  return { model: 'fixture', answers: Object.fromEntries(Object.entries(payload.questions).map(([key, q]) => [key, answer(q, selected)])),
    usage: { input_tokens: 10, output_tokens: 1, reads: 1 } };
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler);
  servers.push(instance);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}
function png() {
  const file = path.join(temporary(), 'image.png');
  fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUZkAAAAASUVORK5CYII=', 'base64'));
  return file;
}

describe('optional LogJev advisory helper', () => {
  it('does not contact any provider without explicit configuration; retains original identity', async () => {
    const transport = vi.fn();
    const result = await advise('select', input, { env: {}, transport });
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_configured', requestCount: 0, advisoryOnly: true });
    expect(result.original).toBe(input);
    expect(transport).not.toHaveBeenCalled();
  });
  it('normalizes localhost and refuses insecure remote endpoints or URL credentials', () => {
    expect(configuration({ ...env, UCO_LOGJEV_URL: 'http://localhost:8013/' }).endpoint.href).toBe('http://127.0.0.1:8013/v1/systemone');
    for (const url of ['http://remote.example', 'file:///tmp/config', 'https://user:secret@host', 'https://host?key=secret']) {
      expect(() => configuration({ ...env, UCO_LOGJEV_URL: url })).toThrow('invalid_config');
    }
    expect(() => configuration({ ...env, UCO_LOGJEV_TIMEOUT_MS: 'Infinity' })).toThrow('invalid_config');
  });
  it('uses internal labels and a no-match candidate even for a singleton; never returns executable arguments', async () => {
    const transport = vi.fn(async (_config, payload) => response(payload));
    const weird = { ...input, candidates: [{ id: '__proto__', description: 'Scene Button' }] };
    const result = await advise('select', weird, { env, transport });
    expect(result).toMatchObject({ status: 'suggested', selected: '__proto__', promptMode: 'full', requestCount: 1 });
    expect(Object.keys(transport.mock.calls[0][1].questions.pick.criteria)).toEqual(['c0', 'none']);
    expect(result).not.toHaveProperty('arguments');
  });
  it.each(['none', 'uniform', 'low', 'close'])('falls back for %s while preserving the original candidates', async variant => {
    const two = { ...input, candidates: [...input.candidates, { id: 'other', description: 'Other Button' }] };
    const result = await advise('select', two, { env, transport: async (_config, payload) => {
      const r = response(payload, variant === 'none' ? 'none' : 'c0');
      if (variant !== 'none') {
        const probabilities = variant === 'uniform' ? { c0: 1 / 3, c1: 1 / 3, none: 1 / 3 }
          : variant === 'low' ? { c0: 0.7, c1: 0.2, none: 0.1 } : { c0: 0.5, c1: 0.49, none: 0.01 };
        r.answers.pick = { type: 'choice', choice: 'c0', probabilities, confidence: probabilities.c0 };
      }
      return r;
    } });
    expect(result.status).toBe('fallback');
    expect(result.selected).toBeNull();
    expect(result.original).toBe(two);
  });
  it('rejects malformed choices, probability keys, sums, values and confidence', () => {
    const question = { type: 'choice', criteria: { c0: 'one', none: 'no match' } };
    const valid = answer(question);
    for (const invalid of [
      null, { ...valid, type: 'score' }, { ...valid, choice: 'shell-command' },
      { ...valid, choice: 'none' }, { ...valid, confidence: 1 },
      { ...valid, probabilities: { c0: 1 } }, { ...valid, probabilities: { c0: 0.95, none: 0.05, extra: 0 } },
      { ...valid, probabilities: { c0: NaN, none: 0.05 } }, { ...valid, probabilities: { c0: 2, none: -1 } },
      { ...valid, probabilities: { c0: 0.95, none: 0.5 } },
    ]) expect(() => validateAnswer(invalid, question)).toThrow('invalid_response');
    expect(() => validateAnswer({ type: 'noul', noul: 1 }, { type: 'noul' })).toThrow('invalid_response');
  });
  it('rejects duplicate IDs and oversized candidates before any request', async () => {
    const transport = vi.fn();
    await expect(advise('select', { ...input, candidates: [input.candidates[0], input.candidates[0]] }, { env, transport })).rejects.toThrow();
    await expect(advise('select', { ...input, candidates: Array.from({ length: 48 }, (_, i) => ({ id: `x${i}`, description: 'x' })) }, { env, transport })).rejects.toThrow('candidate_limit');
    expect(transport).not.toHaveBeenCalled();
  });
  it('routes a large installed catalog with actual IDs and <=48 labels, excluding disabled tools', async () => {
    const catalog = Array.from({ length: 105 }, (_, i) => ({ name: `scene-${i}`, domain: 'authoring', enabled: true, description: `Scene action ${i}` }));
    catalog.push({ name: 'scene-disabled', domain: 'authoring', enabled: false, description: 'never select' });
    const transport = vi.fn(async (_config, payload) => response(payload));
    const result = await advise('tools', { task: 'Find the first scene' }, { env, catalog, transport });
    expect(result).toMatchObject({ status: 'suggested', selected: 'scene-0', requestCount: 2 });
    expect(JSON.stringify(transport.mock.calls)).not.toContain('scene-disabled');
    expect(transport.mock.calls[0][1].questions.route.criteria.c0).toContain('scene-0');
    for (const call of transport.mock.calls) {
      const q: any = Object.values(call[1].questions)[0];
      expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(48);
    }
  });
  it('does not turn uncertain first-stage routing into a confident tool recommendation', async () => {
    const catalog = [{ name: 'scene-open', domain: 'authoring', enabled: true }, { name: 'console-get-logs', domain: 'diagnostics', enabled: true }];
    const transport = vi.fn(async (_c, payload) => {
      const r = response(payload);
      if (r.answers.route) r.answers.route = { type: 'choice', choice: 'c0', confidence: 0.6, probabilities: { c0: 0.6, c1: 0.3, none: 0.1 } };
      return r;
    });
    const result = await advise('tools', { task: 'Inspect' }, { env, catalog, transport });
    expect(result).toMatchObject({ status: 'fallback', reason: 'uncertain_route', selected: null, requestCount: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('sends real image parts in order, no state, with explicit insufficient-evidence options', async () => {
    const first = png();
    const second = png();
    const transport = vi.fn(async (_config, payload) => response(payload));
    const result = await advise('vision', { questions: { visible: { instructions: 'Is PLAY visible?', criteria: { yes: 'yes', no: 'no' } } } },
      { env, images: [first, second], transport });
    const payload = transport.mock.calls[0][1];
    expect(payload).not.toHaveProperty('state');
    expect(payload.messages[0].content.slice(1)).toEqual([first, second].map(file => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${fs.readFileSync(file).toString('base64')}` } })));
    expect(result.judgments.visible.selected).toBe('yes');
    expect(JSON.stringify(result)).not.toContain('base64');
  });
  it('does not send missing/invalid images or screenshots implied only by JSON', async () => {
    const transport = vi.fn();
    const request = { questions: { q: { instructions: 'Visible?', criteria: { yes: 'yes' } } } };
    await expect(advise('vision', request, { env, images: [], transport })).rejects.toThrow('image_count');
    const bad = path.join(temporary(), 'secret.txt');
    fs.writeFileSync(bad, 'not an image');
    expect((await advise('vision', request, { env, images: [bad], transport })).reason).toBe('image_format');
    expect(transport).not.toHaveBeenCalled();
  });
  it('abstains on the low-confidence position distribution observed in the live smoke test', async () => {
    const result = await advise('vision', { questions: {
      error: { instructions: 'Is an ERROR dialog visible?', criteria: { yes: 'yes', no: 'no' } },
      settings: { instructions: 'Where is SETTINGS?', criteria: { above: 'above', below: 'below', absent: 'absent' } },
    } }, { env, images: [png()], transport: async () => ({ answers: {
      error: { type: 'choice', choice: 'c1', confidence: 1, probabilities: { c0: 0, c1: 1, none: 0 } },
      settings: { type: 'choice', choice: 'c1', confidence: 0.57705, probabilities: { c0: 0.416, c1: 0.57705, c2: 0.00194, none: 0.005 } },
    } }) });
    expect(result).toMatchObject({ status: 'fallback', reason: 'inconclusive_judgments', judgments: {
      error: { status: 'suggested', selected: 'no' },
      settings: { status: 'fallback', selected: null, reason: 'uncertain' },
    } });
  });
  it('ranks logs with minimal prompts, bounded concurrency, pinned errors and every original entry intact', async () => {
    let running = 0;
    let peak = 0;
    const logs = { task: 'Scene saving', entries: [{ id: 'low', severity: 'Info', message: 'unrelated' }, { id: 'err', severity: 'Error', message: 'unrelated error' }, { id: 'high', severity: 'Warning', message: 'save issue' }] };
    const result = await advise('logs', logs, { env, transport: async (_c, payload) => {
      peak = Math.max(peak, ++running);
      expect(payload.prompt_mode).toBe('minimal');
      expect(payload.state).not.toHaveProperty('entries');
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return { answers: { relevant: { type: 'noul', noul: payload.state.entry.id === 'high' ? 0.9 : 0.01 } } };
    } });
    expect(peak).toBe(2);
    expect(result.original).toBe(logs);
    expect(result.retainedCount).toBe(3);
    expect(result.ranking.map((entry: any) => entry.id)).toEqual(['err', 'high', 'low']);
  });
  it('discards partial log ranking on failure and does not enqueue all remaining entries', async () => {
    const logs = { task: 'Save', entries: Array.from({ length: 10 }, (_, i) => ({ id: `log${i}` })) };
    const transport = vi.fn(async () => { throw new Error('secret upstream key'); });
    const result = await advise('logs', logs, { env, transport });
    expect(result.status).toBe('fallback');
    expect(result.original).toBe(logs);
    expect(result).not.toHaveProperty('ranking');
    expect(transport.mock.calls.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(result)).not.toContain('secret upstream key');
  });
  it.each([401, 429, 502, 302])('falls back on HTTP %s without retrying, following redirects, or exposing upstream body', async status => {
    let calls = 0;
    const endpoint = await server((_req, res) => { calls++; res.writeHead(status, { Location: 'http://invalid.example' }); res.end('secret'); });
    const result = await advise('select', input, { env: { ...env, UCO_LOGJEV_URL: endpoint } });
    expect(result.reason).toBe(`http_${status}`);
    expect(result.original).toBe(input);
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('uses bridge authentication without exposing it, and rejects wrong answer keys', async () => {
    const endpoint = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-only-bridge-key');
      expect(req.url).toBe('/v1/systemone');
      res.end(JSON.stringify({ answers: { unexpected: {} } }));
    });
    const result = await advise('select', input, { env: { ...env, UCO_LOGJEV_URL: endpoint, UCO_LOGJEV_API_KEY: 'test-only-bridge-key' } });
    expect(result.reason).toBe('invalid_response');
    expect(JSON.stringify(result)).not.toContain('test-only-bridge-key');
  });
  it('enforces a real total HTTP deadline', async () => {
    const endpoint = await server(() => { /* deliberately leave response open */ });
    const result = await advise('select', input, { env: { ...env, UCO_LOGJEV_URL: endpoint, UCO_LOGJEV_TIMEOUT_MS: '100' } });
    expect(result.reason).toBe('timeout');
    expect(result.wallMs).toBeLessThan(2000);
  });
  it.each(['invalid_json', 'oversized', 'disconnect'])('retains the original input on %s responses', async variant => {
    const endpoint = await server((_req, res) => {
      if (variant === 'disconnect') { res.destroy(); return; }
      res.end(variant === 'oversized' ? 'x'.repeat(300000) : '{not JSON');
    });
    const result = await advise('select', input, { env: { ...env, UCO_LOGJEV_URL: endpoint } });
    expect(result.status).toBe('fallback');
    expect(result.reason).toBe(variant === 'oversized' ? 'response_too_large' : variant === 'disconnect' ? 'transport_error' : 'invalid_response');
    expect(result.original).toBe(input);
  });
  it('does not give each routing stage a fresh timeout budget', async () => {
    const transport = vi.fn(async (_c, payload) => {
      await new Promise(resolve => setTimeout(resolve, 120));
      return response(payload);
    });
    const result = await advise('tools', { task: 'Inspect' }, { env: { ...env, UCO_LOGJEV_TIMEOUT_MS: '100' }, transport,
      catalog: [{ name: 'scene-read', domain: 'authoring', enabled: true }, { name: 'console-get-logs', domain: 'diagnostics', enabled: true }] });
    expect(result).toMatchObject({ status: 'fallback', reason: 'timeout' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not attempt a second route after no match or expose an unavailable catalog as success', async () => {
    const transport = vi.fn(async (_c, payload) => response(payload, 'none'));
    const catalog = [{ name: 'scene-read', domain: 'authoring', enabled: true }, { name: 'console-get-logs', domain: 'diagnostics', enabled: true }];
    const result = await advise('tools', { task: 'Weather' }, { env, transport, catalog });
    expect(result.reason).toBe('no_match');
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await advise('tools', { task: 'Inspect' }, { env, catalog: [] })).reason).toBe('no_candidates');
  });
});

function cliFixture() {
  const directory = temporary();
  const scripts = path.join(directory, 'scripts');
  const catalog = path.join(directory, 'catalog');
  fs.mkdirSync(scripts);
  fs.mkdirSync(catalog);
  const helper = path.join(scripts, 'logjev.mjs');
  fs.copyFileSync(new URL('../skills/unity-editor/scripts/logjev.mjs', import.meta.url), helper);
  return { directory, helper, catalog };
}
async function runCli(helper: string, args: string[], endpoint = '') {
  const options = { env: { ...process.env, UCO_LOGJEV_URL: endpoint,
    UCO_LOGJEV_PROVIDER: endpoint ? 'deepseek' : '', UCO_LOGJEV_API_KEY: '', UCO_LOGJEV_MODEL: '', UCO_LOGJEV_TIMEOUT_MS: '1000' },
  timeout: 5000, maxBuffer: 3 * 1024 * 1024 };
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [helper, ...args], options);
    return { code: 0, result: JSON.parse(stdout) };
  } catch (error: any) {
    if (!error.stdout) throw error;
    return { code: error.code, result: JSON.parse(error.stdout) };
  }
}
function jsonFile(directory: string, name: string, value: unknown) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}
function consoleDto(count = 1) {
  return { Entries: Array.from({ length: count }, (_, i) => ({ LogType: 'Log', Message: `日志 ${i}`, Timestamp: '2026-09-22T00:00:00Z',
    Source: 'Unity', StackTrace: 'line 1\nline 2', CorrelationId: 'correlation', OperationId: 'operation' })),
  DroppedEntries: 2, TruncatedEntries: 3 };
}
async function adviceServer(inspect?: (payload: any) => any) {
  return server((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      res.end(JSON.stringify(inspect ? inspect(payload) : response(payload)));
    });
  });
}

describe('LogJev ergonomic CLI', () => {
  it('keeps legacy --input output and original data intact without configuration', async () => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'input.json', input);
    const legacy = await runCli(helper, ['select', '--input', file]);
    expect(legacy).toMatchObject({ code: 0, result: { status: 'fallback', reason: 'not_configured', original: input, requestCount: 0 } });
    const logs = { task: 'Save', entries: [{ id: 'existing', severity: 'Error', message: 'Original stack\ntext' }] };
    const logFile = jsonFile(directory, 'logs.json', logs);
    const logResult = await runCli(helper, ['logs', '--input', logFile]);
    expect(logResult.result.original).toEqual(logs);
    expect(logResult.result).not.toHaveProperty('source');
  });
  it('accepts tools --task/--domain and returns only the exact local schema, with $defs untouched', async () => {
    const { helper, catalog } = cliFixture();
    const selected = { name: 'scene-read', domain: 'authoring', enabled: true,
      inputSchema: { type: 'object', properties: { value: { $ref: '#/$defs/Ref' } }, $defs: { Ref: { type: 'string' } } } };
    jsonFile(catalog, 'tool-index.json', [selected, { name: 'console-read', domain: 'diagnostics', enabled: true }]);
    jsonFile(catalog, 'tools.json', [{ name: 'scene-read-extra', inputSchema: { wrong: true } }, selected]);
    const requests: any[] = [];
    const endpoint = await adviceServer(payload => { requests.push(payload); return response(payload); });
    const { result, code } = await runCli(helper, ['tools', '--task', 'Read the scene $(ignored)', '--domain', 'authoring', '--compact'], endpoint);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'suggested', selected: 'scene-read', schemaStatus: 'available', schema: selected, requestCount: 1 });
    expect(result).not.toHaveProperty('original');
    expect(result).not.toHaveProperty('arguments');
    expect(requests[0].state.task).toBe('Read the scene $(ignored)');
    expect(JSON.stringify(requests)).not.toContain('console-read');
  });
  it.each(['missing', 'ambiguous', 'unavailable'])('reports %s schema explicitly without inventing arguments', async variant => {
    const { helper, catalog } = cliFixture();
    const tool = { name: 'scene-read', domain: 'authoring', enabled: true };
    jsonFile(catalog, 'tool-index.json', [tool]);
    if (variant !== 'unavailable') jsonFile(catalog, 'tools.json', variant === 'ambiguous' ? [tool, tool] : [{ name: 'scene-read-extra' }]);
    const { result } = await runCli(helper, ['tools', '--task', 'Read scene'], await adviceServer());
    expect(result).toMatchObject({ status: 'suggested', schemaStatus: variant });
    expect(result).not.toHaveProperty('schema');
    expect(result).not.toHaveProperty('arguments');
  });
  it('never attaches a schema or makes network requests when tools is unconfigured', async () => {
    const { helper } = cliFixture();
    const { result } = await runCli(helper, ['tools', '--task', 'Read scene']);
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_configured', requestCount: 0 });
    expect(result).not.toHaveProperty('schemaStatus');
  });
  it('retains original tools input on compact CLI fallback', async () => {
    const { helper } = cliFixture();
    const { result } = await runCli(helper, ['tools', '--task', 'Read scene', '--domain', 'authoring', '--compact']);
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_configured', requestCount: 0,
      original: { task: 'Read scene', domain: 'authoring' } });
  });
  it('retains original vision input on compact CLI fallback', async () => {
    const { helper } = cliFixture();
    const endpoint = await adviceServer(payload => response(payload, 'none'));
    const { result } = await runCli(helper, ['vision', '--image', png(), '--check', 'Is PLAY visible?', '--compact'], endpoint);
    expect(result).toMatchObject({ status: 'fallback', reason: 'inconclusive_judgments',
      original: { questions: { q1: { instructions: 'Is PLAY visible?' } } },
      judgments: { q1: { selected: null, reason: 'no_match' } } });
    expect(result.questions).toEqual(result.original.questions);
    expect(Object.keys(result.original.questions.q1.criteria)).toEqual(['yes', 'no']);
  });
  it('reports a matching catalog entry without inputSchema as missing', async () => {
    const { helper, catalog } = cliFixture();
    const tool = { name: 'scene-read', domain: 'authoring', enabled: true };
    jsonFile(catalog, 'tool-index.json', [tool]);
    jsonFile(catalog, 'tools.json', [tool]);
    const { result } = await runCli(helper, ['tools', '--task', 'Read scene'], await adviceServer());
    expect(result).toMatchObject({ status: 'suggested', schemaStatus: 'missing' });
    expect(result).not.toHaveProperty('schema');
  });
  it('maps repeated --check questions to q1/q2 and retains text with yes/no/none decisions', async () => {
    const { helper } = cliFixture();
    const requests: any[] = [];
    const endpoint = await adviceServer(payload => { requests.push(payload); return response(payload, 'c1'); });
    const { result } = await runCli(helper, ['vision', '--image', png(), '--check', 'Is PLAY visible?', '--check', 'Is ERROR visible?', '--compact'], endpoint);
    expect(result).toMatchObject({ status: 'suggested', questions: {
      q1: { instructions: 'Is PLAY visible?' }, q2: { instructions: 'Is ERROR visible?' },
    }, judgments: { q1: { selected: 'no' }, q2: { selected: 'no' } } });
    expect(Object.keys(requests[0].questions.q1.criteria)).toEqual(['c0', 'c1', 'none']);
    expect(result).not.toHaveProperty('original');
    expect(JSON.stringify(result)).not.toContain('base64');
  });
  it('still supports custom vision criteria via --input and maps shortcut none to fallback', async () => {
    const { helper, directory } = cliFixture();
    const custom = { questions: { location: { instructions: 'Where is PLAY?', criteria: { above: 'Above title', below: 'Below title' } } } };
    const file = jsonFile(directory, 'vision.json', custom);
    const legacy = await runCli(helper, ['vision', '--input', file, '--image', png()], await adviceServer());
    expect(legacy.result.original).toEqual(custom);
    expect(legacy.result.judgments.location.selected).toBe('above');
    const fallback = await runCli(helper, ['vision', '--image', png(), '--check', 'Visible?', '--compact'],
      await adviceServer(payload => response(payload, 'none')));
    expect(fallback.result).toMatchObject({ status: 'fallback', questions: { q1: { instructions: 'Visible?' } },
      judgments: { q1: { selected: null, reason: 'no_match' } } });
  });
  it.each([
    ['tools', '--task', 'x', '--input', 'unused.json'], ['tools', '--task', 'x', '--source', 'unused.json'],
    ['tools', '--task', 'x', '--limit', '2'], ['tools', '--task', 'x', '--task', 'y'],
    ['select', '--input', 'unused.json', '--compact', '--compact'], ['select', '--input', 'unused.json', '--domain', 'x'],
    ['logs', '--source', 'unused.json'], ['logs', '--source', 'unused.json', '--task', 'x', '--domain', 'x'],
    ['logs', '--source', 'unused.json', '--task', 'x', '--limit', '2'],
    ['logs', '--source', 'unused.json', '--task', 'x', '--compact', '--limit', '0'],
    ['logs', '--source', 'unused.json', '--task', 'x', '--compact', '--long-triage', '--limit', '41'],
    ['logs', '--source', 'unused.json', '--task', 'x', '--compact', '--deterministic'],
    ['vision', '--image', 'unused.png', '--check', 'x', '--task', 'x'],
    ['vision', '--input', 'unused.json', '--image', 'unused.png', '--check', 'x'],
    ['vision', '--image', 'unused.png', ...Array.from({ length: 9 }, () => ['--check', 'x']).flat()],
  ])('rejects invalid or meaningless argument combinations: %j', async (...args) => {
    const { helper } = cliFixture();
    const { code, result } = await runCli(helper, args);
    expect(code).toBe(2);
    expect(result.status).toBe('error');
    expect(result.reason).not.toBe('invalid_input_file');
  });
});

describe('LogJev file-backed select compact', () => {
  const candidatesInput = () => ({ task: 'Choose a supported candidate', candidates: Array.from({ length: 40 }, (_, index) => ({
    id: `candidate-${index}`, description: `原始候选 ${index}\r\n${'Long evidence '.repeat(160)}`,
    evidence: { path: `Root/Panel-${index}/Confirm`, enabled: index % 2 === 0, values: [null, 0, '未改写'] },
  })) });
  it('returns only the selected original candidate and a recoverable original-byte file pointer', async () => {
    const { directory, helper } = cliFixture();
    const original = candidatesInput();
    const file = jsonFile(directory, 'candidates.json', original);
    const bytes = fs.readFileSync(file);
    const inspect = vi.fn((payload: any) => response(payload, 'c17'));
    const { code, result } = await runCli(helper, ['select', '--input', file, '--compact'], await adviceServer(inspect));
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'suggested', advisoryOnly: true, selected: 'candidate-17', task: original.task,
      candidate: original.candidates[17], sourceIndex: 17, displayedCount: 1, omittedCount: 39, requestCount: 1,
      provider: 'deepseek', models: ['fixture'], usage: { input_tokens: 10, output_tokens: 1, reads: 1 },
      source: { path: path.resolve(file), sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length, candidatesPath: 'candidates', candidateCount: 40 } });
    expect(result.candidate).toEqual(original.candidates[17]);
    expect(result).not.toHaveProperty('original');
    expect(result).not.toHaveProperty('candidates');
    expect(result.ranking).toHaveLength(3);
    const serialized = JSON.stringify(result);
    for (const [index, candidate] of original.candidates.entries()) {
      if (index !== 17) expect(serialized).not.toContain(JSON.stringify(candidate.description));
    }
    expect(serialized.split(JSON.stringify(original.candidates[17].description))).toHaveLength(2);
    expect(serialized.length).toBeLessThan(JSON.stringify(original).length / 10);
    const recovered = JSON.parse(fs.readFileSync(result.source.path, 'utf8'));
    expect(recovered[result.source.candidatesPath]).toHaveLength(result.source.candidateCount);
    expect(recovered.candidates[result.sourceIndex]).toEqual(result.candidate);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('keeps successful non-compact CLI output and the advise original reference unchanged', async () => {
    const { directory, helper } = cliFixture();
    const original = candidatesInput();
    const file = jsonFile(directory, 'candidates.json', original);
    const { result } = await runCli(helper, ['select', '--input', file], await adviceServer());
    expect(result).toMatchObject({ status: 'suggested', original, requestCount: 1 });
    expect(result).not.toHaveProperty('candidate');
    expect(result).not.toHaveProperty('source');
    const transport = vi.fn(async (_config, payload) => response(payload));
    const api = await advise('select', original, { env, transport });
    expect(api.original).toBe(original);
    expect(api.original.candidates).toBe(original.candidates);
    expect(api).not.toHaveProperty('candidate');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['not_configured', 'no_match', 'uncertain', 'invalid_response', 'http_502'])('retains the complete input on %s fallback', async reason => {
    const { directory, helper } = cliFixture();
    const original = candidatesInput();
    const file = jsonFile(directory, 'candidates.json', original);
    const inspect = vi.fn((payload: any) => {
      if (reason === 'invalid_response') return {};
      const reply = response(payload, reason === 'no_match' ? 'none' : 'c0');
      if (reason === 'uncertain') reply.answers.pick = { type: 'choice', choice: 'c0', confidence: 0.7,
        probabilities: Object.fromEntries(Object.keys(payload.questions.pick.criteria).map(key => [key, key === 'c0' ? 0.7 : 0.3 / 40])) };
      return reply;
    });
    const endpoint = reason === 'not_configured' ? '' : reason === 'http_502'
      ? await server((_req, res) => { res.writeHead(502); res.end('upstream-secret'); }) : await adviceServer(inspect);
    const { code, result } = await runCli(helper, ['select', '--input', file, '--compact'], endpoint);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'fallback', reason, original,
      displayedCount: 40, omittedCount: 0, source: { path: file, candidateCount: 40 } });
    expect(result).not.toHaveProperty('candidate');
    expect(result.requestCount).toBe(reason === 'not_configured' ? 0 : 1);
    expect(JSON.stringify(result)).not.toContain('upstream-secret');
  });
  it.each(['missing', 'json', 'utf8', 'candidates'])('returns safe recovery for %s input errors without contacting the service', async variant => {
    const { directory, helper } = cliFixture();
    const file = path.join(directory, 'candidates.json');
    const invalid = { task: 'Choose', candidates: [] };
    if (variant === 'json') fs.writeFileSync(file, '{', 'utf8');
    if (variant === 'utf8') fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    if (variant === 'candidates') jsonFile(directory, 'candidates.json', invalid);
    const inspect = vi.fn((payload: any) => response(payload));
    const { code, result } = await runCli(helper, ['select', '--input', file, '--compact'], await adviceServer(inspect));
    expect(code).toBe(2);
    expect(result).toMatchObject({ status: 'error', inputPath: path.resolve(file) });
    expect(result).not.toHaveProperty('candidate');
    if (variant === 'candidates') expect(result).toMatchObject({ original: invalid, source: { path: file } });
    expect(inspect).not.toHaveBeenCalled();
  });
  it('supports per-job compact and preserves file recovery for successful, fallback, and invalid batch peers', async () => {
    const directory = temporary();
    const original = candidatesInput();
    jsonFile(directory, 'good.json', original);
    jsonFile(directory, 'none.json', { ...original, task: 'No supported target' });
    const manifest = { jobs: [
      { id: 'good', args: ['select', '--input', 'good.json', '--compact'] },
      { id: 'none', args: ['select', '--input', 'none.json', '--compact'] },
      { id: 'missing', args: ['select', '--input', 'missing.json', '--compact'] },
      { id: 'legacy', args: ['select', '--input', 'good.json'] },
    ] };
    const transport = vi.fn(async (_config, payload) => response(payload, payload.state.task === 'No supported target' ? 'none' : 'c0'));
    const result = await runBatch(manifest, { env, baseDir: directory, transport });
    expect(result).toMatchObject({ status: 'fallback', reason: 'incomplete_jobs', bridgeRequestsDispatched: 3, original: manifest });
    expect(result.jobs[0]).toMatchObject({ status: 'suggested', candidate: original.candidates[0],
      source: { path: path.join(directory, 'good.json'), candidateCount: 40 } });
    expect(result.jobs[0]).not.toHaveProperty('original');
    expect(result.jobs[1]).toMatchObject({ status: 'fallback', original: { ...original, task: 'No supported target' },
      source: { path: path.join(directory, 'none.json') }, omittedCount: 0 });
    expect(result.jobs[2]).toMatchObject({ status: 'error', inputPaths: [path.join(directory, 'missing.json')] });
    expect(result.jobs[3]).toMatchObject({ status: 'suggested', original });
    expect(result.jobs[3]).not.toHaveProperty('candidate');
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('refuses to hide candidates without a recovery pointer or a unique selected original', async () => {
    const original = candidatesInput();
    const result = await advise('select', original, { env, transport: async (_config, payload) => response(payload) });
    expect(() => compactResult(result)).toThrow('compact_source_required');
    const source = { path: path.resolve('candidates.json'), sha256: 'a'.repeat(64), candidatesPath: 'candidates', candidateCount: 40 };
    expect(() => compactResult({ ...result, selected: 'not-a-candidate' }, { source })).toThrow('compact_selection_mismatch');
    const view = compactResult(result, { source });
    expect(view.candidate).toBe(original.candidates[0]);
    expect(result.original).toBe(original);
  });
});

describe('LogJev explicit Console source files', () => {
  it.each(['root', 'structured', 'structuredContent', 'camel'])('reads the exact %s envelope and hashes its raw UTF-8 bytes', async envelope => {
    const { directory, helper } = cliFixture();
    const dto = consoleDto();
    dto.Entries[0].Source = 'C:/not-a-file/never-read';
    const value = envelope === 'root' ? dto : envelope === 'camel'
      ? { entries: [{ logType: 'Warning', message: '中文', source: 'plugin' }], droppedEntries: 0, truncatedEntries: 1 }
      : { status: 'success', [envelope]: { result: dto }, transportStatus: 'forwarded' };
    const file = jsonFile(directory, 'source.json', value);
    const originalBytes = fs.readFileSync(file);
    const { result, code } = await runCli(helper, ['logs', '--source', file, '--task', 'Investigate', '--compact']);
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'fallback', reason: 'not_configured', requestCount: 0,
      original: { entries: [{ id: 'log-0', sourceIndex: 0 }] }, omittedCount: 0,
      source: { path: file, sha256: createHash('sha256').update(originalBytes).digest('hex'), byteLength: originalBytes.length, entryCount: 1 } });
    expect(result.source.entriesPath).toBe(envelope === 'root' ? 'Entries' : envelope === 'camel' ? 'entries' : `${envelope}.result.Entries`);
    if (envelope !== 'camel') expect(result.original.entries[0]).toMatchObject({ message: '日志 0', severity: 'Log',
      source: 'C:/not-a-file/never-read', stackTrace: 'line 1\nline 2', correlationId: 'correlation', operationId: 'operation' });
    expect(fs.readFileSync(file)).toEqual(originalBytes);
  });
  it.each([
    { status: 'error', structured: { result: consoleDto() } },
    { ok: false, Entries: [] }, { IsError: true, Entries: [] }, { Error: { Code: 'failed' }, Entries: [] },
    { structured: { Status: 'failed', result: consoleDto() } },
    { structured: { result: { ...consoleDto(), error: 'failed' } } },
    { Entries: [], entries: [] }, { Entries: [], structured: { result: consoleDto() } },
    { structured: { result: consoleDto() }, structuredContent: { result: consoleDto() } },
    { data: { Entries: [] } }, { logs: [] }, { Entries: [], DroppedEntries: -1 },
    { Entries: [], TruncatedEntries: 0.5 }, { Entries: [], DroppedEntries: 1, droppedEntries: 1 },
    { Entries: [{ LogType: 'Error', Message: 'x', message: 'y' }] },
    { Entries: [{ LogType: 'Error', Message: { arbitrary: 'nested' } }] },
  ])('rejects ambiguous, failed, or malformed Console source: %j', async value => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'source.json', value);
    const { code, result } = await runCli(helper, ['logs', '--source', file, '--task', 'Investigate']);
    expect(code).toBe(2);
    expect(result.status).toBe('error');
    expect(result.reason).toMatch(/^source_/);
  });
  it.each(['utf8', 'json', 'oversized', 'directory'])('rejects invalid %s source files before network access', async variant => {
    const { directory, helper } = cliFixture();
    const file = path.join(directory, 'source.json');
    if (variant === 'directory') fs.mkdirSync(file);
    else fs.writeFileSync(file, variant === 'utf8' ? Buffer.from([0xc3, 0x28]) : variant === 'json' ? '{' : 'x'.repeat(1024 * 1024 + 1));
    let calls = 0;
    const endpoint = await adviceServer(payload => { calls++; return response(payload); });
    const { code, result } = await runCli(helper, ['logs', '--source', file, '--task', 'Investigate'], endpoint);
    expect(code).toBe(2);
    expect(result.status).toBe('error');
    expect(result.inputPath).toBe(file);
    expect(calls).toBe(0);
  });
  it('retains an empty source on bounded fallback without network requests', async () => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'source.json', { status: 'success', structured: { result: consoleDto(0) } });
    let calls = 0;
    const endpoint = await adviceServer(payload => { calls++; return response(payload); });
    const { result } = await runCli(helper, ['logs', '--source', file, '--task', 'Investigate', '--compact', '--limit', '1'], endpoint);
    expect(result).toMatchObject({ status: 'fallback', reason: 'source_empty', requestCount: 0,
      source: { droppedEntries: 2, truncatedEntries: 3 }, displayedCount: 0, omittedCount: 0 });
    expect(result.original.entries).toHaveLength(0);
    expect(calls).toBe(0);
  });
  it('keeps the existing over-30 fallback unless long triage is explicitly enabled', async () => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'source.json', consoleDto(31));
    const endpoint = await adviceServer(() => { throw new Error('unexpected model request'); });
    const { result } = await runCli(helper, ['logs', '--source', file, '--task', 'Investigate', '--compact'], endpoint);
    expect(result).toMatchObject({ status: 'fallback', reason: 'source_entry_limit', requestCount: 0,
      displayedCount: 31, omittedCount: 0 });
    expect(result.original.entries).toHaveLength(31);
  });
  it('uses one choice for 2000 source logs and shares a zero-model evidence pool with D', async () => {
    const directory = temporary();
    const dto = consoleDto(2000);
    dto.Entries[100].LogType = 'Error';
    dto.Entries[100].Message = 'Unrelated audio preview failure';
    dto.Entries[500].LogType = 'Warning';
    dto.Entries[500].Message = 'Unrelated asset warning';
    dto.Entries[1777].Message = 'DockScene save refused because the lease expired';
    const file = jsonFile(directory, 'source.json', { status: 'success', structured: { result: dto } });
    const sourceHash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const common = ['logs', '--source', 'source.json', '--task', 'Why did DockScene save fail?', '--compact', '--long-triage', '--limit', '40'];
    const dTransport = vi.fn();
    const d = await runBatch({ jobs: [{ id: 'D', args: [...common, '--deterministic'] }] },
      { baseDir: directory, env: {}, transport: dTransport });
    expect(dTransport).not.toHaveBeenCalled();
    expect(d.jobs[0]).toMatchObject({ status: 'deterministic', requestCount: 0,
      source: { sha256: sourceHash, entryCount: 2000, droppedEntries: 2, truncatedEntries: 3 },
      candidateCount: 40, displayedCount: 40, omittedCount: 1960 });
    expect(d.jobs[0].entries.map((entry: any) => entry.sourceIndex)).toEqual(expect.arrayContaining([100, 500, 1777]));
    const jTransport = vi.fn(async (_config, payload) => {
      expect(Object.keys(payload.questions)).toEqual(['pick']);
      const descriptions = Object.values(payload.questions.pick.criteria);
      const chosen = descriptions.findIndex((description: any) => description.includes('lease expired'));
      expect(chosen).toBeGreaterThanOrEqual(0);
      return response(payload, `c${chosen}`);
    });
    const j = await runBatch({ jobs: [{ id: 'J', args: common }] },
      { baseDir: directory, env, transport: jTransport });
    expect(jTransport).toHaveBeenCalledTimes(1);
    expect(j).toMatchObject({ bridgeRequestsDispatched: 1, logicalQuestionCount: 1 });
    expect(j.jobs[0]).toMatchObject({ status: 'suggested', selected: 'log-1777', selectedIndex: 1777,
      candidateSourceIndices: d.jobs[0].candidateSourceIndices, source: { sha256: sourceHash },
      displayedCount: 3, omittedCount: 1997, requestCount: 1 });
    expect(j.jobs[0].entries.map((entry: any) => entry.sourceIndex)).toEqual([100, 500, 1777]);
    expect(j.jobs[0]).not.toHaveProperty('original');
    const unconfiguredTransport = vi.fn();
    const unconfigured = await runBatch({ jobs: [{ id: 'J', args: common }] },
      { baseDir: directory, env: {}, transport: unconfiguredTransport });
    expect(unconfiguredTransport).not.toHaveBeenCalled();
    expect(unconfigured.jobs[0]).toMatchObject({ status: 'fallback', reason: 'not_configured',
      requestCount: 0, source: { sha256: sourceHash }, original: { entries: expect.any(Array) } });
    expect(unconfigured.jobs[0].original.entries).toHaveLength(2000);
  });
  it('recovers the whole long source on invalid model output, with no partial choice', async () => {
    const directory = temporary();
    const file = jsonFile(directory, 'source.json', consoleDto(120));
    const result = await runBatch({ jobs: [{ id: 'J', args: ['logs', '--source', 'source.json', '--task', 'Investigate', '--compact', '--long-triage'] }] },
      { baseDir: directory, env, transport: async () => ({ answers: {} }) });
    expect(result.jobs[0]).toMatchObject({ status: 'fallback', reason: 'invalid_response',
      source: { path: file, entryCount: 120 }, displayedCount: 8, omittedCount: 112,
      original: { entries: expect.any(Array) } });
    expect(result.jobs[0].original.entries).toHaveLength(120);
    expect(result.jobs[0]).not.toHaveProperty('selected');
  });
  it('marks unknown loss counts explicitly, never as zero', () => {
    const file = jsonFile(temporary(), 'source.json', { Entries: [] });
    expect(readLogSource(file, 'Investigate').source).toMatchObject({ droppedEntries: null, truncatedEntries: null });
  });
  it('compacts sorted source logs while preserving error/warning evidence and relevance above 0.1 verbatim', async () => {
    const { directory, helper } = cliFixture();
    const dto = consoleDto(7);
    ['Log', 'Log', 'Warning', 'Error', 'Exception', 'Assert', 'Fatal'].forEach((severity, i) => { dto.Entries[i].LogType = severity; });
    const file = jsonFile(directory, 'source.json', { structured: { result: dto } });
    const requests: any[] = [];
    const endpoint = await adviceServer(payload => {
      requests.push(payload);
      return { answers: { relevant: { type: 'noul', noul: payload.state.entry.sourceIndex === 1 ? 0.11 : 0.1 } } };
    });
    const { result } = await runCli(helper, ['logs', '--source', file, '--task', 'Save', '--compact', '--limit', '1'], endpoint);
    expect(result).toMatchObject({ status: 'suggested', retainedCount: 7, displayedCount: 6, omittedCount: 1 });
    expect(result.entries.map((entry: any) => entry.sourceIndex)).toEqual([3, 4, 5, 6, 1, 2]);
    expect(result.entries[0]).toMatchObject({ message: '日志 3', stackTrace: 'line 1\nline 2', correlationId: 'correlation', operationId: 'operation' });
    expect(result).not.toHaveProperty('original');
    expect(requests).toHaveLength(7);
    expect(requests[0].state.entry).toMatchObject({ correlationId: 'correlation', operationId: 'operation', stackTrace: 'line 1\nline 2' });
  });
  it('defaults to eight preview entries and supports rereading compact legacy --input files', async () => {
    const { directory, helper } = cliFixture();
    const logs = { task: 'Save', entries: Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, severity: 'Info', message: `original ${i}` })) };
    const file = jsonFile(directory, 'logs.json', logs);
    const endpoint = await adviceServer(() => ({ answers: { relevant: { type: 'noul', noul: 0.1 } } }));
    const { result } = await runCli(helper, ['logs', '--input', file, '--compact'], endpoint);
    expect(result).toMatchObject({ displayedCount: 8, omittedCount: 2, source: { path: file, entriesPath: 'entries' } });
    expect(result.entries).toEqual(logs.entries.slice(0, 8));
    expect(result.source.sha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  });
  it('retains unknown/missing severities and unscored entries in compact previews', () => {
    const entries = [{ id: 'first', severity: 'Log' }, { id: 'unknown', severity: 'custom' }, { id: 'missing' },
      { id: 'unscored', severity: 'Log' }, { id: 'boundary', severity: 'Log' }];
    const result = compactResult({ mode: 'logs', status: 'suggested', original: { task: 'x', entries },
      ranking: entries.map((entry, index) => ({ id: entry.id, index, relevance: index === 3 ? undefined : 0.1 })) },
    { source: { path: '/explicit/source.json', sha256: 'hash' }, limit: 1 });
    expect(result.entries.map((entry: any) => entry.id)).toEqual(['first', 'unknown', 'missing', 'unscored']);
    expect(result.omittedCount).toBe(1);
  });
  it('keeps every original log on service fallback even with --compact', async () => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'source.json', consoleDto(12));
    const endpoint = await server((_req, res) => { res.writeHead(502); res.end('upstream secret'); });
    const { result } = await runCli(helper, ['logs', '--source', file, '--task', 'Save', '--compact', '--limit', '1'], endpoint);
    expect(result).toMatchObject({ status: 'fallback', displayedCount: 12, omittedCount: 0 });
    expect(result.original.entries).toHaveLength(12);
    expect(result).not.toHaveProperty('ranking');
    expect(JSON.stringify(result)).not.toContain('upstream secret');
  });
});

describe('LogJev independent-job batches', () => {
  function logJob(directory: string, id: string, count = 3) {
    const file = jsonFile(directory, `${id}.json`, { task: id,
      entries: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, severity: 'Info', message: `Original ${id} ${index}` })) });
    return { id, args: ['logs', '--input', path.basename(file)] };
  }
  it('shares one global HTTP limit across jobs and logs internal concurrency, preserving order', async () => {
    const directory = temporary();
    const manifest = { jobs: ['slow', 'fast', 'middle'].map(id => logJob(directory, id)) };
    let running = 0;
    let peak = 0;
    const transport = vi.fn(async (_config, payload) => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, payload.state.task === 'slow' ? 12 : 2));
      running--;
      return response(payload);
    });
    const result = await runBatch(manifest, { env, baseDir: directory, concurrency: 2, transport });
    expect(result).toMatchObject({ status: 'suggested', hostInvocation: 1, concurrency: 2,
      bridgeRequestsDispatched: 9, logicalQuestionCount: 9, peakInFlight: 2, adviceRequestAttempts: 9,
      usage: { input_tokens: 90, output_tokens: 9, reads: 9 } });
    expect(peak).toBe(2);
    expect(result.jobs.map((job: any) => job.id)).toEqual(['slow', 'fast', 'middle']);
    expect(result.jobs.every((job: any) => job.dispatch.bridgeRequestsDispatched === 3)).toBe(true);
    expect(result.original).toBe(manifest);
  });
  it('expires queued requests without dispatch and exits even if a transport callback never settles', async () => {
    const directory = temporary();
    const manifest = { jobs: ['a', 'b', 'c'].map(id => logJob(directory, id, 4)) };
    const transport = vi.fn(() => new Promise(() => {}));
    const result = await runBatch(manifest, { env: { ...env, UCO_LOGJEV_TIMEOUT_MS: '100' },
      baseDir: directory, concurrency: 1, transport });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'fallback', bridgeRequestsDispatched: 1, logicalQuestionCount: 1,
      peakInFlight: 1 });
    expect(result.queuedExpiredCount).toBeGreaterThan(0);
    expect(result.adviceRequestAttempts).toBeGreaterThan(result.bridgeRequestsDispatched);
    expect(result.jobs.every((job: any) => job.status === 'fallback' && job.original.entries.length === 4)).toBe(true);
    expect(result.wallMs).toBeLessThan(1000);
  });
  it('does not dispatch when the shared deadline already expired before execution', async () => {
    const directory = temporary();
    const manifest = { jobs: [logJob(directory, 'a', 1)] };
    const transport = vi.fn();
    const result = await runBatch(manifest, { env: { ...env, UCO_LOGJEV_TIMEOUT_MS: '100' }, baseDir: directory,
      startedAt: performance.now() - 150, transport });
    expect(result).toMatchObject({ status: 'fallback', bridgeRequestsDispatched: 0, logicalQuestionCount: 0 });
    expect(transport).not.toHaveBeenCalled();
    expect(result.jobs[0].original.entries).toHaveLength(1);
  });
  it('isolates invalid files and service failures while retaining a successful peer and input order', async () => {
    const directory = temporary();
    const manifest = { jobs: [logJob(directory, 'success', 1), { id: 'missing', args: ['select', '--input', 'missing.json'] },
      logJob(directory, 'service-failure', 1)] };
    const result = await runBatch(manifest, { env, baseDir: directory, transport: async (_config, payload) => {
      if (payload.state.task === 'service-failure') throw new Error('upstream-secret');
      return response(payload);
    } });
    expect(result.jobs.map((job: any) => [job.id, job.status])).toEqual([
      ['success', 'suggested'], ['missing', 'error'], ['service-failure', 'fallback'],
    ]);
    expect(result.jobs[1]).toMatchObject({ originalJob: manifest.jobs[1], inputPaths: [path.join(directory, 'missing.json')] });
    expect(result.jobs[2].original.entries[0].message).toBe('Original service-failure 0');
    expect(JSON.stringify(result)).not.toContain('upstream-secret');
  });
  it.each([
    null, { jobs: [] }, { jobs: Array.from({ length: 9 }, (_, i) => ({ id: `x${i}`, args: ['tools', '--task', 'x'] })) },
    { jobs: [{ id: 'same', args: ['tools', '--task', 'x'] }, { id: 'same', args: ['tools', '--task', 'y'] }] },
    { jobs: [{ id: 'nested', args: ['batch', '--input', 'other.json'] }] },
    { jobs: [{ id: 'bad', args: ['tools', '--task', 42] }] },
    { jobs: [{ id: 'one', args: ['tools', '--task', 'x'] }, { id: 'bad', args: ['tools', '--shell', 'bad'] }] },
  ])('rejects malformed manifests before any HTTP request: %j', async manifest => {
    const transport = vi.fn();
    await expect(runBatch(manifest, { env, transport })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it('retains parsed but invalid job input on error, including compact batches', async () => {
    const directory = temporary();
    const invalid = { task: 'x', candidates: [] };
    jsonFile(directory, 'bad.json', invalid);
    const result = await runBatch({ jobs: [{ id: 'invalid', args: ['select', '--input', 'bad.json'] }] },
      { env, baseDir: directory, compact: true, transport: vi.fn() });
    expect(result.jobs[0]).toMatchObject({ status: 'error', reason: 'candidate_limit', original: invalid,
      source: { path: path.join(directory, 'bad.json') } });
    expect(result.original.jobs).toHaveLength(1);
  });
  it.each([{}, { ...env, UCO_LOGJEV_URL: 'http://remote.invalid' }])('has zero network with missing/invalid configuration and preserves original evidence', async batchEnv => {
    const directory = temporary();
    const manifest = { jobs: [logJob(directory, 'logs', 2), { id: 'tools', args: ['tools', '--task', 'Inspect'] }] };
    const transport = vi.fn();
    const result = await runBatch(manifest, { env: batchEnv, baseDir: directory, compact: true, transport });
    expect(result).toMatchObject({ status: 'fallback', hostInvocation: 1, bridgeRequestsDispatched: 0,
      logicalQuestionCount: 0, peakInFlight: 0, original: manifest });
    expect(result.jobs[0].original.entries).toHaveLength(2);
    expect(result.jobs[1].original).toEqual({ task: 'Inspect' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('resolves input/source/image relative to the manifest and returns one CLI JSON with exact schemas', async () => {
    const { directory, helper, catalog } = cliFixture();
    const manifestDirectory = path.join(directory, 'nested');
    fs.mkdirSync(manifestDirectory);
    fs.copyFileSync(png(), path.join(manifestDirectory, 'shot.png'));
    jsonFile(manifestDirectory, 'select.json', input);
    jsonFile(manifestDirectory, 'console.json', consoleDto(1));
    const tool = { name: 'scene-read', domain: 'authoring', enabled: true, inputSchema: { type: 'object', properties: {} } };
    jsonFile(catalog, 'tool-index.json', [tool]);
    jsonFile(catalog, 'tools.json', [tool]);
    const manifest = { jobs: [
      { id: 'select', args: ['select', '--input', 'select.json'] },
      { id: 'image', args: ['vision', '--image', 'shot.png', '--check', 'Is PLAY visible?', '--check', 'Is ERROR visible?'] },
      { id: 'logs', args: ['logs', '--source', 'console.json', '--task', 'Investigate'] },
      { id: 'tool', args: ['tools', '--task', 'Read scene'] },
    ] };
    const file = jsonFile(manifestDirectory, 'batch.json', manifest);
    const { code, result } = await runCli(helper, ['batch', '--input', file, '--compact', '--concurrency', '2'], await adviceServer());
    expect(code).toBe(0);
    expect(result).toMatchObject({ status: 'suggested', hostInvocation: 1, bridgeRequestsDispatched: 4,
      logicalQuestionCount: 5, source: { path: file } });
    expect(result.source.sha256).toBe(createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    expect(result.jobs.map((job: any) => job.id)).toEqual(['select', 'image', 'logs', 'tool']);
    expect(result.jobs[0]).toMatchObject({ candidate: input.candidates[0],
      source: { path: path.join(manifestDirectory, 'select.json'), candidateCount: 1, candidatesPath: 'candidates' } });
    expect(result.jobs[0]).not.toHaveProperty('original');
    expect(result.jobs[1].questions.q2.instructions).toBe('Is ERROR visible?');
    expect(result.jobs[1]).not.toHaveProperty('original');
    expect(result.jobs[2].source.path).toBe(path.join(manifestDirectory, 'console.json'));
    expect(result.jobs[3].schema).toEqual(tool);
    expect(result).not.toHaveProperty('original');
    expect(JSON.stringify(result)).not.toContain('base64');
  });
  it('keeps both vision questions and all source logs on compact fallback', async () => {
    const { directory, helper } = cliFixture();
    fs.copyFileSync(png(), path.join(directory, 'shot.png'));
    jsonFile(directory, 'console.json', consoleDto(12));
    const file = jsonFile(directory, 'batch.json', { jobs: [
      { id: 'vision', args: ['vision', '--image', 'shot.png', '--check', 'Is PLAY visible?'] },
      { id: 'logs', args: ['logs', '--source', 'console.json', '--task', 'Investigate'] },
    ] });
    const endpoint = await server((_req, res) => { res.writeHead(502); res.end('upstream-secret'); });
    const { result } = await runCli(helper, ['batch', '--input', file, '--compact'], endpoint);
    expect(result.status).toBe('fallback');
    expect(result.jobs[0].original.questions.q1.instructions).toBe('Is PLAY visible?');
    expect(result.jobs[1].original.entries).toHaveLength(12);
    expect(result.jobs[1]).toMatchObject({ omittedCount: 0, source: { path: path.join(directory, 'console.json') } });
    expect(result.original.jobs).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('upstream-secret');
  });
  it('shares the deadline across both tool routing stages and other jobs', async () => {
    const { directory, helper, catalog } = cliFixture();
    jsonFile(catalog, 'tool-index.json', [{ name: 'scene-read', domain: 'authoring', enabled: true },
      { name: 'console-read', domain: 'diagnostics', enabled: true }]);
    const file = jsonFile(directory, 'batch.json', { jobs: [{ id: 'tool', args: ['tools', '--task', 'Inspect'] }] });
    let calls = 0;
    const endpoint = await server((_req, _res) => { calls++; /* never respond */ });
    const { result } = await runCli(helper, ['batch', '--input', file], endpoint);
    expect(result).toMatchObject({ status: 'fallback', bridgeRequestsDispatched: 1, logicalQuestionCount: 1 });
    expect(calls).toBe(1);
    expect(result.jobs[0].original).toEqual({ task: 'Inspect' });
  });
  it('keeps the shared deadline when tool selection hangs after routing and preserves a successful peer', async () => {
    const { directory, helper, catalog } = cliFixture();
    jsonFile(catalog, 'tool-index.json', [{ name: 'scene-read', domain: 'authoring', enabled: true },
      { name: 'console-read', domain: 'diagnostics', enabled: true }]);
    jsonFile(directory, 'peer.json', input);
    const { runBatch: runInstalledBatch } = await import(pathToFileURL(helper).href);
    const dispatches: Array<{ phase: string; timeoutMs: number }> = [];
    const transport = vi.fn(async (_config, payload, timeoutMs) => {
      const phase = Object.keys(payload.questions)[0];
      dispatches.push({ phase, timeoutMs });
      if (phase === 'route') await new Promise(resolve => setTimeout(resolve, 70));
      if (phase === 'tool') return new Promise(() => {});
      return response(payload);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const pending = runInstalledBatch({ jobs: [
        { id: 'tool', args: ['tools', '--task', 'Inspect'] },
        { id: 'peer', args: ['select', '--input', 'peer.json'] },
      ] }, { env: { ...env, UCO_LOGJEV_TIMEOUT_MS: '100' }, baseDir: directory, concurrency: 2, transport });
      await vi.advanceTimersByTimeAsync(70);
      expect(dispatches).toEqual([
        { phase: 'route', timeoutMs: 100 }, { phase: 'pick', timeoutMs: 100 }, { phase: 'tool', timeoutMs: 30 },
      ]);
      await vi.advanceTimersByTimeAsync(30);
      const result = await pending;
      expect(result).toMatchObject({ status: 'fallback', wallMs: 100, bridgeRequestsDispatched: 3,
        logicalQuestionCount: 3, adviceRequestAttempts: 3 });
      expect(result.jobs.map((job: any) => [job.id, job.status])).toEqual([['tool', 'fallback'], ['peer', 'suggested']]);
      expect(result.jobs[0]).toMatchObject({ reason: 'timeout', original: { task: 'Inspect' }, requestCount: 2 });
      expect(result.jobs[1]).toMatchObject({ selected: 'button', original: input, requestCount: 1 });
      await vi.advanceTimersByTimeAsync(100);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(['0', '5', 'NaN'])('rejects invalid concurrency %s without network', async concurrency => {
    const { directory, helper } = cliFixture();
    const file = jsonFile(directory, 'batch.json', { jobs: [{ id: 'tool', args: ['tools', '--task', 'Inspect'] }] });
    const { code, result } = await runCli(helper, ['batch', '--input', file, '--concurrency', concurrency]);
    expect(code).toBe(2);
    expect(result).toMatchObject({ status: 'error', reason: 'invalid_concurrency', bridgeRequestsDispatched: 0 });
    expect(result.originalArgs).toContain(file);
  });
  it.each(['duplicate', 'nested', 'utf8'])('invalid %s batch CLI input remains recoverable', async variant => {
    const { directory, helper } = cliFixture();
    const jobs = variant === 'nested' ? [{ id: 'nested', args: ['batch', '--input', 'other.json'] }]
      : Array.from({ length: 2 }, () => ({ id: 'same', args: ['tools', '--task', 'Inspect'] }));
    const file = jsonFile(directory, 'batch.json', { jobs });
    if (variant === 'utf8') fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    const { code, result } = await runCli(helper, ['batch', '--input', file]);
    expect(code).toBe(2);
    expect(result).toMatchObject({ status: 'error', mode: 'batch', hostInvocation: 1, bridgeRequestsDispatched: 0 });
    if (variant === 'utf8') expect(result.inputPath).toBe(file);
    else expect(result).toMatchObject({ original: { jobs }, source: { path: file } });
  });
});

describe('LogJev remains a standalone development helper', () => {
  it('does not install the helper or reference in static or live bundles', async () => {
    const projectPath = temporary();
    const skillsRoot = path.join(projectPath, '.agents', 'skills');
    const installed = installStaticSkillBundle({ projectPath, skillsRoot });
    const helper = path.join(installed.supportDestination, 'scripts', 'logjev.mjs');
    expect(fs.existsSync(helper)).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, 'unity-editor', 'references', 'logjev.md'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsRoot, 'unity-editor', 'SKILL.md'), 'utf8')).not.toContain('LogJev');
    expect(installStaticSkillBundle({ projectPath, skillsRoot }).status).toBe('unchanged');
    const live = await setupSkillBundle({ projectPath, skillsPath: '.agents/skills', tools: [{ name: 'scene-read', enabled: true }] });
    expect(fs.existsSync(path.join(live.supportDestination, 'scripts', 'logjev.mjs'))).toBe(false);
    expect(fs.existsSync(path.join(skillsRoot, 'unity-editor', 'references', 'logjev.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(live.supportDestination, 'bundle-manifest.json'), 'utf8')).managedFiles)
      .not.toContain('scripts/logjev.mjs');
  });
  it('does not refresh or remove a previously installed helper', async () => {
    const projectPath = temporary();
    const live = await setupSkillBundle({ projectPath, skillsPath: '.agents/skills', tools: [{ name: 'scene-read', enabled: true }] });
    const manifestPath = path.join(live.supportDestination, 'bundle-manifest.json');
    const helper = path.join(live.supportDestination, 'scripts', 'logjev.mjs');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.managedFiles.push('scripts/logjev.mjs');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(helper, '// previously installed helper');
    const originalCatalog = fs.readFileSync(path.join(live.supportDestination, 'catalog', 'tools.json'), 'utf8');
    const beforeManifest = fs.readFileSync(manifestPath, 'utf8');
    expect(refreshLiveAgentRuntimeScripts({ projectPath, dryRun: true }).status).toBe('unchanged');
    expect(fs.readFileSync(helper, 'utf8')).toBe('// previously installed helper');
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(beforeManifest);
    const updated = refreshLiveAgentRuntimeScripts({ projectPath, force: true });
    expect(updated.written).not.toContain('scripts/logjev.mjs');
    expect(fs.readFileSync(helper, 'utf8')).toBe('// previously installed helper');
    expect(fs.readFileSync(path.join(live.supportDestination, 'catalog', 'tools.json'), 'utf8')).toBe(originalCatalog);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(beforeManifest);
  });
  it('preserves an unowned helper in a live runtime, even with force', async () => {
    const projectPath = temporary();
    const live = await setupSkillBundle({ projectPath, skillsPath: '.agents/skills', tools: [{ name: 'scene-read', enabled: true }] });
    const manifestPath = path.join(live.supportDestination, 'bundle-manifest.json');
    const helper = path.join(live.supportDestination, 'scripts', 'logjev.mjs');
    fs.writeFileSync(helper, '// user helper');
    expect(refreshLiveAgentRuntimeScripts({ projectPath, force: true }).written).not.toContain('scripts/logjev.mjs');
    expect(fs.readFileSync(helper, 'utf8')).toBe('// user helper');
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).managedFiles).not.toContain('scripts/logjev.mjs');
  });
  it('does not adopt a foreign ownership manifest', async () => {
    const projectPath = temporary();
    const live = await setupSkillBundle({ projectPath, skillsPath: '.agents/skills', tools: [{ name: 'scene-read', enabled: true }] });
    const manifestPath = path.join(live.supportDestination, 'bundle-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.bundleId = 'someone-else';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = refreshLiveAgentRuntimeScripts({ projectPath, force: true });
    expect(result.written).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });
  it('preserves files behind a linked scripts directory', async () => {
    const projectPath = temporary();
    const external = temporary();
    const live = await setupSkillBundle({ projectPath, skillsPath: '.agents/skills', tools: [{ name: 'scene-read', enabled: true }] });
    const scripts = path.join(live.supportDestination, 'scripts');
    fs.renameSync(scripts, path.join(live.supportDestination, 'original-scripts'));
    fs.writeFileSync(path.join(external, 'logjev.mjs'), '// external file');
    fs.symlinkSync(external, scripts, 'junction');
    const result = refreshLiveAgentRuntimeScripts({ projectPath, force: true });
    expect(result.written).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(fs.readFileSync(path.join(external, 'logjev.mjs'), 'utf8')).toBe('// external file');
  });
  it('the source CLI can call a bridge and select a real indexed tool', async () => {
    const { directory, helper, catalog } = cliFixture();
    fs.writeFileSync(path.join(catalog, 'tool-index.json'), JSON.stringify([
      { name: 'scene-read', domain: 'authoring', enabled: true, description: 'Read the current scene' },
    ]));
    fs.writeFileSync(path.join(catalog, 'tools.json'), JSON.stringify([{ name: 'scene-read', enabled: true }]));
    const endpoint = await server((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => res.end(JSON.stringify(response(JSON.parse(body)))));
    });
    const inputFile = path.join(directory, 'task.json');
    fs.writeFileSync(inputFile, JSON.stringify({ task: 'Read the scene' }));
    const { stdout } = await promisify(execFile)(process.execPath,
      [helper, 'tools', '--input', inputFile],
      { env: { ...process.env, ...env, UCO_LOGJEV_URL: endpoint }, timeout: 5000 });
    expect(JSON.parse(stdout)).toMatchObject({ status: 'suggested', selected: 'scene-read', requestCount: 1 });
  });
});
