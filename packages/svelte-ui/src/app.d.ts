// See https://svelte.dev/docs/kit/types#app
// Sub-step 6-A placeholder. Sub-step 6-F replaces `schema` with the
// SchemaContext type from @kozou/core once the server hooks land.

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      schema: unknown;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
