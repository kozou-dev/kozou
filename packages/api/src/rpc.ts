// The RPC call core (resolver, named-args builder, result shaper) lives in
// @kozou/core so the REST layer and the MCP execution surface share one
// implementation. buildRpcCall is wrapped here so the REST layer keeps raising
// its HTTP 400 (KozouApiError) on a pre-flight failure exactly as before; the
// shared core builder raises a transport-neutral RpcInputError, which the MCP
// surface maps to its own error result instead.

import { buildRpcCall as buildRpcCallCore, RpcInputError } from '@kozou/core';
import type { FunctionContext, BuiltRpcCall } from '@kozou/core';

import { badRequest } from './errors.js';

export { buildFunctionLookup, shapeRpcResult } from '@kozou/core';
export type { FunctionLookup, BuiltRpcCall, RpcResult } from '@kozou/core';

/**
 * Build the parameterized call for an exposed function from a named-args body,
 * raising a 400 {@link KozouApiError} on a pre-flight failure (the REST layer's
 * contract). Delegates to the shared @kozou/core builder and adapts its
 * transport-neutral input error to the HTTP error.
 */
export function buildRpcCall(fn: FunctionContext, body: Record<string, unknown>): BuiltRpcCall {
  try {
    return buildRpcCallCore(fn, body);
  } catch (err) {
    if (err instanceof RpcInputError) throw badRequest(err.message);
    throw err;
  }
}
