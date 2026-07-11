import type { SchemaContext, BuiltRpcCall } from '@kozou/core';
import {
  buildFunctionLookup,
  buildRpcCall,
  shapeRpcResult,
  classifyDatabaseError,
  runInRoleTransaction,
  RpcInputError,
} from '@kozou/core';

import { callInputSchema } from '../schemas/call.js';
import { fixedIdentity, type CallIdentity, type McpExecution } from '../execution.js';
import { successResult, errorResult, type McpToolResult } from '../result.js';

const LOG_PREFIX = '[kozou mcp call]';

/** Whether a resolved, exposed function is permitted by the optional execution
 *  allowlist. undefined allowlist = every exposed function may be called. */
function isAllowed(qualifiedName: string, allow: string[] | undefined): boolean {
  return allow === undefined || allow.includes(qualifiedName);
}

/**
 * The `call` execution tool: run an exposed RPC function under the resolved
 * identity and map the result — or a SAFE error — to an MCP result.
 *
 * `identity` is the role/claims the call runs as: the verified token's on an
 * OAuth-authenticated server, or (when omitted) the operator's fixed
 * execution role — the no-auth default.
 *
 * Enforcement is entirely PostgreSQL's. The call runs inside the shared
 * role-transaction envelope (SET LOCAL ROLE + published claims), so the
 * function's EXECUTE privilege and its own row-level-security policies apply
 * exactly as on the REST surface — exposure is not permission. A raw database
 * message is never returned to the caller (it goes to stderr); the caller sees
 * a generic, identifier-free category instead, mirroring the REST no-leak
 * contract.
 */
export async function callTool(
  input: Record<string, unknown>,
  ctx: SchemaContext,
  execution: McpExecution,
  identity?: CallIdentity,
): Promise<McpToolResult> {
  const who = identity ?? fixedIdentity(execution, LOG_PREFIX);
  const parsed = callInputSchema.safeParse(input);
  if (!parsed.success) {
    return errorResult(
      'Invalid call input: expected { "function": "<schema>.<name>", "args"?: { ... } }.',
    );
  }
  const { function: qualifiedName, args } = parsed.data;

  // Resolve within the SAME exposed set describe_functions advertises, then the
  // optional allowlist. A not-exposed / not-allowed function is
  // indistinguishable from a non-existent one (no enumeration channel).
  const fn = buildFunctionLookup(ctx).resolve(qualifiedName);
  if (fn === undefined || !isAllowed(qualifiedName, execution.allow)) {
    return errorResult(`Unknown function "${qualifiedName}".`);
  }

  // Pre-flight: unknown / missing arguments. The message names argument
  // identifiers, which are part of the exposed surface (safe to return).
  let built: BuiltRpcCall;
  try {
    built = buildRpcCall(fn, args ?? {});
  } catch (err) {
    if (err instanceof RpcInputError) return errorResult(err.message);
    throw err; // unexpected (the pure builder only raises RpcInputError)
  }

  // Execute under the enforced role. EXECUTE / RLS denials (42501) and
  // constraint violations surface as classified, identifier-free categories;
  // anything unrecognized (e.g. a RAISE) is logged server-side and returned
  // generic — the raw message is never echoed.
  let rows: Record<string, unknown>[];
  try {
    rows = await runInRoleTransaction(
      execution.pool,
      { role: who.role, claimsGuc: execution.claimsGuc, claims: who.claims },
      (db) => db.query<Record<string, unknown>>(built.text, built.values).then((r) => r.rows),
    );
  } catch (err) {
    const classified = classifyDatabaseError(err);
    if (classified !== null) return errorResult(classified.message);
    process.stderr.write(
      `${LOG_PREFIX} ${qualifiedName} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return errorResult('The function call failed.');
  }

  const shaped = shapeRpcResult(built.returns, rows);
  if (shaped.status === 204) {
    return successResult({ ok: true, note: 'Function executed; it returns no value.' });
  }
  return successResult(shaped.body);
}
