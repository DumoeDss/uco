// Deterministic port derivation — matches Unity-MCP plugin's algorithm.
//
// Source: Unity-MCP/cli/src/utils/port.ts (mirrors C# UnityMcpPlugin.GeneratePortFromDirectory).
// SHA256 of lowercased directory path → first 4 bytes LE as uint32 → mod 10000 + 20000.
//
// If the user changes the algorithm upstream (rare), the port the plugin
// listens on and the port we connect to will diverge. Treat upstream's
// implementation as the source of truth and sync this file when it changes.

import { createHash } from 'node:crypto';

const MIN_PORT = 20_000;
const MAX_PORT = 29_999;
const PORT_RANGE = MAX_PORT - MIN_PORT + 1;

export function generatePortFromDirectory(dir: string): number {
  const hash = createHash('sha256').update(dir.toLowerCase()).digest();
  const int32 = hash.readInt32LE(0);
  const uint32 = int32 >>> 0;
  return MIN_PORT + (uint32 % PORT_RANGE);
}
