// Database error classification, shared by every surface that runs queries
// under the enforced role (the REST layer and the MCP execution tool).
//
// node-postgres surfaces server errors with the SQLSTATE in `code` (plus a
// `severity`). A small, deliberate subset is recognized as a client-facing
// outcome; everything else is left unclassified (null) so genuine kozou bugs
// are never relabelled as client errors. Data exceptions (class 22) are
// intentionally NOT classified: the client inputs that would otherwise raise
// one are pre-flighted before they reach the database, so an executed data
// exception signals a bug, not a client error.
//
// Classified messages are fully generic. The violated constraint / column name
// is NOT echoed: the error object cannot prove the identifier belongs to the
// exposed surface (e.g. a delete on an exposed table can be rejected by a
// foreign key from a table that is not exposed at all), so any identifier would
// be a schema-enumeration channel. The raw database message — identifiers
// included — is for the server log only.

/** A recognized, client-facing database outcome. `status` is the REST layer's
 *  HTTP mapping; the MCP layer uses `code` + `message` and ignores it. */
export type DatabaseErrorClass = {
  /** Stable HTTP status the REST layer maps this to. */
  status: number;
  /** Short machine-readable code. */
  code: string;
  /** Generic, identifier-free message safe to return to a caller. */
  message: string;
};

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
 * Classify a database error as a recognized client-facing outcome, or null when
 * it is not one. The caller treats null as an internal error (HTTP 500 for
 * REST; a generic error result for MCP) and must keep the raw detail out of any
 * response — log it server-side only.
 */
export function classifyDatabaseError(err: unknown): DatabaseErrorClass | null {
  if (!isDatabaseErrorLike(err)) return null;
  switch (err.code) {
    case '42501': // insufficient_privilege (incl. row-level security violations)
      return { status: 403, code: 'forbidden', message: 'Permission denied.' };
    case '23505': // unique_violation
      return { status: 409, code: 'conflict', message: 'Unique constraint violation.' };
    case '23503': // foreign_key_violation
      return { status: 409, code: 'conflict', message: 'Foreign key constraint violation.' };
    case '23502': // not_null_violation
      return { status: 400, code: 'constraint_violation', message: 'Not-null constraint violation.' };
    case '23514': // check_violation
      return { status: 400, code: 'constraint_violation', message: 'Check constraint violation.' };
    default:
      return null;
  }
}
