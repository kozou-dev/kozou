import type { RawCheck } from './types/raw.js';

const IN_RE = /\(?\s*(?:\w+\.)?["']?(\w+)["']?\s*\)?(?:::\w+)?\s+IN\s*\(\s*([^)]+)\)/i;
const ANY_ARRAY_RE = /\(?\s*(?:\w+\.)?["']?(\w+)["']?\s*\)?(?:::\w+)?\s*=\s*ANY\s*\(\s*ARRAY\s*\[([^\]]+)\]\s*\)/i;

const QUOTED_VALUE_RE = /'((?:[^']|'')*)'/g;

function extractQuotedValues(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(QUOTED_VALUE_RE)) {
    out.push(match[1]!.replace(/''/g, "'"));
  }
  return out;
}

export function extractCheckEnums(checks: RawCheck[]): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const check of checks) {
    const expr = check.expression;
    const anyMatch = ANY_ARRAY_RE.exec(expr);
    const inMatch = IN_RE.exec(expr);
    const match = anyMatch ?? inMatch;
    if (!match) {
      continue;
    }
    const column = match[1]!;
    const valueList = match[2]!;
    const values = extractQuotedValues(valueList);
    if (values.length === 0) {
      console.warn(
        `[@kozou/core] extractCheckEnums: failed to extract values from check "${check.name}" (expression: ${expr})`,
      );
      continue;
    }

    if (result.has(column)) {
      console.warn(
        `[@kozou/core] extractCheckEnums: column "${column}" has multiple enum CHECK constraints (last one wins)`,
      );
    }
    result.set(column, values);
  }

  return result;
}
