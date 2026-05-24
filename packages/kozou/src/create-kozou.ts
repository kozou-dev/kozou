#!/usr/bin/env node
// `create-kozou` bin entry. Thin wrapper around createKozouScaffold().

import { createKozouScaffold, KozouScaffoldError } from './scaffold.js';

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target || target === '--help' || target === '-h') {
    process.stderr.write('Usage: create-kozou <directory>\n');
    process.exit(target ? 0 : 1);
  }

  try {
    await createKozouScaffold({ target });
  } catch (err) {
    if (err instanceof KozouScaffoldError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  process.stderr.write(`Scaffolded ${target}/\n`);
  process.stderr.write(
    `Next: cd ${target} && cp .env.example .env && docker compose up\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`create-kozou: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
