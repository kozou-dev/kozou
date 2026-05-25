// Covers the WidgetType -> component dispatch table from
// `src/lib/form/widget-registry.ts`. Step 7-H added this file to
// close the coverage gap (the map plus the `resolveWidget`
// fallback were sitting at 0% until now, which is what kept the
// overall coverage line ratio under the 90% DoD #6 threshold).

import { describe, it, expect } from 'vitest';
import type { WidgetType } from '@kozou/core';

import { widgetRegistry, resolveWidget } from '../../src/lib/form/widget-registry';

const REGISTERED_WIDGETS: readonly WidgetType[] = [
  'text',
  'textarea',
  'number',
  'currency',
  'boolean',
  'date',
  'datetime',
  'enum-select',
  'relation-select',
  'json',
  'image-url',
  'uuid',
] as const;

describe('widget-registry', () => {
  it('registers a component for every WidgetType used by buildSchemaContext', () => {
    for (const w of REGISTERED_WIDGETS) {
      expect(widgetRegistry[w], `widget "${w}" is missing from the registry`).toBeDefined();
    }
  });

  it('resolveWidget returns the registered component for a known widget', () => {
    expect(resolveWidget('boolean')).toBe(widgetRegistry.boolean);
    expect(resolveWidget('relation-select')).toBe(widgetRegistry['relation-select']);
  });

  it('resolveWidget falls back to the text widget for an unknown WidgetType', () => {
    // Intentionally cast through string to exercise the fallback
    // branch: production code is type-safe, but downstream callers
    // can still hand us a WidgetType the registry has not learned
    // yet (e.g. a future schema introduces a new widget kind
    // before the UI is rebuilt).
    const fallback = resolveWidget('not-a-real-widget' as WidgetType);
    expect(fallback).toBe(widgetRegistry.text);
  });
});
