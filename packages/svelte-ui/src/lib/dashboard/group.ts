// Dashboard data shaping: turn a SchemaContext into the minimal
// projection the dashboard route renders. Sorting + projection live
// here so the .svelte template stays declarative and the unit test
// targets a pure function.

import type {
  FunctionContext,
  SchemaContext,
  TableContext,
  ViewContext,
} from '@kozou/core';

export interface DashboardItem {
  /** Fully-qualified `<schema>.<name>` identifier used as the URL slug. */
  qualifiedName: string;
  /** Human-facing title (UI Hints > COMMENT first line > name). */
  label: string;
  /** Full COMMENT body, or null when the table/view has no comment. */
  description: string | null;
}

export interface DashboardGroups {
  tables: DashboardItem[];
  views: DashboardItem[];
  /** Exposed RPC functions (issue #103). Rendered as the "Actions" surface;
   *  empty when none are exposed (or the schema predates the field). */
  functions: DashboardItem[];
}

export function groupForDashboard(schema: SchemaContext): DashboardGroups {
  return {
    tables: schema.tables
      .map(toDashboardItem)
      .sort((a, b) => a.label.localeCompare(b.label)),
    views: schema.views
      .map(toDashboardItem)
      .sort((a, b) => a.label.localeCompare(b.label)),
    functions: (schema.functions ?? [])
      .map(toFunctionItem)
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function toFunctionItem(fn: FunctionContext): DashboardItem {
  return {
    qualifiedName: fn.qualifiedName,
    // The COMMENT body keeps the @ai/@policy advisory inline; the dashboard
    // shows only the first line as a one-liner.
    label: fn.label,
    description: fn.description ? (fn.description.split('\n')[0] ?? null) : null,
  };
}

function toDashboardItem(item: TableContext | ViewContext): DashboardItem {
  return {
    qualifiedName: item.qualifiedName,
    label: item.label,
    description: item.description,
  };
}
