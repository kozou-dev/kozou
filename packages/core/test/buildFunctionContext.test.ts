import { describe, it, expect } from 'vitest';
import {
  buildFunctionContexts,
  type RpcBuildConfig,
} from '../src/buildFunctionContext.js';
import type { BuildIssue } from '../src/buildSchemaContext.js';
import type {
  RawEnum,
  RawFunction,
  RawFunctionArg,
  RawFunctionReturn,
  RawFunctionSearchPathElement,
} from '../src/types/raw.js';

// ---- builders -------------------------------------------------------------

function arg(overrides: Partial<RawFunctionArg> = {}): RawFunctionArg {
  return {
    name: 'order_id',
    typeName: 'uuid',
    udtName: 'uuid',
    typeOid: 2950,
    mode: 'in',
    hasDefault: false,
    ...overrides,
  };
}

function voidReturn(): RawFunctionReturn {
  return { kind: 'void', typeName: 'void', returnsSet: false };
}

function makeFn(overrides: Partial<RawFunction> = {}): RawFunction {
  return {
    schema: 'public',
    name: 'approve_order',
    argumentSignature: 'order_id uuid',
    arguments: [arg()],
    returns: voidReturn(),
    volatility: 'volatile',
    security: 'invoker',
    owner: { oid: 10, name: 'app_owner' },
    publicExecute: false,
    searchPath: null,
    comment: '@expose: rpc',
    ...overrides,
  };
}

/** `SET search_path = pg_catalog, pg_temp` — the canonical owner-safe form. */
function safeSearchPath(): RawFunctionSearchPathElement[] {
  return [
    { raw: 'pg_catalog', schema: 'pg_catalog', writableByOthers: false, isTemp: false },
    { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
  ];
}

function build(functions: RawFunction[], rpc?: RpcBuildConfig, enums: RawEnum[] = []) {
  const issues: BuildIssue[] = [];
  const result = buildFunctionContexts({ functions, enums, rpc, issues });
  return { result, issues };
}

// ---- exposure decision ----------------------------------------------------

describe('buildFunctionContexts — exposure decision', () => {
  it('an untagged function is not exposed and raises no issue', () => {
    const { result, issues } = build([makeFn({ comment: 'an internal helper' })]);
    expect(result).toEqual([]);
    expect(issues).toEqual([]);
  });

  it('exposes a tagged invoker function with PUBLIC EXECUTE revoked', () => {
    const { result, issues } = build([makeFn()]);
    expect(issues).toEqual([]);
    expect(result).toHaveLength(1);
    const fn = result[0]!;
    expect(fn.qualifiedName).toBe('public.approve_order');
    expect(fn.security).toBe('invoker');
    expect(fn.publicCallable).toBe(false);
    expect(fn.args.map((a) => a.name)).toEqual(['order_id']);
    expect(fn.returns.kind).toBe('void');
  });

  it('surfaces COMMENT body / @ai / @policy and derives label from the first line', () => {
    const fn = makeFn({
      comment: 'Approve an order.\n@ai: not idempotent\n@policy: admins only\n@expose: rpc',
    });
    const { result } = build([fn]);
    const ctx = result[0]!;
    expect(ctx.label).toBe('Approve an order.');
    expect(ctx.description).toBe('Approve an order.\n@ai: not idempotent\n@policy: admins only');
    expect(ctx.aiDescription).toBe('not idempotent');
    expect(ctx.policy).toEqual(['admins only']);
  });

  describe('PUBLIC EXECUTE', () => {
    it('hard-skips a tagged function that still grants PUBLIC EXECUTE', () => {
      const { result, issues } = build([makeFn({ publicExecute: true })]);
      expect(result).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toMatch(/EXECUTE to PUBLIC/);
    });

    it('exposes PUBLIC EXECUTE with @expose: rpc public override (publicCallable)', () => {
      const fn = makeFn({ publicExecute: true, comment: '@expose: rpc public' });
      const { result, issues } = build([fn]);
      expect(issues).toEqual([]);
      expect(result[0]!.publicCallable).toBe(true);
    });

    it('exposes PUBLIC EXECUTE with allowPublicExecute config override', () => {
      const fn = makeFn({ publicExecute: true });
      const { result } = build([fn], { allowPublicExecute: ['public.approve_order'] });
      expect(result).toHaveLength(1);
      expect(result[0]!.publicCallable).toBe(true);
    });
  });

  describe('SECURITY DEFINER double opt-in', () => {
    it('skips a definer function not listed in allowDefiner', () => {
      const { result, issues } = build([makeFn({ security: 'definer', searchPath: safeSearchPath() })]);
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/allowDefiner/);
    });

    it('exposes a definer in allowDefiner with an owner-safe search_path', () => {
      const fn = makeFn({ security: 'definer', searchPath: safeSearchPath() });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(issues).toEqual([]);
      expect(result).toHaveLength(1);
      expect(result[0]!.security).toBe('definer');
    });

    it('skips a definer (in allowDefiner) with no SET search_path', () => {
      const fn = makeFn({ security: 'definer', searchPath: null });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/no SET search_path/);
    });

    it('skips a definer whose search_path omits pg_temp', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: [
          { raw: 'pg_catalog', schema: 'pg_catalog', writableByOthers: false, isTemp: false },
        ],
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/pg_temp is not listed/);
    });

    it('skips a definer where pg_temp is not the last element', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: [
          { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
          { raw: 'pg_catalog', schema: 'pg_catalog', writableByOthers: false, isTemp: false },
        ],
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/pg_temp must appear exactly once and as the last/);
    });

    it('skips a definer whose search_path schema is writable by others', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: [
          { raw: 'public', schema: 'public', writableByOthers: true, isTemp: false },
          { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
        ],
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/writable by PUBLIC or a role other than the owner/);
    });

    it('fails closed when search_path writability is unknown', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: [
          { raw: 'app', schema: 'app', writableByOthers: null, isTemp: false },
          { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
        ],
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/cannot determine who may CREATE/);
    });

    it('fails closed when a search_path element does not resolve to a fixed schema', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: [
          { raw: '$user', schema: null, writableByOthers: null, isTemp: false },
          { raw: 'pg_temp', schema: null, writableByOthers: null, isTemp: true },
        ],
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/does not resolve to a fixed schema/);
    });

    it('a definer in allowDefiner still hard-skips on residual PUBLIC EXECUTE', () => {
      const fn = makeFn({
        security: 'definer',
        searchPath: safeSearchPath(),
        publicExecute: true,
      });
      const { result, issues } = build([fn], { allowDefiner: ['public.approve_order'] });
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/EXECUTE to PUBLIC/);
    });
  });

  describe('overloads and identity', () => {
    it('skips an entire overloaded set sharing schema.name and raises one issue', () => {
      const a = makeFn({ arguments: [arg({ name: 'order_id' })] });
      const b = makeFn({ arguments: [arg({ name: 'order_id' }), arg({ name: 'note', typeName: 'text', udtName: 'text' })] });
      const { result, issues } = build([a, b]);
      expect(result).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toMatch(/has 2 overloaded definitions/);
    });

    it('fails closed when a tagged function shares schema.name with an UNTAGGED overload', () => {
      // Postgres resolves a named-args call against every overload, ignoring
      // Kozou's tags, so the untagged sibling could be reached — expose none.
      const tagged = makeFn({ arguments: [arg({ name: 'order_id' })] });
      const untagged = makeFn({
        comment: 'an internal overload',
        arguments: [arg({ name: 'order_id' }), arg({ name: 'note', typeName: 'text', udtName: 'text' })],
      });
      const { result, issues } = build([tagged, untagged]);
      expect(result).toEqual([]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toMatch(/has 2 overloaded definitions/);
    });

    it('treats cross-schema same-name functions as distinct identities (no collision)', () => {
      const a = makeFn({ schema: 'public' });
      const b = makeFn({ schema: 'billing' });
      const { result, issues } = build([a, b]);
      expect(issues).toEqual([]);
      expect(result.map((f) => f.qualifiedName)).toEqual(['billing.approve_order', 'public.approve_order']);
    });

    it('sorts exposed functions by qualified name', () => {
      const a = makeFn({ name: 'zeta' });
      const b = makeFn({ name: 'alpha' });
      const { result } = build([a, b]);
      expect(result.map((f) => f.name)).toEqual(['alpha', 'zeta']);
    });

    it('reports a bare (not schema-qualified) allowlist entry as an issue', () => {
      const fn = makeFn({ security: 'definer', searchPath: safeSearchPath() });
      const { result, issues } = build([fn], { allowDefiner: ['approve_order'] });
      // The bare entry is dropped, so the definer is not authorized -> skipped.
      expect(result).toEqual([]);
      expect(issues.some((i) => /not a schema-qualified/.test(i.message))).toBe(true);
    });

    it('drops an ambiguous allowlist entry with extra dots (fails closed)', () => {
      const fn = makeFn({ security: 'definer', searchPath: safeSearchPath() });
      // "billing.approve.order" is ambiguous vs a quoted dotted identifier.
      const { result, issues } = build([fn], { allowDefiner: ['billing.approve.order'] });
      expect(result).toEqual([]);
      expect(issues.some((i) => /not a schema-qualified/.test(i.message))).toBe(true);
    });

    it('hard-skips a tagged function whose schema or name contains a dot', () => {
      const fn = makeFn({ name: 'approve.order' });
      const { result, issues } = build([fn]);
      expect(result).toEqual([]);
      expect(issues.some((i) => /the schema-qualified RPC identity .* would be ambiguous/.test(i.message))).toBe(true);
    });
  });

  describe('unsupported shapes', () => {
    it('skips a function with a VARIADIC argument', () => {
      const fn = makeFn({ arguments: [arg({ name: 'tags', typeName: 'text[]', udtName: '_text', mode: 'variadic' })] });
      const { result, issues } = build([fn]);
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/VARIADIC/);
    });

    it('skips a function with a polymorphic argument', () => {
      const fn = makeFn({ arguments: [arg({ name: 'val', typeName: 'anyelement', udtName: 'anyelement' })] });
      const { result, issues } = build([fn]);
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/polymorphic/);
    });

    it('skips a function with an unnamed argument', () => {
      const fn = makeFn({ arguments: [arg({ name: '' })] });
      const { result, issues } = build([fn]);
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/unnamed argument/);
    });

    it('skips a function whose return is classified unsupported', () => {
      const fn = makeFn({ returns: { kind: 'unsupported', typeName: 'record', returnsSet: false } });
      const { result, issues } = build([fn]);
      expect(result).toEqual([]);
      expect(issues[0]!.message).toMatch(/unsupported return shape/);
    });

    it('excludes OUT / TABLE columns from the input args', () => {
      const fn = makeFn({
        returns: {
          kind: 'setof',
          typeName: 'SETOF record',
          returnsSet: true,
          columns: [{ name: 'id', typeName: 'uuid', typeOid: 2950 }],
        },
        arguments: [
          arg({ name: 'order_id' }),
          arg({ name: 'id', typeName: 'uuid', udtName: 'uuid', mode: 'table' }),
        ],
      });
      const { result } = build([fn]);
      expect(result[0]!.args.map((a) => a.name)).toEqual(['order_id']);
      expect(result[0]!.returns.kind).toBe('setof');
      expect(result[0]!.returns.columns).toEqual([{ name: 'id', typeName: 'uuid' }]);
    });
  });
});

// ---- argument widget inference --------------------------------------------

describe('buildFunctionContexts — argument widgets', () => {
  it('infers a scalar widget from the argument type (uuid -> uuid)', () => {
    const { result } = build([makeFn()]);
    expect(result[0]!.args[0]!.widget).toBe('uuid');
  });

  it('infers enum-select and attaches members for an ENUM-typed argument', () => {
    const fn = makeFn({
      arguments: [arg({ name: 'status', typeName: 'public.order_status', udtName: 'order_status', typeOid: 99999 })],
    });
    const enums: RawEnum[] = [{ schema: 'public', name: 'order_status', values: ['pending', 'shipped'] }];
    const { result } = build([fn], undefined, enums);
    const argCtx = result[0]!.args[0]!;
    expect(argCtx.widget).toBe('enum-select');
    expect(argCtx.enumValues).toEqual(['pending', 'shipped']);
  });

  it('uses relation-select from an @arg relation hint, defaulting the schema', () => {
    const fn = makeFn({ comment: '@arg: order_id relation(orders.id)\n@expose: rpc' });
    const { result } = build([fn]);
    const argCtx = result[0]!.args[0]!;
    expect(argCtx.widget).toBe('relation-select');
    expect(argCtx.relation).toEqual({ schema: 'public', table: 'orders', column: 'id' });
  });

  it('honors a fully-qualified @arg relation ref', () => {
    const fn = makeFn({ comment: '@arg: order_id relation(billing.orders.id)\n@expose: rpc' });
    const { result } = build([fn]);
    expect(result[0]!.args[0]!.relation).toEqual({ schema: 'billing', table: 'orders', column: 'id' });
  });

  it('lets an explicit @arg widget hint override type-based inference', () => {
    const fn = makeFn({
      arguments: [arg({ name: 'note', typeName: 'text', udtName: 'text' })],
      comment: '@arg: note widget(textarea)\n@expose: rpc',
    });
    const { result } = build([fn]);
    expect(result[0]!.args[0]!.widget).toBe('textarea');
  });

  it('raises a non-fatal issue for an @arg hint naming a missing argument', () => {
    const fn = makeFn({ comment: '@arg: nonexistent relation(orders.id)\n@expose: rpc' });
    const { result, issues } = build([fn]);
    // Still exposed; the orphan hint is reported, not silently dropped.
    expect(result).toHaveLength(1);
    expect(issues.some((i) => /references argument "nonexistent"/.test(i.message))).toBe(true);
  });

  it('reflects DEFAULT on the argument context', () => {
    const fn = makeFn({ arguments: [arg({ name: 'qty', typeName: 'integer', udtName: 'int4', hasDefault: true })] });
    const { result } = build([fn]);
    expect(result[0]!.args[0]!.hasDefault).toBe(true);
    expect(result[0]!.args[0]!.widget).toBe('number');
  });
});
