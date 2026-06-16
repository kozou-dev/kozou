// Integration tests for the table CRUD form actions: a DB rejection raised by
// the adapter as an AdapterError must become a recoverable `fail(...)` (so the
// form keeps the user's input), and a non-recoverable error must propagate.
// The adapter singleton is mocked so the actions hit a throwing adapter
// without any real backend (issue #170).

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ColumnContext, SchemaContext, TableContext } from '@kozou/core';

// A hoisted holder lets the mock factory (hoisted above the imports) and the
// test body share one mutable adapter reference; the test installs a throwing
// adapter built from the real AdapterError class in beforeEach.
const h = vi.hoisted(() => ({ adapter: null as unknown as Record<string, unknown> }));

vi.mock('$lib/server/adapter.js', () => ({
  getAdapter: () => h.adapter,
  resetAdapterForTests: () => {},
}));

import { AdapterError } from '@kozou/ui-core';

import { actions as newActions } from '../../src/routes/tables/[table]/new/+page.server.js';
import { actions as editActions } from '../../src/routes/tables/[table]/[id]/edit/+page.server.js';
import { actions as detailActions } from '../../src/routes/tables/[table]/[id]/+page.server.js';

function makeColumn(name: string, overrides: Partial<ColumnContext> = {}): ColumnContext {
  return {
    name,
    dataType: 'text',
    nullable: true,
    defaultExpr: null,
    isPrimaryKey: false,
    isForeignKey: false,
    label: name,
    description: null,
    aiDescription: null,
    widget: 'text',
    enumValues: null,
    readonly: false,
    ...overrides,
  };
}

function makeSchema(): SchemaContext {
  const widgets: TableContext = {
    schema: 'public',
    name: 'widgets',
    qualifiedName: 'public.widgets',
    label: 'widgets',
    description: null,
    aiDescription: null,
    primaryKey: ['id'],
    displayField: 'name',
    columns: [
      // PK with a DEFAULT -> dbCanSupply -> optional in the form schema.
      makeColumn('id', {
        isPrimaryKey: true,
        widget: 'uuid',
        dataType: 'uuid',
        nullable: false,
        defaultExpr: 'gen_random_uuid()',
      }),
      makeColumn('name'),
    ],
    relations: [],
    rawTable: {} as TableContext['rawTable'],
  };
  return {
    meta: {
      serverVersion: 'test',
      builtAt: '2026-06-16T00:00:00Z',
      sourceSchemas: ['public'],
    },
    tables: [widgets],
    views: [],
    enums: [],
    concepts: [],
    functions: [],
  } as SchemaContext;
}

function adapterErr(status: number): AdapterError {
  return new AdapterError({
    message: `duplicate key value violates unique constraint "widgets_name_key" (status ${status})`,
    status,
    url: 'http://api.example/widgets',
    responseBody: null,
    code: status === 0 ? 'network' : 'http',
  });
}

function throwingAdapter(status: number): Record<string, unknown> {
  const thrower = vi.fn(async () => {
    throw adapterErr(status);
  });
  return { create: thrower, update: thrower, delete: thrower, get: vi.fn(), list: vi.fn() };
}

function formRequest(): Request {
  return new Request('http://localhost/tables/public.widgets', {
    method: 'POST',
    body: new URLSearchParams({ name: 'hello' }),
  });
}

const locals = () => ({ schema: makeSchema() }) as unknown as App.Locals;

beforeEach(() => {
  h.adapter = throwingAdapter(409);
});

describe('create action (new/+page.server.ts)', () => {
  it('returns a 409 fail with the form + readable message instead of throwing', async () => {
    const result = await newActions.default({
      request: formRequest(),
      params: { table: 'public.widgets' },
      locals: locals(),
    } as never);

    expect(result).toMatchObject({ status: 409 });
    const form = (result as {
      data: { form: { valid: boolean; message?: string; data: Record<string, unknown> } };
    }).data.form;
    // The readable message rides superforms' status-message channel.
    expect(form.message).toMatch(/unique|conflict|already in use/i);
    // The user's input is preserved so the form can re-render it.
    expect(form.data.name).toBe('hello');
    // Marked invalid so the no-JS / SSR path re-renders with the input
    // instead of resetting to the load defaults.
    expect(form.valid).toBe(false);
    // The raw backend message is not leaked.
    expect(form.message).not.toMatch(/widgets_name_key/);
    expect(h.adapter.create).toHaveBeenCalledOnce();
  });

  it('re-throws a 5xx so a genuine server fault is not disguised as a form error', async () => {
    h.adapter = throwingAdapter(500);
    await expect(
      newActions.default({
        request: formRequest(),
        params: { table: 'public.widgets' },
        locals: locals(),
      } as never),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe('update action (edit/+page.server.ts)', () => {
  it('returns a 409 fail with the form + readable message instead of throwing', async () => {
    const result = await editActions.default({
      request: formRequest(),
      params: { table: 'public.widgets', id: 'w1' },
      locals: locals(),
    } as never);

    expect(result).toMatchObject({ status: 409 });
    const form = (result as {
      data: { form: { valid: boolean; message?: string; data: Record<string, unknown> } };
    }).data.form;
    expect(form.message).toMatch(/unique|conflict|already in use/i);
    expect(form.data.name).toBe('hello');
    expect(form.valid).toBe(false);
    expect(h.adapter.update).toHaveBeenCalledOnce();
  });
});

describe('delete action (detail/+page.server.ts)', () => {
  it('returns a fail with a readable message instead of throwing', async () => {
    const result = await detailActions.delete({
      params: { table: 'public.widgets', id: 'w1' },
      locals: locals(),
    } as never);

    expect(result).toMatchObject({ status: 409 });
    const data = (result as { data: { message: string } }).data;
    expect(data.message).toMatch(/unique|conflict|already in use/i);
    expect(h.adapter.delete).toHaveBeenCalledOnce();
  });

  it('re-throws a 5xx', async () => {
    h.adapter = throwingAdapter(503);
    await expect(
      detailActions.delete({
        params: { table: 'public.widgets', id: 'w1' },
        locals: locals(),
      } as never),
    ).rejects.toMatchObject({ status: 503 });
  });
});
