// Debounced wrapper around DataAdapter.searchRelation.
// Each search() call cancels the prior pending call so a fast
// typist only fires one HTTP request per debounce window.
// setTimeout / clearTimeout are injected so vitest can drive the
// timer with vi.useFakeTimers().

import type { DataAdapter, RelationOption } from '@kozou/core';

const DEFAULT_DEBOUNCE_MS = 200;
const CANCELLED_REASON = 'relation-search:cancelled';

export interface RelationSearchOptions {
  adapter: DataAdapter;
  resource: string;
  labelField: string;
  searchFields: string[];
  limit?: number;
  /** Debounce window in milliseconds (default 200). */
  debounceMs?: number;
  /** Timer hooks; default to globalThis.setTimeout / clearTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface RelationSearch {
  search(query: string): Promise<RelationOption[]>;
  cancel(): void;
}

export class RelationSearchCancelledError extends Error {
  constructor() {
    super(CANCELLED_REASON);
    this.name = 'RelationSearchCancelledError';
  }
}

export function createRelationSearch(
  opts: RelationSearchOptions,
): RelationSearch {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimeoutFn =
    opts.setTimeoutFn ?? (globalThis.setTimeout as (cb: () => void, ms: number) => unknown);
  const clearTimeoutFn =
    opts.clearTimeoutFn ?? (globalThis.clearTimeout as (handle: unknown) => void);

  let pendingHandle: unknown = null;
  let pendingReject: ((reason: Error) => void) | null = null;

  function cancelInternal(): void {
    if (pendingHandle !== null) {
      clearTimeoutFn(pendingHandle);
      pendingHandle = null;
    }
    if (pendingReject !== null) {
      pendingReject(new RelationSearchCancelledError());
      pendingReject = null;
    }
  }

  return {
    search(query: string): Promise<RelationOption[]> {
      cancelInternal();
      return new Promise<RelationOption[]>((resolve, reject) => {
        pendingReject = reject;
        pendingHandle = setTimeoutFn(() => {
          pendingHandle = null;
          pendingReject = null;
          opts.adapter
            .searchRelation(opts.resource, {
              query,
              labelField: opts.labelField,
              searchFields: opts.searchFields,
              limit: opts.limit,
            })
            .then(resolve, reject);
        }, debounceMs);
      });
    },
    cancel(): void {
      cancelInternal();
    },
  };
}
