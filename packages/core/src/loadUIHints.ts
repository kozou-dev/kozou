import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';
import { ZodError } from 'zod';
import { uiHintsSchema, type UIHints } from './types/ui-hints.js';

export class KozouUIHintsError extends Error {
  readonly filePath: string;
  readonly issues: { path: string; message: string; line?: number }[];
  constructor(
    message: string,
    filePath: string,
    issues: { path: string; message: string; line?: number }[],
  ) {
    super(message);
    this.name = 'KozouUIHintsError';
    this.filePath = filePath;
    this.issues = issues;
  }
}

// By default the error message only includes the file basename.
// The absolute path is kept on KozouUIHintsError.filePath; callers can decide
// whether to surface it in debug logs. This prevents user-environment paths
// from leaking through CLI / MCP error responses.
export async function loadUIHints(filePath: string): Promise<UIHints> {
  const content = await readFile(filePath, 'utf8');
  const fileLabel = basename(filePath);

  const doc = parseDocument(content, { prettyErrors: true });
  if (doc.errors.length > 0) {
    const issues = doc.errors.map((e) => ({
      path: '<yaml>',
      message: e.message,
      line: e.linePos?.[0]?.line,
    }));
    throw new KozouUIHintsError(
      `YAML parse error (${fileLabel}): ${doc.errors.length} issue(s)`,
      filePath,
      issues,
    );
  }

  const json = doc.toJS();
  if (json === null || json === undefined) {
    return uiHintsSchema.parse({});
  }

  try {
    return uiHintsSchema.parse(json);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((issue) => ({
        path: issue.path.join('.') || '<root>',
        message: issue.message,
      }));
      throw new KozouUIHintsError(
        `UIHints validation error (${fileLabel}): ${issues.length} issue(s)`,
        filePath,
        issues,
      );
    }
    throw err;
  }
}
