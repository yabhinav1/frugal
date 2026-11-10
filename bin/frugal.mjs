#!/usr/bin/env node
// Launcher: Node 23.6+ runs TypeScript directly, so there is no build step.
import { main } from '../src/cli.ts';

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
