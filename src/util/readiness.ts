// Shared readiness-stage evaluation — the single source for both
// `uco wait-for-ready` and the post-call idle wait so the two waits can
// never disagree about what "idle" means.

import { TransportError } from './errors.js';
import { toolPayloadRecords } from './tool-payload.js';

export const READINESS_STAGES = ['process', 'http', 'webSocket', 'handshake', 'capabilities', 'toolRunner'] as const;

export interface RegistrationReadiness {
  ready: boolean;
  stage: string;
  cause: string;
}

/** Evaluate the server-side bridge stages from a readiness health response. */
export function registrationReadiness(value: unknown): RegistrationReadiness {
  const record = asRecord(value);
  if (record === undefined) {
    return { ready: false, stage: 'http', cause: 'invalid-health-response' };
  }
  const stages = asRecord(record['stages']);
  if (stages === undefined) {
    return { ready: false, stage: 'http', cause: 'missing-health-stages' };
  }
  for (const stage of READINESS_STAGES) {
    const entry = asRecord(stages[stage]);
    if (entry?.['ready'] !== true) {
      return { ready: false, stage, cause: stageReason(entry) };
    }
  }
  return { ready: true, stage: 'toolRunner', cause: 'ready' };
}

export function stageReason(value: unknown): string {
  if (value && typeof value === 'object') {
    const reason = (value as Record<string, unknown>)['reason'];
    if (typeof reason === 'string' && reason) return reason;
  }
  return 'not-ready';
}

export function editorReadiness(value: unknown): { ready: boolean; stage: 'editor' | 'probe'; cause: string } {
  const records = [...toolPayloadRecords(value)];
  for (const record of records) {
    if (record['Ok'] === false || record['ok'] === false) {
      return { ready: false, stage: 'probe', cause: failureCause(record) };
    }
  }

  const candidate = records.reverse().find(hasEditorStateKey);
  if (candidate === undefined) {
    return { ready: false, stage: 'editor', cause: 'invalid-editor-state' };
  }

  const readiness = records
    .map((record) => asRecord(record['Readiness'] ?? record['readiness']))
    .find((record) => record !== undefined);
  if (readiness !== undefined) {
    const state = readString(readiness, 'State', 'state');
    const ready = readBoolean(readiness, 'Ready', 'ready');
    if (state === undefined || ready === undefined) {
      return { ready: false, stage: 'editor', cause: 'invalid-readiness-snapshot' };
    }
    if (!ready || state !== 'ready') {
      return { ready: false, stage: 'editor', cause: state };
    }
    return { ready: true, stage: 'probe', cause: 'ready' };
  }

  const required = {
    isPlaying: readBoolean(candidate, 'IsPlaying', 'isPlaying'),
    isPaused: readBoolean(candidate, 'IsPaused', 'isPaused'),
    isCompiling: readBoolean(candidate, 'IsCompiling', 'isCompiling'),
    isUpdating: readBoolean(candidate, 'IsUpdating', 'isUpdating'),
    isPlayingOrWillChange: readBoolean(
      candidate,
      'IsPlayingOrWillChangePlaymode',
      'IsPlayingOrWillChangePlayMode',
      'isPlayingOrWillChangePlaymode',
      'isPlayingOrWillChangePlayMode',
    ),
  };
  const missing = Object.entries(required)
    .filter(([, entry]) => entry === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    return { ready: false, stage: 'editor', cause: `missing-editor-state-fields:${missing.join(',')}` };
  }

  if (required.isCompiling) return { ready: false, stage: 'editor', cause: 'compiling' };
  if (required.isUpdating) return { ready: false, stage: 'editor', cause: 'updating-or-importing' };
  if (readBoolean(candidate, 'IsImporting', 'isImporting') === true) {
    return { ready: false, stage: 'editor', cause: 'importing' };
  }
  if (readBoolean(candidate, 'IsReloading', 'isReloading') === true) {
    return { ready: false, stage: 'editor', cause: 'domain-reloading' };
  }
  if (required.isPlaying !== required.isPlayingOrWillChange) {
    return { ready: false, stage: 'editor', cause: 'play-mode-transition' };
  }

  const blockers = readStringArray(candidate, 'Blockers', 'blockers');
  const transitionBlocker = blockers?.find((entry) =>
    /compil|updat|import|reload|transition/i.test(entry));
  if (transitionBlocker !== undefined) {
    return { ready: false, stage: 'editor', cause: transitionBlocker };
  }

  return { ready: true, stage: 'probe', cause: 'ready' };
}

export function failureCause(record: Record<string, unknown>): string {
  const detail = [record['Error'], record['error'], record['Message'], record['message']]
    .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return detail === undefined ? 'editor-probe-failed' : `editor-probe-failed:${detail}`;
}

export function transportStage(error: TransportError): string {
  return error.kind === 'http' ? 'http' : 'process';
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasEditorStateKey(record: Record<string, unknown>): boolean {
  return ['IsPlaying', 'isPlaying', 'IsCompiling', 'isCompiling', 'IsUpdating', 'isUpdating']
    .some((key) => key in record);
}

function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  return undefined;
}

function readStringArray(record: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  }
  return undefined;
}
