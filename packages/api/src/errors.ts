// Error type for the Kozou REST layer. A KozouApiError carries the HTTP
// status and a short machine-readable code; the request handler maps it
// to a JSON error body. Anything thrown that is *not* a KozouApiError is
// treated as an unexpected 500.

import { classifyDatabaseError } from '@kozou/core';

export class KozouApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'KozouApiError';
    this.status = status;
    this.code = code;
  }
}

/** Shape of the JSON body returned for any non-2xx response. */
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export function errorBody(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function notFound(message: string): KozouApiError {
  return new KozouApiError(404, 'not_found', message);
}

export function badRequest(message: string): KozouApiError {
  return new KozouApiError(400, 'bad_request', message);
}

export function methodNotAllowed(message: string): KozouApiError {
  return new KozouApiError(405, 'method_not_allowed', message);
}

export function unauthorized(message: string): KozouApiError {
  return new KozouApiError(401, 'unauthorized', message);
}

export function forbidden(message: string): KozouApiError {
  return new KozouApiError(403, 'forbidden', message);
}

export function payloadTooLarge(message: string): KozouApiError {
  return new KozouApiError(413, 'payload_too_large', message);
}

export function unsupportedMediaType(message: string): KozouApiError {
  return new KozouApiError(415, 'unsupported_media_type', message);
}

// ---- Database error mapping ------------------------------------------------
//
// The SQLSTATE classification lives in @kozou/core (shared with the MCP
// execution surface); here it is wrapped into the REST layer's HTTP error.
// classifyDatabaseError returns null for anything that is not a recognized
// client-facing outcome — the caller treats that as an internal 500 and must
// keep the raw database detail (identifiers included) out of the response body,
// logging it server-side only.

/**
 * Map a database error to its stable HTTP equivalent, or null when it is not a
 * recognized client-facing outcome.
 */
export function mapDatabaseError(err: unknown): KozouApiError | null {
  const cls = classifyDatabaseError(err);
  return cls === null ? null : new KozouApiError(cls.status, cls.code, cls.message);
}
