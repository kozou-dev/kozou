// WidgetType -> Svelte component dispatch table.
// Sub-step 6-J / 6-K read this map to resolve which input control
// to render for each ColumnContext. Falls back to the text widget
// for any unknown WidgetType so the form stays usable while we
// extend the WidgetType union.

import type { Component } from 'svelte';

import type { WidgetType } from '@kozou/core';

import BooleanWidget from './widgets/boolean.svelte';
import DateWidget from './widgets/date.svelte';
import DatetimeWidget from './widgets/datetime.svelte';
import EnumSelectWidget from './widgets/enum-select.svelte';
import ImageUrlWidget from './widgets/image-url.svelte';
import JsonWidget from './widgets/json.svelte';
import NumberWidget from './widgets/number.svelte';
import RelationSelectWidget from './widgets/relation-select.svelte';
import TextWidget from './widgets/text.svelte';
import TextareaWidget from './widgets/textarea.svelte';
import UuidWidget from './widgets/uuid.svelte';

// Each widget exposes its own Props shape (text/number/etc. take
// `value: string | number | null`, relation-select takes `options:
// RelationOption[]`, json takes `value: unknown`, ...). The
// registry erases those into a common dispatch type so callers can
// look up by WidgetType; the actual prop contract is reasserted at
// the call site in Sub-step 6-J / 6-K via <svelte:component> +
// dedicated prop-passing per widget kind.
export type WidgetComponent = Component<Record<string, unknown>>;

export const widgetRegistry: Record<WidgetType, WidgetComponent> = {
  text: TextWidget as unknown as WidgetComponent,
  textarea: TextareaWidget as unknown as WidgetComponent,
  number: NumberWidget as unknown as WidgetComponent,
  currency: NumberWidget as unknown as WidgetComponent,
  boolean: BooleanWidget as unknown as WidgetComponent,
  date: DateWidget as unknown as WidgetComponent,
  datetime: DatetimeWidget as unknown as WidgetComponent,
  'enum-select': EnumSelectWidget as unknown as WidgetComponent,
  'relation-select': RelationSelectWidget as unknown as WidgetComponent,
  json: JsonWidget as unknown as WidgetComponent,
  'image-url': ImageUrlWidget as unknown as WidgetComponent,
  uuid: UuidWidget as unknown as WidgetComponent,
};

export function resolveWidget(widget: WidgetType): WidgetComponent {
  return widgetRegistry[widget] ?? (TextWidget as unknown as WidgetComponent);
}
