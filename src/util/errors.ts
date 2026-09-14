// Typed errors — let the CLI surface format them with a stable shape.
//
// Every command path should funnel non-fatal failures through
// formatAndExit() in cli-context.ts so JSON / pretty modes both produce
// machine-parseable output.

export type TransportErrorKind =
  | 'http'
  | 'timeout'
  | 'connection-refused'
  | 'connection-reset'
  | 'dns'
  | 'unknown';

export interface TransportErrorFields {
  kind: TransportErrorKind;
  url: string;
  method: string;
  message: string;
  status?: number;
  statusText?: string;
  body?: unknown;
  /** Logical call id for tool-call requests (present when the caller sent one). */
  callId?: string;
  cause?: Error;
}

export class TransportError extends Error {
  readonly kind: TransportErrorKind;
  readonly url: string;
  readonly method: string;
  readonly status: number | undefined;
  readonly statusText: string | undefined;
  readonly body: unknown;
  readonly callId: string | undefined;

  constructor(fields: TransportErrorFields) {
    super(fields.message, { cause: fields.cause });
    this.name = 'TransportError';
    this.kind = fields.kind;
    this.url = fields.url;
    this.method = fields.method;
    this.status = fields.status;
    this.statusText = fields.statusText;
    this.body = fields.body;
    this.callId = fields.callId;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: true,
      kind: this.kind,
      url: this.url,
      method: this.method,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status, statusText: this.statusText } : {}),
      ...(this.body !== undefined ? { body: this.body } : {}),
      ...(this.callId !== undefined ? { callId: this.callId } : {}),
    };
  }
}

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(message: string, code = 'cli-error', exitCode = 1, retryable = false, details?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.retryable = retryable;
    this.details = details;
  }
}
