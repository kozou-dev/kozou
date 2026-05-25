import { describe, expect, it, vi } from 'vitest';

import type { DataAdapter, RelationOption } from '@kozou/core';

import {
  RelationSearchCancelledError,
  createRelationSearch,
} from '../../src/lib/form/relation-search.js';

function makeAdapter(
  result: RelationOption[],
): DataAdapter & {
  searchRelation: ReturnType<typeof vi.fn>;
} {
  return {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    searchRelation: vi.fn(async () => result),
  } as DataAdapter & { searchRelation: ReturnType<typeof vi.fn> };
}

describe('createRelationSearch', () => {
  it('debounces consecutive search() calls into a single adapter request', async () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter([{ id: 1, label: 'Austen' }]);
      const search = createRelationSearch({
        adapter,
        resource: 'authors',
        labelField: 'name',
        searchFields: ['name'],
        debounceMs: 200,
      });

      const p1 = search.search('a').catch(() => null);
      const p2 = search.search('au').catch(() => null);
      const p3 = search.search('aus');

      await vi.advanceTimersByTimeAsync(200);
      const rows = await p3;

      expect(rows).toEqual([{ id: 1, label: 'Austen' }]);
      expect(adapter.searchRelation).toHaveBeenCalledTimes(1);
      expect(adapter.searchRelation).toHaveBeenLastCalledWith('authors', {
        query: 'aus',
        labelField: 'name',
        searchFields: ['name'],
        limit: undefined,
      });

      // The earlier promises rejected with the cancellation error.
      await expect(p1).resolves.toBeNull();
      await expect(p2).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects earlier pending searches with RelationSearchCancelledError', async () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter([]);
      const search = createRelationSearch({
        adapter,
        resource: 'authors',
        labelField: 'name',
        searchFields: ['name'],
        debounceMs: 200,
      });

      const cancelled = search.search('a');
      search.search('au'); // cancels the previous one

      await expect(cancelled).rejects.toBeInstanceOf(
        RelationSearchCancelledError,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() rejects the in-flight search and skips the adapter call', async () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter([]);
      const search = createRelationSearch({
        adapter,
        resource: 'authors',
        labelField: 'name',
        searchFields: ['name'],
        debounceMs: 200,
      });

      const pending = search.search('a');
      search.cancel();

      await expect(pending).rejects.toBeInstanceOf(
        RelationSearchCancelledError,
      );
      expect(adapter.searchRelation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards labelField + searchFields + limit verbatim to the adapter', async () => {
    vi.useFakeTimers();
    try {
      const adapter = makeAdapter([]);
      const search = createRelationSearch({
        adapter,
        resource: 'audit.actors',
        labelField: 'display_name',
        searchFields: ['display_name', 'email'],
        limit: 5,
        debounceMs: 50,
      });

      const p = search.search('john');
      await vi.advanceTimersByTimeAsync(50);
      await p;

      expect(adapter.searchRelation).toHaveBeenCalledTimes(1);
      expect(adapter.searchRelation).toHaveBeenLastCalledWith('audit.actors', {
        query: 'john',
        labelField: 'display_name',
        searchFields: ['display_name', 'email'],
        limit: 5,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses injected timer hooks so adapter calls do not fire when the timer never advances', async () => {
    const adapter = makeAdapter([]);
    const setTimeoutFn = vi.fn(() => 'handle');
    const clearTimeoutFn = vi.fn();
    const search = createRelationSearch({
      adapter,
      resource: 'authors',
      labelField: 'name',
      searchFields: ['name'],
      debounceMs: 100,
      setTimeoutFn,
      clearTimeoutFn,
    });

    search.search('a').catch(() => null);

    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    expect(adapter.searchRelation).not.toHaveBeenCalled();

    search.cancel();
    expect(clearTimeoutFn).toHaveBeenCalledWith('handle');
  });
});
