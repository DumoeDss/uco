import { describe, expect, it } from 'vitest';
import {
  ToolCallControlError,
  deriveChildToolCallContext,
  normalizeRestToolCall,
  normalizeToolCall,
  serializeControlledToolBody,
} from '../src/tool-call-control.js';

describe('tool-call control normalization', () => {
  it('gives legacy callers deterministic request, call, and correlation ids', () => {
    const normalized = normalizeToolCall({
      name: 'ping',
      arguments: { control: { belongsToTool: true } },
      requestID: 'legacy-7',
    });

    expect(normalized.request).toEqual({
      name: 'ping',
      arguments: { control: { belongsToTool: true } },
      requestID: 'legacy-7',
    });
    expect(normalized.context).toMatchObject({
      version: 1,
      callId: 'legacy-7',
      correlationId: 'legacy-7',
      parentCallId: undefined,
      deadlineUnixMs: undefined,
      cancellationId: undefined,
      idempotencyKey: undefined,
      legacy: true,
      unknownMembers: {},
    });
  });

  it('normalizes controlled calls and preserves unknown members', () => {
    const normalized = normalizeToolCall({
      name: 'ping',
      arguments: { value: 1 },
      control: {
        futureFlag: { enabled: true },
        correlationId: 'corr-1',
        callId: 'call-1',
      },
    });

    expect(normalized.request.requestID).toBe('call-1');
    expect(normalized.request.control).toEqual({
      version: 1,
      callId: 'call-1',
      correlationId: 'corr-1',
      futureFlag: { enabled: true },
    });
    expect(normalized.context.unknownMembers).toEqual({
      futureFlag: { enabled: true },
    });
    expect(normalized.context.legacy).toBe(false);
  });

  it('keeps a bare body containing a control tool argument in legacy form', () => {
    const normalized = normalizeRestToolCall(
      'legacy-tool',
      { control: { belongsToTool: true }, value: 2 },
      { generateId: () => 'generated-1' },
    );

    expect(normalized.request.arguments).toEqual({
      control: { belongsToTool: true },
      value: 2,
    });
    expect(normalized.request.control).toBeUndefined();
    expect(normalized.context.callId).toBe('generated-1');
  });

  it('unwraps an explicit arguments/control body exactly once', () => {
    const normalized = normalizeRestToolCall('ping', {
      arguments: { arguments: { nestedToolValue: true } },
      control: { callId: 'call-2' },
    });

    expect(normalized.request.arguments).toEqual({ arguments: { nestedToolValue: true } });
    expect(normalized.request.control?.correlationId).toBe('call-2');
  });

  it.each([
    [{ version: 2 }, 'unsupported_control_version'],
    [{ version: 1.5 }, 'invalid_control'],
    [{ callId: '' }, 'invalid_control'],
    [{ correlationId: 7 }, 'invalid_control'],
    [{ deadlineUnixMs: Number.POSITIVE_INFINITY }, 'invalid_control'],
    [{ deadlineUnixMs: 1.5 }, 'invalid_control'],
  ])('rejects malformed or unsupported control %#', (control, code) => {
    expect(() => normalizeToolCall({ name: 'ping', arguments: {}, control }))
      .toThrowError(expect.objectContaining<ToolCallControlError>({ code }));
  });

  it('derives fresh batch children without extending deadlines or inheriting idempotency', () => {
    const parent = normalizeToolCall({
      name: 'batch-execute',
      arguments: {},
      requestID: 'parent-request',
      control: {
        callId: 'parent-call',
        correlationId: 'trace-1',
        deadlineUnixMs: 2_000,
        idempotencyKey: 'parent-key',
      },
    }).context;

    const child = deriveChildToolCallContext(parent, {
      callId: 'child-call',
      deadlineUnixMs: 3_000,
    }, { generateId: () => 'unused' });

    expect(child).toMatchObject({
      callId: 'child-call',
      correlationId: 'trace-1',
      parentCallId: 'parent-call',
      deadlineUnixMs: 2_000,
      idempotencyKey: undefined,
      legacy: false,
    });
  });

  it('serializes controlled bodies in a deterministic known-then-sorted order', () => {
    const body = serializeControlledToolBody(
      { z: 1 },
      {
        zFuture: true,
        callId: 'call-3',
        aFuture: false,
        version: 1,
      },
    );

    expect(JSON.stringify(body)).toBe(
      '{"arguments":{"z":1},"control":{"version":1,"callId":"call-3","correlationId":"call-3","aFuture":false,"zFuture":true}}',
    );
  });
});
