// Build step: copy the web UI's static files next to the compiled server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.cpSync(path.join(root, 'src/web/public'), path.join(root, 'dist/web/public'), { recursive: true });
