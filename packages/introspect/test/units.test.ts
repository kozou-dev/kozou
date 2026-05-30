import { describe, it, expect } from 'vitest';
import type { Client } from 'pg';

import { fetchChecks } from '../src/checks.js';
import { fetchEnums } from '../src/enums.js';
import { fetchForeignKeys } from '../src/fks.js';
import { fetchTables } from '../src/tables.js';
import { fetchViews } from '../src/views.js';

// Each per-aspect fetcher short-circuits on an empty schema list before
// touching the database, so these run without a container. A client whose
// `query` throws stands in to prove the SQL path is never reached.
const noClient = {
  query: () => {
    throw new Error('query must not run for an empty schema list');
  },
} as unknown as Client;

describe('fetch* helpers short-circuit on an empty schema list', () => {
  it('fetchTables returns []', async () => {
    expect(await fetchTables(noClient, [])).toEqual([]);
  });

  it('fetchViews returns []', async () => {
    expect(await fetchViews(noClient, [])).toEqual([]);
  });

  it('fetchEnums returns []', async () => {
    expect(await fetchEnums(noClient, [])).toEqual([]);
  });

  it('fetchChecks returns an empty map', async () => {
    const result = await fetchChecks(noClient, []);
    expect(result.size).toBe(0);
  });

  it('fetchForeignKeys returns an empty map', async () => {
    const result = await fetchForeignKeys(noClient, []);
    expect(result.size).toBe(0);
  });
});
