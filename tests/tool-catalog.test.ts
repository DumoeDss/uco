import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalCatalogJson,
  normalizeCatalogResponse,
  normalizeToolCatalog,
} from '../src/catalog.js';
import { RestTransport } from '../src/transport/rest.js';
import { registerList } from '../src/commands/list.js';
import { fetchTools } from '../src/codegen/fetch.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared tool catalog contract', () => {
  it('preserves metadata presence and schema extensions while sorting by UTF-16 code units', () => {
    const normalized = normalizeToolCatalog([
      {
        name: 'ä-tool',
        enabled: false,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: null,
        futureHint: { level: 2 },
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          $defs: { Value: { customKeyword: 'retained' } },
          $ref: '#/$defs/Value',
        },
        outputSchema: {
          type: 'object',
          additionalProperties: { futureOutputKeyword: 'retained' },
          $defs: { Result: { customOutputKeyword: true } },
          $ref: '#/$defs/Result',
        },
      },
      { name: 'Z-tool', enabled: true, openWorldHint: false },
      { name: 'a-tool' },
    ]);

    expect(normalized.map((tool) => tool.name)).toEqual(['Z-tool', 'a-tool', 'ä-tool']);
    expect(normalized[1]).toEqual({ enabled: true, name: 'a-tool' });
    expect(Object.hasOwn(normalized[1]!, 'readOnlyHint')).toBe(false);
    expect(normalized[2]).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
      futureHint: { level: 2 },
      inputSchema: {
        additionalProperties: false,
        $defs: { Value: { customKeyword: 'retained' } },
        $ref: '#/$defs/Value',
      },
      outputSchema: {
        additionalProperties: { futureOutputKeyword: 'retained' },
        $defs: { Result: { customOutputKeyword: true } },
        $ref: '#/$defs/Result',
      },
    });
  });

  it('preserves top-level and nested __proto__ members without prototype pollution', () => {
    const adversarial = JSON.parse(`{
      "name": "prototype-tool",
      "__proto__": { "topLevelMarker": true },
      "inputSchema": {
        "type": "object",
        "__proto__": { "nestedMarker": true },
        "properties": {
          "value": {
            "type": "object",
            "__proto__": { "deepMarker": true }
          }
        }
      }
    }`) as Record<string, unknown>;

    const normalized = normalizeToolCatalog([adversarial]);
    const tool = normalized[0] as Record<string, unknown>;
    const inputSchema = tool['inputSchema'] as Record<string, unknown>;
    const valueSchema = (
      (inputSchema['properties'] as Record<string, unknown>)['value']
    ) as Record<string, unknown>;

    expect(Object.hasOwn(tool, '__proto__')).toBe(true);
    expect(tool['__proto__']).toEqual({ topLevelMarker: true });
    expect(Object.hasOwn(inputSchema, '__proto__')).toBe(true);
    expect(inputSchema['__proto__']).toEqual({ nestedMarker: true });
    expect(Object.hasOwn(valueSchema, '__proto__')).toBe(true);
    expect(valueSchema['__proto__']).toEqual({ deepMarker: true });
    expect(({} as Record<string, unknown>)['topLevelMarker']).toBeUndefined();
    expect(({} as Record<string, unknown>)['nestedMarker']).toBeUndefined();
    expect(({} as Record<string, unknown>)['deepMarker']).toBeUndefined();

    const serialized = canonicalCatalogJson(normalized);
    const reparsed = JSON.parse(serialized) as Array<Record<string, unknown>>;
    expect(Object.hasOwn(reparsed[0]!, '__proto__')).toBe(true);
    expect(Object.hasOwn(reparsed[0]!['inputSchema'] as object, '__proto__')).toBe(true);
  });

  it('accepts array and wrapped legacy responses but rejects duplicates', () => {
    expect(normalizeCatalogResponse({ tools: [{ name: 'legacy-tool', inputSchema: true }] }))
      .toEqual([{ enabled: true, inputSchema: true, name: 'legacy-tool' }]);
    expect(() => normalizeToolCatalog([{ name: 'same' }, { name: 'same' }]))
      .toThrow(/duplicate name.*same/i);
  });

  it('normalizes wrapped responses at the REST transport boundary', async () => {
    const transport = new RestTransport({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => new Response(JSON.stringify({
        tools: [{
          name: 'wrapped-tool',
          enabled: false,
          destructiveHint: false,
          openWorldHint: null,
          newerMember: 'retained',
          inputSchema: { additionalProperties: { customKeyword: true } },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });

    await expect(transport.listTools()).resolves.toEqual([{
      destructiveHint: false,
      enabled: false,
      inputSchema: { additionalProperties: { customKeyword: true } },
      name: 'wrapped-tool',
      newerMember: 'retained',
      openWorldHint: null,
    }]);
  });

  it('normalizes metadata-bearing wrapped responses at the codegen fetch boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fetch-token');
      return new Response(JSON.stringify({
        tools: [
          { name: 'z-tool', enabled: false, destructiveHint: false },
          {
            name: 'a-tool',
            openWorldHint: null,
            futureMember: true,
            inputSchema: { additionalProperties: false },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTools({
      url: 'http://127.0.0.1:23456',
      token: 'fetch-token',
    })).resolves.toEqual([
      {
        enabled: true,
        futureMember: true,
        inputSchema: { additionalProperties: false },
        name: 'a-tool',
        openWorldHint: null,
      },
      { destructiveHint: false, enabled: false, name: 'z-tool' },
    ]);
  });

  it('serializes shuffled catalogs and object keys to one canonical newline-terminated form', () => {
    const first = [
      { name: 'b', enabled: true, inputSchema: { z: 1, a: [{ y: 2, x: 1 }] } },
      { name: 'a', enabled: false },
    ];
    const second = [
      { enabled: false, name: 'a' },
      { inputSchema: { a: [{ x: 1, y: 2 }], z: 1 }, enabled: true, name: 'b' },
    ];

    const expected = canonicalCatalogJson(first);
    expect(canonicalCatalogJson(second)).toBe(expected);
    expect(expected.endsWith('\n')).toBe(true);
    expect(expected.endsWith('\n\n')).toBe(false);
  });
});

describe('uco list JSON metadata', () => {
  it('retains explicit false and null while leaving legacy hints omitted', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer catalog-token');
      return new Response(JSON.stringify([
        {
          name: 'metadata-tool',
          enabled: true,
          title: 'Metadata Tool',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: null,
        },
        { name: 'legacy-tool', enabled: true },
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = new Command()
      .exitOverride()
      .option('--json')
      .option('--url <url>')
      .option('--token <token>');
    registerList(program);

    await program.parseAsync([
      'node', 'uco', '--json', '--url', 'http://127.0.0.1:23456',
      '--token', 'catalog-token', 'list', '--filter', 'tool',
    ]);

    const output = JSON.parse(String(stdout.mock.calls[0]?.[0])) as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({ name: 'legacy-tool' });
    expect(Object.hasOwn(output[0]!, 'readOnlyHint')).toBe(false);
    expect(output[1]).toMatchObject({
      name: 'metadata-tool',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: null,
    });
    expect(Object.hasOwn(output[1]!, 'openWorldHint')).toBe(false);
  });
});
