// How a fatal error reaches the operator on stderr.
//
// Kept out of cli.ts (a process-exit shell, excluded from coverage) so the
// rendering itself is unit-tested: a KozouConfigError carries a structured
// `issues` array, and for the schema path the message is only a count — so
// printing `err.message` alone, as this CLI used to, dropped every path and
// every reason the config was refused.

import { KozouConfigError } from './config.js';

/**
 * Render a thrown value as the operator-facing stderr text (no trailing
 * newline; the caller adds it).
 *
 * For a {@link KozouConfigError}:
 *
 *   Invalid kozou config: 1 issue(s)
 *     server.mcp.http.port — Too big: expected number to be <=65535
 *   loaded from: /srv/app/kozou.config.yaml
 *
 * The file is reported as where the config was *loaded from*, not as where the
 * fault is: environment variables (KOZOU_MCP_HTTP_*, `${VAR}` expansion,
 * DATABASE_URL) feed the same validation, so a line claiming the file contains
 * the mistake would be wrong for anything they contributed. It is omitted
 * entirely when no file was loaded.
 */
export function formatCliError(err: unknown): string {
  if (!(err instanceof KozouConfigError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const lines = [err.message];
  for (const issue of err.issues) {
    // Error sites that duplicated their detail into the message — because the
    // message was all this CLI printed — would otherwise print it twice.
    if (err.message.includes(issue.message)) continue;
    lines.push(`  ${issue.path} — ${issue.message}`);
  }
  if (err.filePath !== null) lines.push(`loaded from: ${err.filePath}`);
  return lines.join('\n');
}
