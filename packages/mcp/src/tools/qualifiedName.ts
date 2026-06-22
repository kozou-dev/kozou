import { McpToolError } from '../errors.js';

/**
 * Resolve the required schema-qualified-name argument shared by the
 * `describe_table` / `describe_view` tools, with an actionable error when it
 * is missing or invalid.
 *
 * A bad/missing argument previously fell through to the dispatcher's generic
 * "The <tool> tool failed." message — true but useless to an agent trying to
 * self-correct. Instead we raise an `McpToolError` (which the dispatcher
 * surfaces verbatim) that names the argument and gives an example. The message
 * is built only from the tool name, the argument name, and a fixed example —
 * never from raw database or connection text — so the no-leak invariant holds.
 *
 * `name` is accepted as an alias for `qualifiedName`: it is the spelling the
 * sibling `get_concept_context` tool uses, and an easy thing for an agent to
 * reach for, so honoring it removes a common, avoidable round-trip.
 */
export function requireQualifiedName(
  tool: 'describe_table' | 'describe_view',
  args: Record<string, unknown>,
  example: string,
): string {
  const raw = args.qualifiedName ?? args.name;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  throw new McpToolError(
    `${tool}: missing required argument "qualifiedName" (a non-empty string, e.g. "${example}").`,
  );
}
