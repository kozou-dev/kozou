#!/usr/bin/env node
/**
 * Derive the manifests an npm consumer would actually install.
 *
 * The blocking CVE gate needs to answer "does anything an adopter installs
 * from npm carry a fixable known vulnerability?". `pnpm-lock.yaml` cannot
 * answer that: it describes this workspace, including devDependencies,
 * examples/ and benchmarks/, and it is reshaped by `pnpm.overrides`, which
 * are workspace-local and never reach a consumer's resolver. Scanning it
 * both over-reports (dev tooling) and under-reports (an override can hide a
 * version an adopter is still stuck with — `cookie` did exactly that).
 *
 * So we reconstruct the consumer side from the declared ranges instead. For
 * each publishable package under packages/*, this writes a throwaway
 * project whose only dependency set is that package's own external
 * `dependencies` plus its non-optional `peerDependencies`. `npm install
 * --package-lock-only` then resolves each one the way a consumer's npm
 * would, and osv-scanner scans the resulting lockfiles.
 *
 * One project per package, rather than one merged project, on purpose: two
 * packages can declare different ranges for the same dependency, and a
 * single manifest can only state one of them. Per-package projects keep
 * each resolution faithful to "an adopter installed this package".
 *
 * workspace: / link: specifiers are dropped — those are the other kozou
 * packages, and each one contributes its own project here, so their
 * external dependencies are covered without double counting.
 *
 * Caveat worth knowing when reading the gate's output: this is npm's
 * resolution. An adopter on pnpm or yarn can get a different tree,
 * particularly for optional peers. It is one real consumer tree, not every
 * possible one — which is still far closer than the workspace lockfile.
 *
 * Usage: node scripts/derive-consumer-manifests.mjs <output-dir>
 * Prints one relative project path per line for the caller to iterate.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: derive-consumer-manifests.mjs <output-dir>');
  process.exit(2);
}

const PACKAGES_DIR = 'packages';

/** Specifiers that resolve inside the workspace rather than from a registry. */
const isInternal = (range) =>
  range.startsWith('workspace:') || range.startsWith('link:') || range.startsWith('file:');

const projects = [];

for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true }).sort()) {
  if (!entry.isDirectory()) continue;

  const manifestPath = join(PACKAGES_DIR, entry.name, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    continue;
  }

  // `private: true` packages are never published, so no adopter installs them.
  if (manifest.private) continue;

  const optionalPeers = manifest.peerDependenciesMeta ?? {};
  const declared = {
    ...(manifest.dependencies ?? {}),
    // Non-optional peers are auto-installed by npm 7+, so a consumer gets
    // them whether or not they ask. Optional peers are the consumer's choice
    // and are not part of a default install.
    ...Object.fromEntries(
      Object.entries(manifest.peerDependencies ?? {}).filter(
        ([name]) => !optionalPeers[name]?.optional,
      ),
    ),
  };

  const external = Object.fromEntries(
    Object.entries(declared).filter(([, range]) => !isInternal(range)),
  );

  if (Object.keys(external).length === 0) {
    console.error(`  ${manifest.name}: no external dependencies, skipped`);
    continue;
  }

  // One directory per package. The name is only cosmetic (npm requires a
  // valid one); the slash in scoped names would break the path.
  const slug = manifest.name.replace('@', '').replace('/', '-');
  const projectDir = join(outDir, slug);
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, 'package.json'),
    `${JSON.stringify(
      {
        name: `consumer-probe-${slug}`,
        version: '0.0.0',
        private: true,
        description: `Derived consumer tree for ${manifest.name}. Generated; do not edit.`,
        dependencies: Object.fromEntries(Object.entries(external).sort()),
      },
      null,
      2,
    )}\n`,
  );

  console.error(
    `  ${manifest.name}: ${Object.keys(external).length} external dep(s) -> ${projectDir}`,
  );
  projects.push(projectDir);
}

if (projects.length === 0) {
  console.error('no publishable package declared an external dependency');
  process.exit(1);
}

for (const dir of projects) console.log(dir);
