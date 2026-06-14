import { describe, it, expect } from 'vitest';
import { buildFunctionLookup, buildRpcCall, shapeRpcResult, RpcInputError } from '../src/rpc.js';
import type {
  FunctionArgContext,
  FunctionContext,
  FunctionReturnContext,
  SchemaContext,
} from '../src/types/context.js';

// Minimal fixtures: only the fields the RPC core reads (qualifiedName, schema,
// name, args[{name,hasDefault}], returns).
function arg(name: string, extra: Partial<FunctionArgContext> = {}): FunctionArgContext {
  return { name, typeName: 'text', hasDefault: false, widget: 'text', ...extra };
}

function fn(
  name: string,
  opts: { schema?: string; args?: FunctionArgContext[]; returns?: FunctionReturnContext } = {},
): FunctionContext {
  const schema = opts.schema ?? 'public';
  return {
    schema,
    name,
    qualifiedName: `${schema}.${name}`,
    label: name,
    description: null,
    aiDescription: null,
    args: opts.args ?? [],
    returns: opts.returns ?? { kind: 'void', typeName: 'void' },
    volatility: 'volatile',
    security: 'invoker',
    publicCallable: false,
    rawFunction: {} as FunctionContext['rawFunction'],
  };
}

function schemaWith(functions: FunctionContext[]): SchemaContext {
  return { functions } as unknown as SchemaContext;
}

describe('buildFunctionLookup', () => {
  it('resolves exposed functions by their schema-qualified identity only', () => {
    const lookup = buildFunctionLookup(
      schemaWith([fn('approve_order'), fn('settle', { schema: 'billing' })]),
    );
    expect(lookup.list()).toEqual(['billing.settle', 'public.approve_order']);
    expect(lookup.resolve('public.approve_order')?.name).toBe('approve_order');
    expect(lookup.resolve('billing.settle')?.name).toBe('settle');
    // No bare-name alias — the qualified name is the only addressable form.
    expect(lookup.resolve('approve_order')).toBeUndefined();
  });

  it('is empty when the schema exposes no functions', () => {
    expect(buildFunctionLookup(schemaWith([])).list()).toEqual([]);
    // Tolerates a schema with no functions array at all.
    expect(buildFunctionLookup({} as unknown as SchemaContext).list()).toEqual([]);
  });
});

describe('buildRpcCall — pre-flight', () => {
  const f = fn('approve_order', {
    args: [arg('order_id', { typeName: 'uuid', widget: 'uuid' }), arg('note', { hasDefault: true })],
    returns: { kind: 'void', typeName: 'void' },
  });

  it('rejects an unknown argument with an RpcInputError', () => {
    expect(() => buildRpcCall(f, { order_id: 'x', bogus: 1 })).toThrowError(/Unknown argument "bogus"/);
    expect(() => buildRpcCall(f, { order_id: 'x', bogus: 1 })).toThrowError(RpcInputError);
  });

  it('rejects a missing required argument with an RpcInputError', () => {
    expect(() => buildRpcCall(f, { note: 'hi' })).toThrowError(/Missing required argument "order_id"/);
    expect(() => buildRpcCall(f, { note: 'hi' })).toThrowError(RpcInputError);
  });

  it('allows omitting a DEFAULT argument', () => {
    const built = buildRpcCall(f, { order_id: 'abc' });
    expect(built.values).toEqual(['abc']);
    expect(built.text).toContain('"order_id" => $1');
    expect(built.text).not.toContain('note');
  });
});

describe('buildRpcCall — named-args call + value binding', () => {
  it('builds quoted named args in declaration order, values bound', () => {
    const f = fn('do_thing', {
      args: [arg('a', { typeName: 'integer' }), arg('b')],
      returns: { kind: 'scalar', typeName: 'integer' },
    });
    // Body order is irrelevant; declaration order drives the $n assignment.
    const built = buildRpcCall(f, { b: 'second', a: 1 });
    expect(built.values).toEqual([1, 'second']);
    expect(built.text).toContain('"public"."do_thing"("a" => $1, "b" => $2)');
  });

  it('builds a zero-argument call from an empty body', () => {
    const built = buildRpcCall(fn('ping', { returns: { kind: 'scalar', typeName: 'integer' } }), {});
    expect(built.values).toEqual([]);
    expect(built.text).toContain('"public"."ping"()');
  });
});

describe('buildRpcCall — SELECT form per return kind', () => {
  const callFor = (returns: FunctionReturnContext): string => buildRpcCall(fn('f', { returns }), {}).text;

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
