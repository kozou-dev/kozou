// Dashboard data shaping: turn a SchemaContext into the minimal
// projection the dashboard route renders. Sorting + projection live
// here so the .svelte template stays declarative and the unit test
// targets a pure function.
//
// See Kozou v0.1 design spec §8.3.1 (Dashboard).

import type { SchemaContext, TableContext, ViewContext } from '@kozou/core';

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
}

export function groupForDashboard(schema: SchemaContext): DashboardGroups {
  return {
    tables: schema.tables
      .map(toDashboardItem)
      .sort((a, b) => a.label.localeCompare(b.label)),
    views: schema.views
      .map(toDashboardItem)
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function toDashboardItem(item: TableContext | ViewContext): DashboardItem {
  return {
    qualifiedName: item.qualifiedName,
    label: item.label,
    description: item.description,
  };
}
