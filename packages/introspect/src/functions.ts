import type { Client } from 'pg';
import type {
  RawFunction,
  RawFunctionArg,
  RawFunctionReturn,
  RawFunctionSearchPathElement,
} from '@kozou/core';
import { runQuery } from './errors.js';

// Function introspection for the RPC surface (issue #103).
// Reads pg_proc for the metadata the @kozou/core exposure decision needs:
// structured arguments, a classified return shape, volatility, security,
// owner, whether PUBLIC retains EXECUTE (the CREATE FUNCTION default grant),
// and the declared SET search_path with owner-relative writability per element
// (the input to the SECURITY DEFINER safe-search_path predicate).
//
// Only ordinary functions (`prokind = 'f'`) in the target schemas are pulled;
// aggregates / window functions / procedures are out of scope for v1. @core
// decides exposure from the COMMENT tag and these fields, so introspect emits
// every function (the tag is not visible here) and stays cheap.

type RawArgJson = {
  name: string;
  typeName: string;
  udtName: string;
  typeOid: number;
  // proargmodes char: i=IN, o=OUT, b=INOUT, v=VARIADIC, t=TABLE column.
  mode: string;
  ord: number;
};

type RawReturnColumnJson = { name: string; typeName: string; typeOid: number };

type FunctionRow = {
  schema: string;
  name: string;
  argument_signature: string;
  args: RawArgJson[] | null;
  ndef: number;
  // provolatile char: i=immutable, s=stable, v=volatile.
  volatility: string;
  security_definer: boolean;
  owner_oid: number;
  owner_name: string;
  public_execute: boolean;
  comment: string | null;
  returns_void: boolean;
  returns_set: boolean;
  return_type: string;
  // pg_type.typtype of the return type: c=composite, b=base, e=enum, d=domain,
  // r=range, m=multirange, p=pseudo.
  return_typtype: string;
  return_columns: RawReturnColumnJson[] | null;
  proconfig: string[] | null;
};

// One query pulls every ordinary function with its arguments (resolved to type
// names), return classification fields, owner, PUBLIC-EXECUTE flag, and the raw
// proconfig. Arguments are assembled as JSON by zipping the parallel pg_proc
// arrays (proallargtypes / proargmodes / proargnames) by ordinality; the
// IN-only case falls back to proargtypes (an oidvector cast to oid[]). Return
// columns come from the composite type's attributes when the return is a named
// composite, else from the OUT / TABLE arguments.
const FUNCTIONS_SQL = `
  SELECT
    n.nspname AS schema,
    p.proname AS name,
    pg_get_function_arguments(p.oid) AS argument_signature,
    p.pronargdefaults AS ndef,
    p.provolatile AS volatility,
    p.prosecdef AS security_definer,
    p.proowner AS owner_oid,
    ro.rolname AS owner_name,
    CASE
      WHEN p.proacl IS NULL THEN true
      WHEN EXISTS (
        SELECT 1 FROM aclexplode(p.proacl) ae
        WHERE ae.grantee = 0 AND ae.privilege_type = 'EXECUTE'
      ) THEN true
      ELSE false
    END AS public_execute,
    obj_description(p.oid, 'pg_proc') AS comment,
    (p.prorettype = 'pg_catalog.void'::regtype) AS returns_void,
    p.proretset AS returns_set,
    format_type(p.prorettype, NULL) AS return_type,
    -- Resolve one level of DOMAIN to its base type so a domain over a composite
    -- is not mistaken for a scalar (and a domain over a scalar stays scalar). A
    -- still-domain result (domain over domain) is left as 'd' and treated as
    -- unsupported downstream (fail-closed for that exotic nesting).
    eff.eff_typtype AS return_typtype,
    (
      SELECT json_agg(json_build_object(
        'name', COALESCE(an.argname, ''),
        'typeName', format_type(at.typeoid, NULL),
        'udtName', t.typname,
        'typeOid', at.typeoid::int,
        'mode', COALESCE(am.mode, 'i'),
        'ord', at.ord
      ) ORDER BY at.ord)
      FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
        WITH ORDINALITY AS at(typeoid, ord)
      LEFT JOIN unnest(p.proargmodes) WITH ORDINALITY AS am(mode, ord) ON am.ord = at.ord
      LEFT JOIN unnest(p.proargnames) WITH ORDINALITY AS an(argname, ord) ON an.ord = at.ord
      JOIN pg_type t ON t.oid = at.typeoid
    ) AS args,
    CASE
      WHEN eff.eff_typrelid <> 0 THEN (
        SELECT json_agg(json_build_object(
          'name', a.attname,
          'typeName', format_type(a.atttypid, a.atttypmod),
          'typeOid', a.atttypid::int
        ) ORDER BY a.attnum)
        FROM pg_attribute a
        WHERE a.attrelid = eff.eff_typrelid AND a.attnum > 0 AND NOT a.attisdropped
      )
      ELSE (
        SELECT json_agg(json_build_object(
          'name', COALESCE(an.argname, ''),
          'typeName', format_type(at.typeoid, NULL),
          'typeOid', at.typeoid::int
        ) ORDER BY at.ord)
        FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]))
          WITH ORDINALITY AS at(typeoid, ord)
        JOIN unnest(p.proargmodes) WITH ORDINALITY AS am(mode, ord) ON am.ord = at.ord
        LEFT JOIN unnest(p.proargnames) WITH ORDINALITY AS an(argname, ord) ON an.ord = at.ord
        WHERE am.mode IN ('o', 'b', 't')
      )
    END AS return_columns,
    p.proconfig AS proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles ro ON ro.oid = p.proowner
  JOIN pg_type rt ON rt.oid = p.prorettype
  LEFT JOIN pg_type bt ON bt.oid = rt.typbasetype
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN rt.typtype = 'd' AND bt.oid IS NOT NULL THEN bt.typtype ELSE rt.typtype END
        AS eff_typtype,
      CASE WHEN rt.typtype = 'd' AND bt.oid IS NOT NULL THEN bt.typrelid ELSE rt.typrelid END
        AS eff_typrelid
  ) eff
  WHERE p.prokind = 'f'
    AND n.nspname = ANY($1)
  ORDER BY n.nspname, p.proname`;

type SchemaWritabilityRow = {
  schema: string;
  // Whether PUBLIC holds CREATE on the schema (so any role, incl. ones created
  // later, could write there). Read from the ACL directly so it is caught even
  // when the function owner is the only non-superuser role today.
  public_create: boolean;
  // Non-superuser roles that can CREATE in the schema, via `has_schema_privilege`
  // — which natively resolves direct grants, grants inherited through role
  // membership (incl. through a superuser role), PUBLIC, and ownership. The
  // owner-relative comparison (any creator other than the function's own owner?)
  // is done in @kozou/core.
  creator_roles: number[] | null;
};

// Who may CREATE in each named schema, framed for the owner-safe search_path
// predicate. Superusers are deliberately not enumerated as creators:
// a superuser bypasses every ACL and can replace the definer function itself,
// so it is not a hijack vector — and this is what makes pg_catalog (owned by
// the bootstrap superuser) correctly safe. Inherited privileges are NOT lost,
// because `has_schema_privilege` is evaluated per non-superuser role: a
// non-superuser member that inherits a superuser role's CREATE grant still
// reports true and is captured.
const SCHEMA_WRITABILITY_SQL = `
  SELECT
    n.nspname AS schema,
    EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) ae
      WHERE ae.privilege_type = 'CREATE' AND ae.grantee = 0
    ) AS public_create,
    COALESCE((
      SELECT array_agg(r.oid)
      FROM pg_roles r
      WHERE NOT r.rolsuper
        AND has_schema_privilege(r.oid, n.oid, 'CREATE')
    ), ARRAY[]::oid[]) AS creator_roles
  FROM pg_namespace n
  WHERE n.nspname = ANY($1)`;

function mapVolatility(c: string): RawFunction['volatility'] {
  if (c === 'i') return 'immutable';
  if (c === 's') return 'stable';
  return 'volatile';
}

function mapArgMode(c: string): RawFunctionArg['mode'] {
  switch (c) {
    case 'o':
      return 'out';
    case 'b':
      return 'inout';
    case 'v':
      return 'variadic';
    case 't':
      return 'table';
    default:
      return 'in';
  }
}

function buildArgs(row: FunctionRow): RawFunctionArg[] {
  const json = row.args ?? [];
  const args: RawFunctionArg[] = json
    .slice()
    .sort((a, b) => a.ord - b.ord)
    .map((a) => ({
      name: a.name,
      typeName: a.typeName,
      udtName: a.udtName,
      typeOid: a.typeOid,
      mode: mapArgMode(a.mode),
      hasDefault: false,
    }));

  // pronargdefaults defaults apply to the trailing input arguments (IN /
  // INOUT / VARIADIC) in declaration order. Mark the last `ndef` of them.
  if (row.ndef > 0) {
    const inputIdx = args
      .map((a, i) => ({ a, i }))
      .filter((e) => e.a.mode === 'in' || e.a.mode === 'inout' || e.a.mode === 'variadic')
      .map((e) => e.i);
    for (const i of inputIdx.slice(Math.max(0, inputIdx.length - row.ndef))) {
      args[i]!.hasDefault = true;
    }
  }
  return args;
}

function classifyReturn(row: FunctionRow): RawFunctionReturn {
  const typeName = row.return_type;
  const columns =
    row.return_columns && row.return_columns.length > 0
      ? row.return_columns.map((c) => ({ name: c.name, typeName: c.typeName, typeOid: c.typeOid }))
      : undefined;

  // Base / enum / range / multirange are scalar element types. Domains were
  // resolved to their base typtype by the query, so a residual 'd' means a
  // domain over a domain — left to fall through to unsupported.
  const isScalarType = ['b', 'e', 'r', 'm'].includes(row.return_typtype);

  if (row.returns_void) {
    return { kind: 'void', typeName, returnsSet: false };
  }
  if (row.returns_set) {
    // Columns first: a 1-column RETURNS TABLE(c ...) collapses to the scalar
    // element type in pg_proc (typtype 'b'), but still carries the named OUT
    // column — it is an array of objects, not of bare scalars. Composite /
    // multi-column TABLE sets also land here.
    if (columns) {
      return { kind: 'setof', typeName, returnsSet: true, columns };
    }
    // SETOF scalar with no named column -> array of scalars.
    if (isScalarType) {
      return { kind: 'setof', typeName, returnsSet: true };
    }
    // A pseudo / composite SETOF with no resolvable columns (SETOF record /
    // anyelement, or a domain over a composite) is unmappable.
    return { kind: 'unsupported', typeName, returnsSet: true };
  }
  if (row.return_typtype === 'c') {
    // A composite resolves its columns (a domain over a composite too — the
    // query resolves the base relid). A 'c' with no columns would be an unusual
    // unresolved case; fail closed rather than emit a shapeless object.
    return columns
      ? { kind: 'composite', typeName, returnsSet: false, columns }
      : { kind: 'unsupported', typeName, returnsSet: false };
  }
  if (isScalarType) {
    return { kind: 'scalar', typeName, returnsSet: false };
  }
  // Non-set pseudo types (record without column defs, anyelement, trigger) and
  // a domain over a domain — not mappable to a v1 wire shape (loud skip in @core).
  return { kind: 'unsupported', typeName, returnsSet: false };
}

/** Split a SET search_path GUC value on commas that are not inside double
 *  quotes, then unquote each element. Handles `"$user", public` and a quoted
 *  identifier that itself contains a comma. */
function splitSearchPath(value: string): string[] {
  const elements: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '"') {
      // A doubled "" inside quotes is a literal quote.
      if (inQuotes && value[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      elements.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  elements.push(current.trim());
  return elements.filter((e) => e !== '');
}

/** Parse the proconfig `search_path` setting into elements, or null when the
 *  function declares no SET search_path. Each element records whether it is
 *  pg_temp and (for a fixed schema) is resolved to a schema name; a dynamic
 *  element (`$user`) resolves to null. Writability is filled in afterwards. */
function parseSearchPath(proconfig: string[] | null): RawFunctionSearchPathElement[] | null {
  if (proconfig === null) return null;
  const entry = proconfig.find((c) => c.toLowerCase().startsWith('search_path='));
  if (entry === undefined) return null;
  const value = entry.slice(entry.indexOf('=') + 1);
  return splitSearchPath(value).map((raw) => {
    if (raw === 'pg_temp') {
      return { raw, schema: null, writableByOthers: null, isTemp: true };
    }
    // A `$user` (or any $-prefixed) element is dynamic; it cannot be resolved
    // to a fixed schema, so it stays unsafe (the predicate fails closed).
    const schema = raw.startsWith('$') ? null : raw;
    return { raw, schema, writableByOthers: null, isTemp: false };
  });
}

type SchemaWritability = { publicCreate: boolean; creatorRoles: number[] };

/** Fetch CREATE-writability info for the given schema names. */
async function fetchSchemaWritability(
  client: Client,
  schemaNames: string[],
): Promise<Map<string, SchemaWritability>> {
  const map = new Map<string, SchemaWritability>();
  if (schemaNames.length === 0) return map;
  const rows = await runQuery<SchemaWritabilityRow>(
    client,
    SCHEMA_WRITABILITY_SQL,
    [schemaNames],
    'fetchFunctions (schema writability)',
  );
  for (const row of rows) {
    map.set(row.schema, {
      publicCreate: row.public_create,
      creatorRoles: row.creator_roles ?? [],
    });
  }
  return map;
}

export async function fetchFunctions(client: Client, schemas: string[]): Promise<RawFunction[]> {
  if (schemas.length === 0) return [];

  const rows = await runQuery<FunctionRow>(
    client,
    FUNCTIONS_SQL,
    [schemas],
    'fetchFunctions (functions)',
  );
  if (rows.length === 0) return [];

  // Pre-parse search paths and gather the fixed schema names whose CREATE
  // writability the safe-search_path predicate needs. Only definer
  // functions are subject to the predicate, so only their paths matter; but
  // parsing every function's path is cheap and keeps the shape uniform.
  const parsed = rows.map((row) => ({ row, searchPath: parseSearchPath(row.proconfig) }));
  const schemaNames = new Set<string>();
  for (const { row, searchPath } of parsed) {
    if (!row.security_definer || searchPath === null) continue;
    for (const el of searchPath) {
      if (!el.isTemp && el.schema !== null) schemaNames.add(el.schema);
    }
  }
  const writability = await fetchSchemaWritability(client, [...schemaNames]);

  return parsed.map(({ row, searchPath }): RawFunction => {
    // Resolve owner-relative writability for each fixed, non-temp element: the
    // schema is "writable by others" if PUBLIC can create there, or if any
    // non-superuser role other than this function's owner can (superusers are
    // not a hijack vector, and were excluded by the query). A schema not in the
    // map (e.g. it does not exist) stays null = unknown = unsafe (fail-closed).
    const resolvedSearchPath =
      searchPath === null
        ? null
        : searchPath.map((el) => {
            if (el.isTemp || el.schema === null) return el;
            const w = writability.get(el.schema);
            if (w === undefined) return { ...el, writableByOthers: null };
            const writableByOthers =
              w.publicCreate || w.creatorRoles.some((r) => r !== row.owner_oid);
            return { ...el, writableByOthers };
          });

    return {
      schema: row.schema,
      name: row.name,
      argumentSignature: row.argument_signature,
      arguments: buildArgs(row),
      returns: classifyReturn(row),
      volatility: mapVolatility(row.volatility),
      security: row.security_definer ? 'definer' : 'invoker',
      owner: { oid: row.owner_oid, name: row.owner_name },
      publicExecute: row.public_execute,
      searchPath: resolvedSearchPath,
      comment: row.comment,
    };
  });
}
