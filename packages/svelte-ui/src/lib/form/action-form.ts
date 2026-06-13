// Build the Admin UI "Actions" form for an exposed RPC function (issue #103).
// A function's arguments are turned into a synthetic set of
// ColumnContexts so the existing form pipeline — zodFromColumn / zodFromTable,
// the widget registry, buildMutationPayload — drives validation, rendering, and
// the named-args payload without a parallel implementation.
//
// Mapping an argument to a column:
//   - widget: the core-inferred arg widget (uuid / number / enum-select / ...).
//     A relation-hint arg (`@arg: x relation(t.col)`) is relation-select only
//     when the hint round-trips through the picker (single-column PK target with
//     a searchable label, see buildArgRelationConfig); otherwise it falls back
//     to a scalar input.
//   - defaultExpr: a sentinel when the argument has a DEFAULT, so
//     dbCanSupplyColumn treats it as optional — an empty submission is dropped
//     and PostgreSQL applies the function's DEFAULT (mode: 'create' in
//     buildMutationPayload). An argument without a DEFAULT is required.
//   - nullable: false. v1 has no "send SQL NULL explicitly" affordance; an
//     argument is either supplied or (when it has a DEFAULT) omitted.

import type {
  ColumnContext,
  FunctionContext,
  SchemaContext,
  WidgetType,
} from '@kozou/core';

import {
  buildArgRelationConfig,
  scalarWidgetForDataType,
  type RelationFieldConfig,
} from './relation-field-config.js';

/** Sentinel `defaultExpr` so `dbCanSupplyColumn` reports an argument with a
 *  DEFAULT as DB-suppliable (optional). Never used as a value — the payload
 *  drops the empty submission and PostgreSQL supplies the real default. */
const ARG_DEFAULT_SENTINEL = '__rpc_arg_default__';

/** Title-case a snake_case argument name for the field label (mirrors core's
 *  deriveLabel). */
function deriveLabel(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One rendered field in the action form. */
export type ActionArgView = {
  name: string;
  label: string;
  widget: WidgetType;
  enumValues: string[];
  /** Required when the argument has no DEFAULT. */
  required: boolean;
};

export type ActionForm = {
  /** The synthetic columns fed to zodFromTable / buildMutationPayload. */
  columns: ColumnContext[];
  /** Single-column relation-select configs for relation-hint arguments. */
  relations: RelationFieldConfig[];
  /** View model for the page template. */
  view: {
    qualifiedName: string;
    label: string;
    description: string | null;
    aiDescription: string | null;
    policy: string[];
    security: 'invoker' | 'definer';
    volatility: 'immutable' | 'stable' | 'volatile';
    args: ActionArgView[];
  };
};

export function buildActionForm(fn: FunctionContext, schema: SchemaContext): ActionForm {
  const relations: RelationFieldConfig[] = [];
  const columns: ColumnContext[] = [];
  const argViews: ActionArgView[] = [];

  for (const arg of fn.args) {
    let widget: WidgetType = arg.widget;

    // A relation-hint arg renders as a picker only when the hint round-trips;
    // otherwise demote it to a scalar input (the operator types the value).
    if (arg.widget === 'relation-select') {
      const config = arg.relation
        ? buildArgRelationConfig(arg.name, arg.relation, schema)
        : null;
      if (config !== null) {
        relations.push(config);
      } else {
        widget = scalarWidgetForDataType(arg.typeName);
      }
    }

    const enumValues = arg.enumValues ?? null;
    columns.push({
      name: arg.name,
      dataType: arg.typeName,
      nullable: false,
      defaultExpr: arg.hasDefault ? ARG_DEFAULT_SENTINEL : null,
      isPrimaryKey: false,
      isForeignKey: arg.widget === 'relation-select',
      label: deriveLabel(arg.name),
      description: null,
      aiDescription: null,
      widget,
      enumValues,
      readonly: false,
    });
    argViews.push({
      name: arg.name,
      label: deriveLabel(arg.name),
      widget,
      enumValues: enumValues ?? [],
      required: !arg.hasDefault,
    });
  }

  return {
    columns,
    relations,
    view: {
      qualifiedName: fn.qualifiedName,
      label: fn.label,
      description: fn.description,
      aiDescription: fn.aiDescription,
      policy: fn.policy ?? [],
      security: fn.security,
      volatility: fn.volatility,
      args: argViews,
    },
  };
}
