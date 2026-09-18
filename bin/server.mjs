#!/usr/bin/env node
/**
 * uco bridge server CLI entry point.
 *
 * Usage:
 *   node bin/server.mjs [--listen-host 127.0.0.1] [--allow-lan] [--port 8080]
 *                       [--token secret] [--authorization required|none]
 *                       [--plugin-timeout-ms 10000] [--webhook-url URL]
 */

import { main } from '../dist/server/index.js';

main(process.argv).catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
