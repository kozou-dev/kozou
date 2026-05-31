import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace the real REST adapter with a minimal stand-in that just records
// the baseUrl it was constructed with. This keeps the singleton factory's
// env wiring under test without pulling in the adapter's HTTP machinery
// (the reason the file was previously coverage-excluded). The mocked
// export name is fixed by the module under test, so this file is listed in
// the license-check code-grep exclusions alongside the other adapter files.
vi.mock('$lib/adapter/index.js', () => ({
  PostgrestDataAdapter: class {
    readonly kind = 'postgrest';
    readonly baseUrl: string;
    constructor(opts: { baseUrl: string }) {
      this.baseUrl = opts.baseUrl;
    }
  },
  KozouApiDataAdapter: class {
    readonly kind = 'api';
    readonly baseUrl: string;
    constructor(opts: { baseUrl: string }) {
      this.baseUrl = opts.baseUrl;
    }
  },
}));

import { getAdapter, resetAdapterForTests } from '../../src/lib/server/adapter.js';

const ORIGINAL_URL = process.env.KOZOU_ADAPTER_URL;
const ORIGINAL_KIND = process.env.KOZOU_ADAPTER_KIND;

function baseUrlOf(adapter: unknown): string {
  return (adapter as { baseUrl: string }).baseUrl;
}

function kindOf(adapter: unknown): string {
  return (adapter as { kind: string }).kind;
}

beforeEach(() => {
  delete process.env.KOZOU_ADAPTER_URL;
  delete process.env.KOZOU_ADAPTER_KIND;
  resetAdapterForTests();
});

afterEach(() => {
  restoreEnv('KOZOU_ADAPTER_URL', ORIGINAL_URL);
  restoreEnv('KOZOU_ADAPTER_KIND', ORIGINAL_KIND);
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
});
