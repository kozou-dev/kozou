// Error type for the Kozou REST layer. A KozouApiError carries the HTTP
// status and a short machine-readable code; the request handler maps it
// to a JSON error body. Anything thrown that is *not* a KozouApiError is
// treated as an unexpected 500.

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

// ---- Database error mapping ------------------------------------------------
//
// node-postgres surfaces server errors with the SQLSTATE in `code` (plus a
// `severity`). A small, deliberate subset maps to stable HTTP statuses;
// everything else stays a 500 with a generic body so kozou bugs are never
// relabelled as client errors. Data exceptions (22xxx) are intentionally
// NOT mapped: list filter / search input is pre-flighted before it reaches
// the database (invalid values 400 up front), and blanket-mapping the
// class would relabel genuine kozou bugs as client errors. Inputs not yet
// pre-flighted (id segments, write-body values) are tracked as follow-up
// work — the answer there is up-front validation, not runtime relabelling.
//
// Mapped messages are fully generic. The violated constraint / column name
// is NOT echoed: the error object cannot prove the identifier belongs to
// the exposed surface (e.g. a delete on an exposed table can be rejected
// by a foreign key from a table that is not exposed at all), so any
// identifier would be a schema-enumeration channel. The raw database
// message — identifiers included — goes to the server log only.

type DatabaseErrorLike = Error & {
  code: string;
  severity: string;
};

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function isDatabaseErrorLike(err: unknown): err is DatabaseErrorLike {
  if (!(err instanceof Error)) return false;
  const candidate = err as Partial<DatabaseErrorLike>;
  return (
    typeof candidate.code === 'string' &&
    SQLSTATE_RE.test(candidate.code) &&
    typeof candidate.severity === 'string'
  );
}

/**
 * Map a database error to its stable HTTP equivalent, or null when it is
 * not a recognized client-facing outcome. The caller treats null as an
 * internal 500 and must keep the raw detail out of the response body.
 */
export function mapDatabaseError(err: unknown): KozouApiError | null {
  if (!isDatabaseErrorLike(err)) return null;
  switch (err.code) {
    case '42501': // insufficient_privilege (incl. row-level security violations)
      return forbidden('Permission denied.');
    case '23505': // unique_violation
      return new KozouApiError(409, 'conflict', 'Unique constraint violation.');
    case '23503': // foreign_key_violation
      return new KozouApiError(409, 'conflict', 'Foreign key constraint violation.');
    case '23502': // not_null_violation
      return new KozouApiError(400, 'constraint_violation', 'Not-null constraint violation.');
    case '23514': // check_violation
      return new KozouApiError(400, 'constraint_violation', 'Check constraint violation.');
    default:
      return null;
  }
}
