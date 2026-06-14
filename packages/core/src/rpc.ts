// The RPC call core (issue #103): turning the exposed FunctionContexts of a
// SchemaContext into a callable namespace, shared by every surface that runs
// functions — the REST layer's `POST /rpc/<schema>.<fn>` and the MCP execution
// tool. It lives in @kozou/core so both surfaces reuse the exact same resolver,
// pre-flight, parameterization, and result shaping without depending on the
// REST package.
//
// Safety contract (mirrors the query builder):
//   - The only addressable functions are those @kozou/core decided to expose;
//     identifiers (schema / function / argument names) come from that decision,
//     never from raw request strings.
//   - Every argument value is a bound parameter ($1, $2, ...); no value is
//     interpolated into the SQL text.
//   - Whether the caller may actually run the function is enforced by
//     PostgreSQL's EXECUTE privilege under the caller's role; a denial (42501)
//     is surfaced by the calling surface's error mapping. Exposure is not
//     permission.

import type { SchemaContext, FunctionContext, FunctionReturnContext } from './types/context.js';
import { quoteIdent } from './ident.js';

/** A pre-flight failure while building an RPC call: an unknown argument name, a
 *  missing required argument, or a malformed argument body. Transport-neutral —
 *  the REST layer maps it to a 400, the MCP layer to an error result. */
export class RpcInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcInputError';
  }
}

/** Registry of exposed RPC functions, keyed by the schema-qualified identity
 *  (`schema.name`). Unlike resources, functions have no bare-name alias —
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
 * Pre-flight (all raise {@link RpcInputError} before the query runs):
 *   - the body must name only declared arguments (unknown key);
 *   - every argument without a DEFAULT must be supplied (missing).
 * Argument *value* validation (format / range) is deliberately left to
 * PostgreSQL; values are always bound, never interpolated.
 */
export function buildRpcCall(fn: FunctionContext, body: Record<string, unknown>): BuiltRpcCall {
  const argByName = new Map(fn.args.map((a) => [a.name, a]));

  for (const key of Object.keys(body)) {
    if (!argByName.has(key)) {
      throw new RpcInputError(`Unknown argument "${key}" for function "${fn.qualifiedName}".`);
    }
  }
  for (const arg of fn.args) {
    if (!arg.hasDefault && !Object.prototype.hasOwnProperty.call(body, arg.name)) {
      throw new RpcInputError(
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

/** Map the rows returned by {@link buildRpcCall}'s query to the v1 wire form:
 *  void -> 204; scalar -> the bare value; composite -> an object;
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
