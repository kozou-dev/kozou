import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace the real REST adapter with a minimal stand-in that just records
// the baseUrl it was constructed with. This keeps the singleton factory's
// env wiring under test without pulling in the adapter's HTTP machinery
// (the reason the file was previously coverage-excluded). The adapter
// classes now live in @kozou/ui-core (the module under test imports them
// from there), so the mock targets that package. The mocked export names
// are fixed by the module under test, so this file is listed in the
// license-check code-grep exclusions alongside the other adapter files.
vi.mock('@kozou/ui-core', () => ({
  PostgrestDataAdapter: class {
    readonly kind = 'postgrest';
    readonly baseUrl: string;
    readonly primaryKey: ((resource: string) => string | string[]) | undefined;
    constructor(opts: {
      baseUrl: string;
      primaryKey?: (resource: string) => string | string[];
    }) {
      this.baseUrl = opts.baseUrl;
      this.primaryKey = opts.primaryKey;
    }
  },
  KozouApiDataAdapter: class {
    readonly kind = 'api';
    readonly baseUrl: string;
    readonly headers: Record<string, string> | undefined;
    constructor(opts: { baseUrl: string; headers?: Record<string, string> }) {
      this.baseUrl = opts.baseUrl;
      this.headers = opts.headers;
    }
  },
}));

import { getAdapter, resetAdapterForTests } from '../../src/lib/server/adapter.js';

const ORIGINAL_URL = process.env.KOZOU_ADAPTER_URL;
const ORIGINAL_KIND = process.env.KOZOU_ADAPTER_KIND;
const ORIGINAL_TOKEN = process.env.KOZOU_ADAPTER_TOKEN;

function baseUrlOf(adapter: unknown): string {
  return (adapter as { baseUrl: string }).baseUrl;
}

function kindOf(adapter: unknown): string {
  return (adapter as { kind: string }).kind;
}

function headersOf(adapter: unknown): Record<string, string> | undefined {
  return (adapter as { headers?: Record<string, string> }).headers;
}

beforeEach(() => {
  delete process.env.KOZOU_ADAPTER_URL;
  delete process.env.KOZOU_ADAPTER_KIND;
  delete process.env.KOZOU_ADAPTER_TOKEN;
  resetAdapterForTests();
});

afterEach(() => {
  restoreEnv('KOZOU_ADAPTER_URL', ORIGINAL_URL);
  restoreEnv('KOZOU_ADAPTER_KIND', ORIGINAL_KIND);
  restoreEnv('KOZOU_ADAPTER_TOKEN', ORIGINAL_TOKEN);
  resetAdapterForTests();
});

function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
}

describe('getAdapter', () => {
  it('builds the adapter from KOZOU_ADAPTER_URL when it is set', () => {
    process.env.KOZOU_ADAPTER_URL = 'http://postgrest.internal:3000';
    expect(baseUrlOf(getAdapter())).toBe('http://postgrest.internal:3000');
  });

  it('falls back to http://localhost:3000 when the env var is unset', () => {
    expect(baseUrlOf(getAdapter())).toBe('http://localhost:3000');
  });

  it('caches the singleton across calls', () => {
    expect(getAdapter()).toBe(getAdapter());
  });

  it('resetAdapterForTests forces a rebuild with the current env', () => {
    const first = getAdapter();
    process.env.KOZOU_ADAPTER_URL = 'http://other:3000';
    resetAdapterForTests();
    const second = getAdapter();
    expect(second).not.toBe(first);
    expect(baseUrlOf(second)).toBe('http://other:3000');
  });
});

describe('getAdapter — KOZOU_ADAPTER_KIND switch', () => {
  it('defaults to the PostgREST adapter at :3000', () => {
    const adapter = getAdapter();
    expect(kindOf(adapter)).toBe('postgrest');
    expect(baseUrlOf(adapter)).toBe('http://localhost:3000');
  });

  it('selects the in-house @kozou/api adapter at :3335 when kind=api', () => {
    process.env.KOZOU_ADAPTER_KIND = 'api';
    const adapter = getAdapter();
    expect(kindOf(adapter)).toBe('api');
    expect(baseUrlOf(adapter)).toBe('http://localhost:3335');
  });

  it('honours KOZOU_ADAPTER_URL for the api adapter', () => {
    process.env.KOZOU_ADAPTER_KIND = 'api';
    process.env.KOZOU_ADAPTER_URL = 'http://api.internal:9999';
    expect(baseUrlOf(getAdapter())).toBe('http://api.internal:9999');
  });

  it('treats an explicit kind=postgrest like the default', () => {
    process.env.KOZOU_ADAPTER_KIND = 'postgrest';
    expect(kindOf(getAdapter())).toBe('postgrest');
  });

  it('attaches a Bearer Authorization header from KOZOU_ADAPTER_TOKEN', () => {
    process.env.KOZOU_ADAPTER_KIND = 'api';
    process.env.KOZOU_ADAPTER_TOKEN = 'jwt-abc';
    expect(headersOf(getAdapter())).toEqual({ Authorization: 'Bearer jwt-abc' });
  });

  it('sends no Authorization header when KOZOU_ADAPTER_TOKEN is unset', () => {
    process.env.KOZOU_ADAPTER_KIND = 'api';
    expect(headersOf(getAdapter())).toBeUndefined();
  });

  it('ignores an empty KOZOU_ADAPTER_TOKEN', () => {
    process.env.KOZOU_ADAPTER_KIND = 'api';
    process.env.KOZOU_ADAPTER_TOKEN = '';
    expect(headersOf(getAdapter())).toBeUndefined();
  });

  it('resolves known tables to their schema primary key — preserving an empty key', () => {
    const schema = {
      meta: { serverVersion: 'test', builtAt: '2026-06-11T00:00:00Z', sourceSchemas: ['public'] },
      tables: [
        { qualifiedName: 'public.order_lines', primaryKey: ['order_id', 'line_no'] },
        { qualifiedName: 'public.event_log', primaryKey: [] },
      ],
      views: [],
      enums: [],
      concepts: [],
    } as unknown as Parameters<typeof getAdapter>[0];
    const resolver = (
      getAdapter(schema) as unknown as {
        primaryKey?: (resource: string) => string | string[];
      }
    ).primaryKey;

    expect(resolver?.('public.order_lines')).toEqual(['order_id', 'line_no']);
    // A known key-less table keeps its empty key list so the adapter's
    // key-column guard rejects by-id operations loudly, instead of filtering
    // on a possibly non-unique 'id' column.
    expect(resolver?.('public.event_log')).toEqual([]);
    // A bare resource name resolves against the default schema, matching the
    // adapter's own normalization — it must not bypass the empty-key guard.
    expect(resolver?.('order_lines')).toEqual(['order_id', 'line_no']);
    expect(resolver?.('event_log')).toEqual([]);
    // Unknown resources keep the adapter default.
    expect(resolver?.('public.not_in_schema')).toBe('id');
    expect(resolver?.('not_in_schema')).toBe('id');
  });
});
