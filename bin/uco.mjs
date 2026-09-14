#!/usr/bin/env node
import('../dist/index.js').catch((err) => {
  // eslint-disable-next-line no-console
  console.error('uco failed to start:', err);
  process.exit(1);
});
