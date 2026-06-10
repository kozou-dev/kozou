// Server-side helpers that seed the create / edit forms with relation-select
// options before the page reaches the browser.
//
// `loadInitialRelationOptions` fetches the first page of each relation
// target so the picker has rows on first paint (the browser then narrows
// them through the `/relation-options` endpoint as the operator types).
// `ensureSelectedOptions` guarantees the row a record currently points at is
// present in its picker, so editing a record and saving without touching the
// relation cannot silently drop the foreign key.
//
// Both swallow per-field backend errors and fall back gracefully (an empty
// list, or the raw value as its own label) so one unreachable target does
// not break the whole form, mirroring the detail route's FK label cache
// (Kozou v0.1 design spec §16.1.1 B).
//
// `searchRelationOptions` backs the `/relation-options` endpoint: it is the
// trust boundary for the browser's live search, so it validates the request
// against the live schema (known target table, real label / search columns)
// before forwarding to the adapter.

import { error } from '@sveltejs/kit';

import type { DataAdapter, RelationOption, SchemaContext } from '@kozou/core';

import type { RelationFieldConfig } from '$lib/form/relation-field-config.js';

/** First-page size for the pre-rendered picker; the live search re-queries
 *  with its own limit through the endpoint. */
export const INITIAL_RELATION_LIMIT = 20;

const MAX_RELATION_LIMIT = 100;

/** Raw query parameters of the `/relation-options` request (each as read from
 *  the URL, so `null` when absent). */
export interface RelationOptionsQuery {
  resource: string | null;
  label: string | null;
  fields: string | null;
  query: string | null;
  limit: string | null;
}

function clampLimit(raw: string | null): number {
  if (raw === null) return INITIAL_RELATION_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return INITIAL_RELATION_LIMIT;
  return Math.min(parsed, MAX_RELATION_LIMIT);
}

/**
 * Validate a relation-options request against the schema and run the search.
 *
 * The target `resource` must be a known table and both `label` and every
 * `fields` entry must be real columns of that table, so a crafted request
 * cannot point the picker at an unknown resource or push arbitrary identifiers
 * into the adapter's query grammar. Throws a SvelteKit `error` (400/404) on a
 * bad request; the endpoint surfaces it as the HTTP status.
 */
export async function searchRelationOptions(
  schema: SchemaContext,
  adapter: Pick<DataAdapter, 'searchRelation'>,
  request: RelationOptionsQuery,
): Promise<RelationOption[]> {
  const { resource, label } = request;
  if (resource === null || resource.length === 0) {
    throw error(400, 'relation-options requires a "resource" query parameter.');
  }
  if (label === null || label.length === 0) {
    throw error(400, 'relation-options requires a "label" query parameter.');
  }

  const target = schema.tables.find((t) => t.qualifiedName === resource);
  if (target === undefined) {
    throw error(404, `Unknown relation target: ${resource}`);
  }
  const columnNames = new Set(target.columns.map((c) => c.name));
  if (!columnNames.has(label)) {
    throw error(400, `Unknown label column "${label}" on "${resource}".`);
  }

  const searchFields = request.fields
    ? request.fields
        .split(',')
        .map((field) => field.trim())
        .filter((field) => field.length > 0)
    : [];
  for (const field of searchFields) {
    if (!columnNames.has(field)) {
      throw error(400, `Unknown search field "${field}" on "${resource}".`);
    }
  }

  return adapter.searchRelation(resource, {
    query: request.query ?? '',
    labelField: label,
    searchFields,
    limit: clampLimit(request.limit),
  });
}

export async function loadInitialRelationOptions(
  adapter: Pick<DataAdapter, 'searchRelation'>,
  relations: RelationFieldConfig[],
): Promise<Record<string, RelationOption[]>> {
  const entries = await Promise.all(
    relations.map(async (relation) => {
      try {
        const options = await adapter.searchRelation(relation.resource, {
          query: '',
          labelField: relation.labelField,
          searchFields: relation.searchFields,
          limit: INITIAL_RELATION_LIMIT,
        });
        return [relation.field, options] as const;
      } catch {
        return [relation.field, [] as RelationOption[]] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Ensure each relation's currently-stored value is selectable by prepending
 *  it (with a resolved label) when the first page does not already include
 *  it. Mutates `options` in place. */
export async function ensureSelectedOptions(
  adapter: Pick<DataAdapter, 'get'>,
  relations: RelationFieldConfig[],
  row: Record<string, unknown>,
  options: Record<string, RelationOption[]>,
): Promise<void> {
  await Promise.all(
    relations.map(async (relation) => {
      const current = row[relation.field];
      if (current === null || current === undefined) return;
      if (typeof current !== 'string' && typeof current !== 'number') return;

      const existing = options[relation.field] ?? [];
      if (existing.some((option) => option.id === current)) return;

      let label = String(current);
      try {
        const target = await adapter.get(relation.resource, current);
        const projected = target[relation.labelField];
        if (projected !== null && projected !== undefined) {
          label = String(projected);
        }
      } catch {
        // Target row missing / backend error: keep the raw value as its own
        // label so the selection is still preserved and editable.
      }
      options[relation.field] = [{ id: current, label }, ...existing];
    }),
  );
}
