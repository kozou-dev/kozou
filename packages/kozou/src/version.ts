// The kozou package version, read from package.json at module load so a
// release bump in package.json can never drift from this constant.
// `../package.json` resolves to packages/kozou/package.json from the
// compiled dist/version.js, and npm always ships package.json in the
// published tarball.
//
// Kept in its own module (rather than in index.ts) so command modules can
// read the version without importing the package barrel `./index.js`,
// which re-exports the commands and would create an import cycle.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(require.resolve('../package.json'), 'utf8')) as {
  version: string;
};

export const PACKAGE_VERSION = pkg.version;
