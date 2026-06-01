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
