// See https://svelte.dev/docs/kit/types#app

import type { SchemaContext } from '@kozou/core';

import type { FkRowCache } from '@kozou/ui-core';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      schema: SchemaContext;
      /** Per-process TTL cache shared by every detail-route render to
       *  resolve FK columns to their referenced row's displayField
       *  label without re-fetching across renders. */
      fkRowCache: FkRowCache;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
