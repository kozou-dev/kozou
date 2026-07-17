// CLI: print a generated schema for inspection.
//
//   tsx src/schema/emit.ts <S|M|L> [--legend|--sql|--summary]
//
// Used to (a) author the task set against the frozen mangled names (run with
// --legend), and (b) record the exact schema a run measured. Prints the
// core legend by default.

import { generateSchema, SCALES, type Scale } from './generate.js';

function main(): void {
  const [scaleArg, mode = '--legend'] = process.argv.slice(2);
  const scale = (scaleArg ?? 'S') as Scale;
  if (!SCALES.includes(scale)) {
    console.error(`usage: emit.ts <${SCALES.join('|')}> [--legend|--sql|--summary]`);
    process.exitCode = 1;
    return;
  }

  const gen = generateSchema(scale);

  if (mode === '--sql') {
    process.stdout.write(gen.sql);
    return;
  }
  if (mode === '--summary') {
    console.log(
      JSON.stringify(
        {
          scale: gen.scale,
          seed: gen.seed,
          relationCount: gen.relationCount,
          noiseTableCount: gen.noiseTableCount,
          coreTableNames: gen.coreTableNames,
          coreViewNames: gen.coreViewNames,
        },
        null,
        2,
      ),
    );
    return;
  }
  // --legend (default)
  console.log(`# core legend (seed=${gen.seed}, scale=${gen.scale})`);
  for (const [key, name] of Object.entries(gen.legend)) {
    console.log(`${key}\t${name}`);
  }
}

main();
