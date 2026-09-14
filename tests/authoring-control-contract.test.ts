import { describe, expect, it } from 'vitest';
import {
  ToolCallControlError,
  normalizeRestToolCall,
  normalizeToolCall,
  serializeControlledToolBody,
  type ToolCallContext,
} from '../src/tool-call-control.js';
import { toolCallOptionsFromCli } from '../src/util/call-control.js';

describe('g-005 authoring control contract', () => {
  it('keeps legacy bodies and separates transport/logical ids', () => {
    const legacy = normalizeRestToolCall('read-tool', { control: { argument: true } }, {
      generateId: () => 'legacy-generated',
    });
    expect(legacy.context.legacy).toBe(true);
    expect(legacy.request.arguments).toEqual({ control: { argument: true } });

    const controlled = normalizeRestToolCall('authoring-tool', {
      arguments: { target: 'Assets/Thing.prefab' },
      control: {
        version: 1,
        requestID: 'request-is-not-a-control-member',
        callId: 'logical-call',
        correlationId: 'logical-trace',
        confirm: true,
        dryRun: 'plan',
        confirmation: {
          planId: 'plan-1',
          planHash: 'sha256-test',
          expiresAtUnixMs: 2_000,
          futureTokenMember: { retained: true },
        },
        futureControlMember: 7,
      },
    }, { generateId: () => 'unused' });

    expect(controlled.context.callId).toBe('logical-call');
    expect(controlled.context.correlationId).toBe('logical-trace');
    expect(controlled.request.requestID).toBe('logical-call');
    expect(controlled.request.control).toMatchObject({
      version: 1,
      callId: 'logical-call',
      correlationId: 'logical-trace',
      confirm: true,
      dryRun: 'plan',
      confirmation: {
        planId: 'plan-1',
        planHash: 'sha256-test',
        expiresAtUnixMs: 2_000,
        futureTokenMember: { retained: true },
      },
      futureControlMember: 7,
    });
    expect(controlled.request.control).toHaveProperty('requestID', 'request-is-not-a-control-member');
  });

  it.each([
    ['confirm', null],
    ['confirm', 'true'],
    ['dryRun', true],
    ['dryRun', 'preview'],
    ['confirmation', {}],
    ['confirmation', { planId: 'p', planHash: 'h', expiresAtUnixMs: -1 }],
  ])('rejects malformed %s control values before forwarding', (member, value) => {
    expect(() => normalizeToolCall({
      name: 'authoring-tool',
      arguments: {},
      control: { callId: 'bad-control', [member]: value },
    })).toThrowError(expect.objectContaining<ToolCallControlError>({ code: 'invalid_control' }));
  });

  it('uses one controlled serializer for CLI/library-shaped options', () => {
    const options = toolCallOptionsFromCli({
      callId: 'cli-call',
      correlationId: 'cli-trace',
      confirm: true,
      dryRun: 'none',
      confirmation: JSON.stringify({
        planId: 'plan-cli',
        planHash: 'sha256-cli',
        expiresAtUnixMs: 4_000,
      }),
    });
    const body = serializeControlledToolBody({ value: 1 }, options.control!);
    expect(body).toEqual({
      arguments: { value: 1 },
      control: {
        version: 1,
        callId: 'cli-call',
        correlationId: 'cli-trace',
        confirm: true,
        dryRun: 'none',
        confirmation: {
          planId: 'plan-cli',
          planHash: 'sha256-cli',
          expiresAtUnixMs: 4_000,
        },
      },
    });
  });

  it('does not serialize runtime cancellation from a context', () => {
    const context = normalizeToolCall({
      name: 'read-tool',
      arguments: {},
      control: { callId: 'runtime-call' },
    }, { signal: new AbortController().signal }).context;
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('signal');
    expect(serialized).not.toContain('abortSignal');
    expect((context as ToolCallContext).dryRun).toBe('none');
  });
});
