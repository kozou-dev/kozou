import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Replace the real PostgREST adapter with a minimal stand-in that just
// records the baseUrl it was constructed with. This keeps the singleton
// factory's env wiring under test without pulling in the adapter's HTTP
// machinery (the reason the file was previously coverage-excluded).
vi.mock('$lib/adapter/index.js', () => ({
  PostgrestDataAdapter: class {
    readonly baseUrl: string;
    constructor(opts: { baseUrl: string }) {
      this.baseUrl = opts.baseUrl;
    }
  },
}));

import { getAdapter, resetAdapterForTests } from '../../src/lib/server/adapter.js';

const ORIGINAL = process.env.KOZOU_ADAPTER_URL;

function baseUrlOf(adapter: unknown): string {
  return (adapter as { baseUrl: string }).baseUrl;
}

beforeEach(() => {
  delete process.env.KOZOU_ADAPTER_URL;
  resetAdapterForTests();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.KOZOU_ADAPTER_URL;
  else process.env.KOZOU_ADAPTER_URL = ORIGINAL;
  resetAdapterForTests();
});

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
