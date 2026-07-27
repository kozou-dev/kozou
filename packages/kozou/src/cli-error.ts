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
 * The last line reports where the values came *from*, never that the mistake is
 * there. Schema validation runs on the config file and the environment merged,
 * and the schema path cannot say which source a given issue came from, so the
 * line names every source that actually contributed:
 *
 *   - `KOZOU_JWT_*` (via injectAuthFromEnv) is the group that can inject a value
 *     the schema refuses — `KOZOU_JWT_ALGORITHMS=ES256` fails at
 *     `auth.jwt.algorithms.0`, a path no config file need contain;
 *   - `KOZOU_MCP_HTTP_ENABLED` / `KOZOU_UI_HOST` / `KOZOU_MCP_HTTP_HOST` and
 *     `DATABASE_URL` supply values that pass on their own but can fail a
 *     cross-field check — `KOZOU_MCP_HTTP_ENABLED=false` against a file with an
 *     `auth` block trips the "auth set while disabled" refusal, whose remedy the
 *     file already satisfies;
 *   - `${VAR}` expansion is deliberately *not* listed: the placeholder is
 *     written in the file, so the file is the right place to look.
 *
 * With no file and no contributing variable the line is omitted entirely.
 */
export function formatCliError(err: unknown): string {
  if (!(err instanceof KozouConfigError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const lines = [err.message];
  for (const issue of err.issues) {
    // Error sites that duplicated their detail into the message — because the
    // message was all this CLI printed — would otherwise print it twice. Guard
    // the empty string, which every message "contains".
    if (issue.message !== '' && err.message.includes(issue.message)) continue;
    // The loader always sets both halves (`<root>` when zod reports no path),
    // but KozouConfigIssue is exported, so a hand-built issue may omit either.
    // Join what is there rather than printing a separator with nothing beside it.
    const parts = [issue.path, issue.message].filter((part) => part !== '');
    if (parts.length > 0) lines.push(`  ${parts.join(' — ')}`);
  }
  const location = describeSources(err);
  if (location !== undefined) lines.push(location);
  return lines.join('\n');
}

function describeSources(err: KozouConfigError): string | undefined {
  const env = err.envSources.length > 0 ? err.envSources.join(', ') : undefined;
  if (err.filePath === null) {
    return env === undefined ? undefined : `loaded from: the environment (${env})`;
  }
  return env === undefined
    ? `loaded from: ${err.filePath}`
    : `loaded from: ${err.filePath}, with values from ${env}`;
}
