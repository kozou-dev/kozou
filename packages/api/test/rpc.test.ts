import { describe, it, expect } from 'vitest';
import {
  buildFunctionLookup,
  buildRpcCall,
  shapeRpcResult,
} from '../src/rpc.js';
import { KozouApiError } from '../src/errors.js';
import type { FunctionReturnContext } from '@kozou/core';
import { functionContext, fnArg, schemaOf } from './helpers.js';

describe('buildFunctionLookup', () => {
  it('resolves exposed functions by their schema-qualified identity only', () => {
    const schema = schemaOf([], [], [
      functionContext('approve_order'),
      functionContext('settle', { schema: 'billing' }),
    ]);
    const lookup = buildFunctionLookup(schema);
    expect(lookup.list()).toEqual(['billing.settle', 'public.approve_order']);
    expect(lookup.resolve('public.approve_order')?.name).toBe('approve_order');
    expect(lookup.resolve('billing.settle')?.name).toBe('settle');
    // No bare-name alias — the qualified name is the only addressable form.
    expect(lookup.resolve('approve_order')).toBeUndefined();
  });

  it('is empty when the schema exposes no functions', () => {
    expect(buildFunctionLookup(schemaOf([])).list()).toEqual([]);
  });
});

describe('buildRpcCall — pre-flight', () => {
  const fn = functionContext('approve_order', {
    args: [fnArg('order_id', 'uuid', { widget: 'uuid' }), fnArg('note', 'text', { hasDefault: true })],
    returns: { kind: 'void', typeName: 'void' },
  });

  it('rejects an unknown argument with 400', () => {
    expect(() => buildRpcCall(fn, { order_id: 'x', bogus: 1 })).toThrowError(
      /Unknown argument "bogus"/,
    );
    try {
      buildRpcCall(fn, { order_id: 'x', bogus: 1 });
    } catch (e) {
      expect((e as KozouApiError).status).toBe(400);
    }
  });

  it('rejects a missing required argument with 400', () => {
    expect(() => buildRpcCall(fn, { note: 'hi' })).toThrowError(/Missing required argument "order_id"/);
  });

  it('allows omitting a DEFAULT argument', () => {
    const built = buildRpcCall(fn, { order_id: 'abc' });
    expect(built.values).toEqual(['abc']);
    expect(built.text).toContain('"order_id" => $1');
    expect(built.text).not.toContain('note');
  });
});

describe('buildRpcCall — named-args call + value binding', () => {
  it('builds quoted named args in declaration order, values bound', () => {
    const fn = functionContext('do_thing', {
      args: [fnArg('a', 'integer'), fnArg('b', 'text')],
      returns: { kind: 'scalar', typeName: 'integer' },
    });
    // Body order is irrelevant; declaration order drives the $n assignment.
    const built = buildRpcCall(fn, { b: 'second', a: 1 });
    expect(built.values).toEqual([1, 'second']);
    expect(built.text).toContain('"public"."do_thing"("a" => $1, "b" => $2)');
  });

  it('builds a zero-argument call from an empty body', () => {
    const fn = functionContext('ping', { returns: { kind: 'scalar', typeName: 'integer' } });
    const built = buildRpcCall(fn, {});
    expect(built.values).toEqual([]);
    expect(built.text).toContain('"public"."ping"()');
  });
});

describe('buildRpcCall — SELECT form per return kind', () => {
  const callFor = (returns: FunctionReturnContext): string =>
    buildRpcCall(functionContext('f', { returns }), {}).text;

  it('void: scalar-position call, result discarded', () => {
    expect(callFor({ kind: 'void', typeName: 'void' })).toBe('SELECT "public"."f"()');
  });

  it('scalar: aliased single column', () => {
    expect(callFor({ kind: 'scalar', typeName: 'integer' })).toBe(
      'SELECT * FROM "public"."f"() AS _rpc("result")',
    );
  });

  it('composite: row columns', () => {
    expect(
      callFor({ kind: 'composite', typeName: 'point', columns: [{ name: 'x', typeName: 'int' }] }),
    ).toBe('SELECT * FROM "public"."f"() AS _rpc');
  });

  it('setof with columns: row columns', () => {
    expect(
      callFor({ kind: 'setof', typeName: 'SETOF t', columns: [{ name: 'id', typeName: 'uuid' }] }),
    ).toBe('SELECT * FROM "public"."f"() AS _rpc');
  });

  it('setof scalar (no columns): aliased single column', () => {
    expect(callFor({ kind: 'setof', typeName: 'SETOF integer' })).toBe(
      'SELECT * FROM "public"."f"() AS _rpc("result")',
    );
  });
});

describe('shapeRpcResult — wire form', () => {
  it('void -> 204 with no body', () => {
    expect(shapeRpcResult({ kind: 'void', typeName: 'void' }, [])).toEqual({
      status: 204,
      body: undefined,
    });
  });

  it('scalar -> the bare value', () => {
    expect(shapeRpcResult({ kind: 'scalar', typeName: 'integer' }, [{ result: 7 }])).toEqual({
      status: 200,
      body: 7,
    });
  });

  it('scalar -> null when the function returned NULL', () => {
    expect(shapeRpcResult({ kind: 'scalar', typeName: 'text' }, [{ result: null }])).toEqual({
      status: 200,
      body: null,
    });
  });

  it('composite -> the row object', () => {
    const returns: FunctionReturnContext = {
      kind: 'composite',
      typeName: 'point',
      columns: [{ name: 'x', typeName: 'int' }],
    };
    expect(shapeRpcResult(returns, [{ x: 1, y: 2 }])).toEqual({ status: 200, body: { x: 1, y: 2 } });
  });

  it('setof with columns -> array of objects', () => {
    const returns: FunctionReturnContext = {
      kind: 'setof',
      typeName: 'SETOF t',
      columns: [{ name: 'id', typeName: 'uuid' }],
    };
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(shapeRpcResult(returns, rows)).toEqual({ status: 200, body: rows });
  });

  it('setof scalar -> array of bare values', () => {
    expect(
      shapeRpcResult({ kind: 'setof', typeName: 'SETOF integer' }, [{ result: 1 }, { result: 2 }]),
    ).toEqual({ status: 200, body: [1, 2] });
  });
});
