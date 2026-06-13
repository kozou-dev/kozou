// The RPC surface for the Kozou REST layer (RPC design §5.1 / §6, issue #103).
// Turns the exposed FunctionContexts of a SchemaContext into a callable
// `POST /rpc/<schema>.<fn>` namespace: a registry that resolves a function by
// its schema-qualified identity (§5.0), a builder that pre-flights the body and
// produces a parameterized named-args call (§5.1 / §6.2), and a shaper that maps
// the result to the v1 wire form (§4.3).
//
// Safety contract (mirrors query-builder.ts):
//   - The only addressable functions are those `@kozou/core` decided to expose;
//     identifiers (schema / function / argument names) come from that decision,
//     never from raw request strings.
//   - Every argument value is a bound parameter ($1, $2, ...); no value is
//     interpolated into the SQL text.
//   - Whether the caller may actually run the function is enforced by
//     PostgreSQL's EXECUTE privilege under the request's role; a denial (42501)
//     maps to 403 via the handler's error classifier (§6.1). Exposure is not
//     permission.

import type { SchemaContext, FunctionContext, FunctionReturnContext } from '@kozou/core';

import { badRequest } from './errors.js';
import { quoteIdent } from './ident.js';

/** Registry of exposed RPC functions, keyed by the schema-qualified identity
 *  (`schema.name`, §5.0). Unlike resources, functions have no bare-name alias —
 *  the qualified name is the canonical and only addressable form. */
export type FunctionLookup = {
  resolve(qualifiedName: string): FunctionContext | undefined;
  /** Qualified names of every exposed function, sorted. */
  list(): string[];
};

export function buildFunctionLookup(schema: SchemaContext): FunctionLookup {
  const functions = schema.functions ?? [];
  const byKey = new Map(functions.map((f) => [f.qualifiedName, f]));
  const names = functions.map((f) => f.qualifiedName).sort();
  return {
    resolve: (qualifiedName) => byKey.get(qualifiedName),
    list: () => names,
  };
}

export type BuiltRpcCall = {
  text: string;
  values: unknown[];
  returns: FunctionReturnContext;
};

/** Column alias for a scalar (or SETOF-scalar) return, so the value is read
 *  back from a stable key regardless of the function name. */
const SCALAR_ALIAS = 'result';

/** A SETOF return whose row shape is a record of named columns (composite /
 *  RETURNS TABLE), as opposed to a SETOF of bare scalars. */
function setofHasColumns(returns: FunctionReturnContext): boolean {
  return returns.kind === 'setof' && returns.columns !== undefined && returns.columns.length > 0;
}

/** The SELECT that invokes `call` and exposes its result for {@link shapeRpcResult}.
 *  - void:               run it in scalar position; the result is discarded.
 *  - scalar / setof-scalar: `SELECT * FROM call AS _rpc(result)` — one column
 *    named `result` per row (one row for scalar, many for a scalar set).
 *  - composite / setof-record: `SELECT * FROM call AS _rpc` — the row's own
 *    columns (one row for composite, many for a set). */
function selectForReturn(call: string, returns: FunctionReturnContext): string {
  if (returns.kind === 'void') return `SELECT ${call}`;
  if (returns.kind === 'scalar' || (returns.kind === 'setof' && !setofHasColumns(returns))) {
    return `SELECT * FROM ${call} AS _rpc(${quoteIdent(SCALAR_ALIAS)})`;
  }
  return `SELECT * FROM ${call} AS _rpc`;
}

/**
 * Build the parameterized call for an exposed function from a named-args body.
 *
 * Pre-flight (§6.2, all 400 before the query runs):
 *   - the body must name only declared arguments (unknown key -> 400);
 *   - every argument without a DEFAULT must be supplied (missing -> 400).
 * Argument *value* validation (format / range) is deliberately left to
 * PostgreSQL for v1 and shares the future up-front-validation layer with
 * follow-up #110; values are always bound, never interpolated.
 */
export function buildRpcCall(fn: FunctionContext, body: Record<string, unknown>): BuiltRpcCall {
  const argByName = new Map(fn.args.map((a) => [a.name, a]));

  for (const key of Object.keys(body)) {
    if (!argByName.has(key)) {
      throw badRequest(`Unknown argument "${key}" for function "${fn.qualifiedName}".`);
    }
  }
  for (const arg of fn.args) {
    if (!arg.hasDefault && !Object.prototype.hasOwnProperty.call(body, arg.name)) {
      throw badRequest(
        `Missing required argument "${arg.name}" for function "${fn.qualifiedName}".`,
      );
    }
  }

  // Supplied arguments, in declaration order, as `"name" => $n` named-args. A
  // DEFAULT argument the body omits is left out so PostgreSQL applies its
  // default.
  const values: unknown[] = [];
  const fragments: string[] = [];
  for (const arg of fn.args) {
    if (!Object.prototype.hasOwnProperty.call(body, arg.name)) continue;
    values.push(body[arg.name]);
    fragments.push(`${quoteIdent(arg.name)} => $${values.length}`);
  }

  const call = `${quoteIdent(fn.schema)}.${quoteIdent(fn.name)}(${fragments.join(', ')})`;
  return { text: selectForReturn(call, fn.returns), values, returns: fn.returns };
}

export type RpcResult = { status: number; body: unknown };

/** Map the rows returned by {@link buildRpcCall}'s query to the v1 wire form
 *  (§4.3): void -> 204; scalar -> the bare value; composite -> an object;
 *  SETOF -> an array (of objects, or of bare scalars for a scalar set). */
export function shapeRpcResult(
  returns: FunctionReturnContext,
  rows: Record<string, unknown>[],
): RpcResult {
  switch (returns.kind) {
    case 'void':
      return { status: 204, body: undefined };
    case 'scalar':
      return { status: 200, body: rows[0]?.[SCALAR_ALIAS] ?? null };
    case 'composite':
      return { status: 200, body: rows[0] ?? null };
    case 'setof':
      return setofHasColumns(returns)
        ? { status: 200, body: rows }
        : { status: 200, body: rows.map((row) => row[SCALAR_ALIAS] ?? null) };
  }
}
