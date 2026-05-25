// Common types shared across all DataAdapter implementations.
// See Kozou v0.1 design spec §4.4 (DataAdapter interface) and §8.5.

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<Response>;
