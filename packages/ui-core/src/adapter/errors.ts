// Common error base for DataAdapter implementations.
// Concrete adapters (see ./index.ts) extend AdapterError with their
// own subclass so callers can catch by family without coupling to a
// specific backend.

export type AdapterErrorCode = 'http' | 'network' | 'parse' | 'config';

export interface AdapterErrorInit {
  readonly message: string;
  readonly status: number;
  readonly url: string;
  readonly responseBody: string | null;
  readonly code: AdapterErrorCode;
}

export class AdapterError extends Error {
  readonly status: number;
  readonly url: string;
  readonly responseBody: string | null;
  readonly code: AdapterErrorCode;

  constructor(init: AdapterErrorInit) {
    super(init.message);
    this.name = 'AdapterError';
    this.status = init.status;
    this.url = init.url;
    this.responseBody = init.responseBody;
    this.code = init.code;
  }
}
