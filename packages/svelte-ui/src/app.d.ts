// See https://svelte.dev/docs/kit/types#app

import type { SchemaContext } from '@kozou/core';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      schema: SchemaContext;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
