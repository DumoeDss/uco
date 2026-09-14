/**
 * Session state store — mirrors the .NET ISessionStateStore.
 *
 * `Map<sessionId, SessionState>` with session-ID resolution from the
 * `Mcp-Session-Id` header (defaults to a stdio sentinel).
 *
 * Session sweeper removes sessions idle > 30 minutes.
 */

import { SESSION_IDLE_TIMEOUT_MS, STDIO_SESSION_ID } from '../types.js';

export interface SessionState {
  sessionId: string;
  activeInstanceId: string | null;
  /** null = all tools enabled; non-null = only these tool names allowed. */
  enabledTools: Set<string> | null;
  lastSeenUtc: Date;
}

/**
 * Resolve the session ID from the Mcp-Session-Id header.
 * Falls back to the stdio sentinel when missing.
 */
export function resolveSessionId(headers: { 'mcp-session-id'?: string }): string {
  return headers['mcp-session-id'] ?? STDIO_SESSION_ID;
}

export class SessionStateStore {
  private readonly sessions = new Map<string, SessionState>();
  private sweeperTimer: ReturnType<typeof setInterval> | null = null;

  getOrCreate(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        activeInstanceId: null,
        enabledTools: null,
        lastSeenUtc: new Date(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  tryGet(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastSeenUtc = new Date();
  }

  snapshot(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /** Start the periodic idle-session sweeper. */
  startSweeper(intervalMs = 5 * 60 * 1000): void {
    if (this.sweeperTimer) return;
    this.sweeperTimer = setInterval(() => this.sweep(), intervalMs);
    // Don't keep the process alive just for the sweeper.
    if (this.sweeperTimer && typeof this.sweeperTimer.unref === 'function') {
      this.sweeperTimer.unref();
    }
  }

  /** Remove sessions idle for more than SESSION_IDLE_TIMEOUT_MS. */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, state] of this.sessions) {
      if (now - state.lastSeenUtc.getTime() > SESSION_IDLE_TIMEOUT_MS) {
        this.sessions.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Stop the sweeper and clear all sessions. */
  dispose(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }
    this.sessions.clear();
  }
}
