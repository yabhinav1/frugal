#!/usr/bin/env node
// Launcher. An installed copy runs the compiled JavaScript in dist/. A source checkout without
// a build runs the TypeScript directly, which Node 23.6+ supports outside node_modules.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const built = new URL('../dist/cli.js', import.meta.url);
const source = new URL('../src/cli.ts', import.meta.url);
// A checkout (which has src/) always runs the source, so edits take effect without a rebuild.
// An installed package ships dist/ only.
const useSource = fs.existsSync(fileURLToPath(source)) && !fileURLToPath(source).includes('node_modules');
if (!useSource && !fs.existsSync(fileURLToPath(built))) {
  console.error('frugal is not built. Run: npm run build');
  process.exit(1);
}
const { main } = await import(useSource ? source.href : built.href);

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
