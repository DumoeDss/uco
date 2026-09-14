#!/usr/bin/env node
/**
 * Stub-plugin client CLI entry point.
 *
 * Connects to a Node MCP Server and runs all RPC method scenarios,
 * printing a pass/fail report for each of the 20 methods.
 *
 * Usage:
 *   node bin/stub-plugin.mjs [--url ws://localhost:8080/hub/mcp-server] [--token secret]
 */

import { runFullTestReport } from '../dist/server/stub-client/scenarios.js';

const args = process.argv.slice(2);
let url = 'ws://localhost:8080/hub/mcp-server';
let token;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    url = args[i + 1];
    i++;
  } else if (args[i] === '--token' && args[i + 1] !== undefined) {
    token = args[i + 1];
    i++;
  }
}

runFullTestReport(url, token)
  .then((passed) => process.exit(passed ? 0 : 1))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
