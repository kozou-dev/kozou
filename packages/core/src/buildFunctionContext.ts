// The RPC exposure decision (issue #103) and the
// shaping of an exposed function into a FunctionContext.
//
// Input is the raw functions pulled from pg_proc (@kozou/introspect) plus the
// operator's deploy-time RPC config. Output is the set of functions that pass
// every guard, ready for the surfaces (REST / OpenAPI / MCP / Admin UI). A
// function tagged `@expose: rpc` that fails a guard is NOT exposed and is
// reported as a build issue instead (loud skip — "you tagged it but it does not
// appear", no silent gap). A function with no `@expose` tag is simply
// absent (the default, not an issue).
//
// The guards, in order:
//   1. overload collision — two+ tagged functions share `schema.name`
//   2. unsupported argument — VARIADIC / polymorphic / unnamed
//   3. unsupported return — `kind: 'unsupported'` from introspect
//   4. SECURITY DEFINER — must be in `allowDefiner` AND have an owner-safe
//      search_path (the double opt-in)
//   5. PUBLIC EXECUTE — the CREATE FUNCTION default grant is a hard skip unless
//      intentionally overridden (`@expose: rpc public` / `allowPublicExecute`)

import type {
  RawEnum,
  RawFunction,
  RawFunctionArg,
  RawFunctionReturn,
} from './types/raw.js';
import type {
  FunctionArgContext,
  FunctionContext,
  FunctionReturnContext,
  WidgetType,
} from './types/context.js';
import type { BuildIssue } from './buildSchemaContext.js';
import type { ParsedComment } from './parseCommentTags.js';
import { parseCommentTags } from './parseCommentTags.js';
import { inferWidget } from './widget.js';

/** Deploy-time RPC config. Both lists hold schema-qualified
 *  function names (`schema.function`); a bare name is ambiguous and reported as
 *  a build issue. Sourced from `api.rpc.*` in kozou.config.yaml. */
export type RpcBuildConfig = {
  /** `security definer` functions the operator has authorized for exposure —
   *  the deploy-time half of the double opt-in. */
  allowDefiner?: string[];
  /** Functions allowed to keep PUBLIC EXECUTE (intentional public-callable).
   *  `@expose: rpc public` is the per-function tag equivalent. */
  allowPublicExecute?: string[];
};

// PostgreSQL polymorphic pseudo-types. A function taking one of these resolves
// its argument types at call time, which v1 does not model — loud skip.
const POLYMORPHIC_TYPES: ReadonlySet<string> = new Set([
  'anyelement',
  'anyarray',
  'anynonarray',
  'anyenum',
  'anyrange',
  'anymultirange',
  'anycompatible',
  'anycompatiblearray',
  'anycompatiblenonarray',
  'anycompatiblerange',
  'anycompatiblemultirange',
]);

/** True for an argument that is part of the call's input (so it appears in the
 *  named-args body). OUT (`out`) and RETURNS TABLE columns (`table`) are
 *  return-side and excluded. */
function isInputArg(arg: RawFunctionArg): boolean {
  return arg.mode === 'in' || arg.mode === 'inout' || arg.mode === 'variadic';
}

/** Validate an allowlist: every entry must be a schema-qualified name of
 *  exactly the form `schema.function`, with both parts non-empty and no extra
 *  dot. A bare name is ambiguous (which schema?); an entry with two+
 *  dots is ambiguous against a quoted identifier that itself contains a dot, so
 *  it could authorize the wrong function — both are dropped with a build issue
 *  rather than matched loosely (fail-closed for the definer / PUBLIC gates).
 *  Returns the set of valid entries. */
function normalizeAllowlist(
  entries: string[] | undefined,
  configKey: string,
  issues: BuildIssue[],
): Set<string> {
  const set = new Set<string>();
  if (entries === undefined) return set;
  for (const entry of entries) {
    const parts = entry.split('.');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      issues.push({
        path: `rpc.${configKey}`,
        message:
          `"${entry}" is not a schema-qualified function name ` +
          '(expected exactly "schema.function"); ignored.',
      });
      continue;
    }
    set.add(entry);
  }
  return set;
}

/** The owner-relative safe-search_path predicate for `security definer`
 *  functions. A definer function runs as its owner, so an
 *  unqualified name resolved through a schema that someone else can write to
 *  can be hijacked. Safe requires: a declared search_path; `pg_temp` present
 *  exactly once and last (else the temp schema is searched implicitly first);
 *  and every other element a schema only the owner may CREATE in. Anything
 *  unresolvable is unsafe (fail-closed). */
function checkSafeSearchPath(fn: RawFunction): { safe: boolean; reason: string } {
  const sp = fn.searchPath;
  if (sp === null || sp.length === 0) {
    return { safe: false, reason: 'no SET search_path is declared' };
  }
  const tempCount = sp.filter((e) => e.isTemp).length;
  if (tempCount === 0) {
    return {
      safe: false,
      reason: 'pg_temp is not listed, so the session temp schema is searched implicitly first',
    };
  }
  if (tempCount > 1 || !sp[sp.length - 1]!.isTemp) {
    return { safe: false, reason: 'pg_temp must appear exactly once and as the last element' };
  }
  for (const el of sp) {
    if (el.isTemp) continue;
    if (el.schema === null) {
      return { safe: false, reason: `element "${el.raw}" does not resolve to a fixed schema` };
    }
    if (el.writableByOthers === null) {
      return { safe: false, reason: `cannot determine who may CREATE in schema "${el.schema}"` };
    }
    if (el.writableByOthers === true) {
      return {
        safe: false,
        reason: `schema "${el.schema}" is writable by PUBLIC or a role other than the owner`,
      };
    }
  }
  return { safe: true, reason: '' };
}

/** Build a synthetic RawColumn so argument widget inference reuses the exact
 *  column heuristics (`inferWidget`). Arguments are not foreign keys, so a
 *  relation-select only comes from an `@arg` relation hint, handled in
 *  `buildArg`; here we only need name + udtName for the type-based path. */
function inferArgWidget(arg: RawFunctionArg, enumValues: string[] | null): WidgetType {
  return inferWidget({
    column: {
      name: arg.name,
      dataType: arg.typeName,
      udtName: arg.udtName,
      nullable: true,
      defaultExpr: null,
      comment: null,
      position: 0,
    },
    isForeignKey: false,
    relationSelectable: false,
    enumValues,
    commentBody: '',
  });
}

/** ENUM members for a type, matched by type name (`udtName`), preferring the
 *  given schema when an enum name is reused across schemas. Shared by the
 *  function-argument path and the table/view column path so a native ENUM
 *  resolves to its members the same way everywhere. */
export function findEnumValues(
  enums: RawEnum[],
  udtName: string,
  schema: string,
): string[] | undefined {
  const match =
    enums.find((e) => e.name === udtName && e.schema === schema) ??
    enums.find((e) => e.name === udtName);
  return match?.values;
}

function buildArg(
  arg: RawFunctionArg,
  parsed: ParsedComment,
  fnSchema: string,
  enums: RawEnum[],
): FunctionArgContext {
  const hint = parsed.args.find((h) => h.name === arg.name);
  const relation = hint?.relation
    ? {
        // A 2-part ref (`table.col`) defaults its schema to the function's.
        schema: hint.relation.schema ?? fnSchema,
        table: hint.relation.table,
        column: hint.relation.column,
      }
    : undefined;
  const enumValues = findEnumValues(enums, arg.udtName, fnSchema);

  // Widget order: explicit @arg widget hint > relation-select (relation hint) >
  // type-based inference (enum-select for an ENUM, else a scalar widget).
  let widget: WidgetType;
  if (hint?.widget) {
    widget = hint.widget;
  } else if (relation) {
    widget = 'relation-select';
  } else {
    widget = inferArgWidget(arg, enumValues ?? null);
  }

  return {
    name: arg.name,
    typeName: arg.typeName,
    hasDefault: arg.hasDefault,
    ...(enumValues ? { enumValues } : {}),
    ...(relation ? { relation } : {}),
    widget,
  };
}

function mapReturn(r: RawFunctionReturn): FunctionReturnContext {
  // 'unsupported' is gated before this is reached; the fallback keeps the type
  // total without inventing a misleading shape.
  const kind = r.kind === 'unsupported' ? 'void' : r.kind;
  return {
    kind,
    typeName: r.typeName,
    ...(r.columns
      ? { columns: r.columns.map((c) => ({ name: c.name, typeName: c.typeName })) }
      : {}),
  };
}

function decideAndBuild(input: {
  fn: RawFunction;
  parsed: ParsedComment;
  qualifiedName: string;
  enums: RawEnum[];
  allowDefiner: Set<string>;
  allowPublicExecute: Set<string>;
  issues: BuildIssue[];
}): FunctionContext | null {
  const { fn, parsed, qualifiedName, enums, allowDefiner, allowPublicExecute, issues } = input;
  const skip = (message: string): null => {
    issues.push({ path: `functions.${qualifiedName}`, message: `"${qualifiedName}" ${message}` });
    return null;
  };

  const inputArgs = fn.arguments.filter(isInputArg);

  // (2) unsupported arguments
  for (const arg of inputArgs) {
    if (arg.mode === 'variadic') {
      return skip(`has a VARIADIC argument ("${arg.name}"), unsupported in v1; not exposed.`);
    }
    if (arg.name === '') {
      return skip(
        'has an unnamed argument; the named-args RPC body requires names, so it is not exposed.',
      );
    }
    if (POLYMORPHIC_TYPES.has(arg.udtName)) {
      return skip(
        `has a polymorphic argument ("${arg.name}" ${arg.typeName}), unsupported in v1; not exposed.`,
      );
    }
  }

  // (3) unsupported return
  if (fn.returns.kind === 'unsupported') {
    return skip(
      `returns "${fn.returns.typeName}", an unsupported return shape in v1 ` +
        '(OUT/INOUT composite, record, or polymorphic); not exposed.',
    );
  }

  // (4) SECURITY DEFINER double opt-in + safe search_path
  if (fn.security === 'definer') {
    if (!allowDefiner.has(qualifiedName)) {
      return skip(
        'is SECURITY DEFINER and tagged @expose: rpc, but is not listed in api.rpc.allowDefiner; ' +
          'not exposed (the operator must opt in to a privilege-bypassing endpoint).',
      );
    }
    const sp = checkSafeSearchPath(fn);
    if (!sp.safe) {
      return skip(
        `is SECURITY DEFINER but its search_path is not owner-safe (${sp.reason}); ` +
          'not exposed. Declare SET search_path with owner-only schemas and a trailing pg_temp.',
      );
    }
  }

  // (5) PUBLIC EXECUTE — the default grant is a hard skip unless overridden
  let publicCallable = false;
  if (fn.publicExecute) {
    const overridden =
      parsed.expose === 'rpc-public' || allowPublicExecute.has(qualifiedName);
    if (!overridden) {
      return skip(
        'still grants EXECUTE to PUBLIC (the CREATE FUNCTION default); not exposed. ' +
          'REVOKE EXECUTE FROM PUBLIC and GRANT it to the intended role, or declare the public ' +
          'endpoint intentional with @expose: rpc public / api.rpc.allowPublicExecute.',
      );
    }
    publicCallable = true;
  }

  const args = inputArgs.map((arg) => buildArg(arg, parsed, fn.schema, enums));

  // An @arg hint naming a non-existent argument is a loud (non-fatal) issue —
  // the function is still exposed, but the typo would otherwise vanish silently
  // (mirrors how UIHints reports a column that does not exist).
  const inputArgNames = new Set(inputArgs.map((a) => a.name));
  for (const hint of parsed.args) {
    if (!inputArgNames.has(hint.name)) {
      issues.push({
        path: `functions.${qualifiedName}.args.${hint.name}`,
        message: `@arg hint references argument "${hint.name}", which "${qualifiedName}" does not have; ignored.`,
      });
    }
  }

  const body = parsed.body !== '' ? parsed.body : null;
  const label = body !== null ? body.split('\n')[0]!.trim() : fn.name;

  return {
    schema: fn.schema,
    name: fn.name,
    qualifiedName,
    label,
    description: body,
    aiDescription: parsed.ai.length > 0 ? parsed.ai.join('\n') : null,
    policy: parsed.policy,
    args,
    returns: mapReturn(fn.returns),
    volatility: fn.volatility,
    security: fn.security,
    publicCallable,
    rawFunction: fn,
  };
}

/** Decide which functions are exposed as RPC actions and shape them into
 *  FunctionContexts. Skipped-but-tagged functions are pushed
 *  onto `issues`. Output is sorted by qualified name for stable surfaces. */
export function buildFunctionContexts(input: {
  functions: RawFunction[];
  enums: RawEnum[];
  rpc: RpcBuildConfig | undefined;
  issues: BuildIssue[];
}): FunctionContext[] {
  const { functions, enums, issues } = input;
  const allowDefiner = normalizeAllowlist(input.rpc?.allowDefiner, 'allowDefiner', issues);
  const allowPublicExecute = normalizeAllowlist(
    input.rpc?.allowPublicExecute,
    'allowPublicExecute',
    issues,
  );

  // Parse every comment and group ALL functions — tagged or not — by their
  // (flattened) `schema.name`. Grouping must include untagged overloads: the
  // RPC surface addresses a function by `schema.name` alone (no body-key
  // disambiguation), but a named-args call is resolved by PostgreSQL
  // against *every* overload of that name, ignoring Kozou's tags. So if a
  // `schema.name` has more than one definition and any of them is tagged, the
  // exposed identity is ambiguous — Postgres could route the call to a sibling
  // overload the operator never opted into (including an untagged, possibly
  // SECURITY DEFINER / RLS-bypassing one), or fail as not-unique. The only way
  // a `schema.name` maps to exactly one definition is for there to be exactly
  // one, so any tagged overload set fails closed (expose none + one issue).
  // This is stricter than the design's "expose only one" wording on purpose;
  // tagging one of several does not change Postgres overload resolution.
  type Entry = { fn: RawFunction; parsed: ParsedComment };
  const byQualified = new Map<string, Entry[]>();
  for (const fn of functions) {
    const parsed = parseCommentTags(fn.comment);
    const q = `${fn.schema}.${fn.name}`;
    const group = byQualified.get(q);
    if (group) group.push({ fn, parsed });
    else byQualified.set(q, [{ fn, parsed }]);
  }

  const result: FunctionContext[] = [];
  for (const [qualifiedName, group] of byQualified) {
    // An identity with no tagged member is simply not exposed (the untagged
    // majority: triggers, RLS predicates, internal helpers) — no issue.
    if (!group.some((e) => e.parsed.expose !== 'none')) continue;

    // (1) overload collision: the identity has >1 definition and at least one
    // is tagged. Expose none of them. cross-schema same-name is a
    // distinct identity and does not collide.
    if (group.length > 1) {
      issues.push({
        path: `functions.${qualifiedName}`,
        message:
          `"${qualifiedName}" has ${group.length} overloaded definitions and at least one is ` +
          'tagged for RPC exposure; v1 cannot disambiguate overloads by signature, so none are ' +
          'exposed. Rename the overloads or keep a single definition for this name.',
      });
      continue;
    }

    // The canonical identity is the dotted string `schema.name`, shared by the
    // REST path, OpenAPI operationId, MCP tool name, and config entries.
    // A dot inside a (quoted) schema or function name makes that string
    // non-injective — `"a.b".c` and `a."b.c"` both flatten to `a.b.c`, so an
    // `allowDefiner` / `allowPublicExecute` entry could authorize the wrong
    // function. Such a name cannot be expressed unambiguously, so it fails
    // closed (loud skip).
    const entry = group[0]!;
    if (entry.fn.schema.includes('.') || entry.fn.name.includes('.')) {
      issues.push({
        path: `functions.${entry.fn.schema}.${entry.fn.name}`,
        message:
          `"${entry.fn.schema}"."${entry.fn.name}" has a "." in its schema or name; ` +
          'the schema-qualified RPC identity (schema.function) would be ambiguous, so it is not exposed.',
      });
      continue;
    }

    const ctx = decideAndBuild({
      fn: entry.fn,
      parsed: entry.parsed,
      qualifiedName,
      enums,
      allowDefiner,
      allowPublicExecute,
      issues,
    });
    if (ctx !== null) result.push(ctx);
  }

  result.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  return result;
}
