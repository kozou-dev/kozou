#!/usr/bin/env node
// Copy template assets that `tsc` does not handle (*.yml / *.yaml / *.sql /
// *.example / migration directories) from `src/templates/` to
// `dist/templates/`. The scaffold logic in `src/scaffold.ts` resolves the
// templates directory via `new URL('./templates', import.meta.url)`, so the
// compiled `dist/scaffold.js` needs a sibling `dist/templates/` directory
// containing the same payload at publish time.

import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src', 'templates');
const destDir = join(here, '..', 'dist', 'templates');

await cp(srcDir, destDir, { recursive: true });
process.stdout.write(`copy-templates: ${srcDir} -> ${destDir}\n`);
