// The `embed` sub-language for the read path. Inlines related rows as nested
// JSON, to a capped depth, in a single SQL statement:
//   - forward (to-one / one-to-one): the parent's FK -> a single object.
//   - reverse (one-to-many): children whose FK points back -> an array.
//
// Pipeline:
//   parseEmbedParam          "a,b.c"        -> string[][]            (pure syntax)
//   resolveEmbedSpec         paths + lookup -> EmbedNode[]           (validate; all 400s)
//   buildEmbedSelectFragment spec           -> SQL SELECT-list text  (identifiers only)
//
// Safety: every identifier emitted comes from the introspected schema (a
// relation's field / referenced column, or a target's declared columns), never
// from the raw request string. The selector only *chooses* which allowlisted
// relation to follow. No bound parameters are produced, so the caller's $n
// numbering is untouched.

import type { RelationContext } from '@kozou/core';
import { badRequest } from './errors.js';
import { quoteIdent, qualified } from './ident.js';
import type { Resource, ResourceLookup, ReverseRelation } from './schema-lookup.js';

/** Maximum relation chain length (dot-separated segments) per embed path. */
export const MAX_EMBED_DEPTH = 5;
/** Maximum number of distinct relations a single request may embed. */
export const MAX_EMBED_RELATIONS = 25;
/** Maximum number of child rows inlined per parent for a to-many embed. */
export const MAX_EMBED_CHILDREN = 100;

export type EmbedKind = 'to-one' | 'to-many';

export type EmbedNode = {
  /** `to-one`: a forward FK on the parent. `to-many`: a child's FK pointing
   *  back at the parent. */
  kind: EmbedKind;
  /** The foreign key linking parent and target. For `to-one` it lives on the
   *  parent (`relation.field`) and points at the target (`references.column`);
   *  for `to-many` it lives on the child target (`relation.field`) and points
   *  back at the parent (`references.column`). */
  relation: RelationContext;
  /** The resolved target resource; its columns form the nested allowlist. */
  target: Resource;
  /** The key the nested value is returned under. */
  key: string;
  /** Deeper embeds, resolved against `target`. */
  children: EmbedNode[];
};

export type EmbedSpec = EmbedNode[];

/** Split a raw `embed` value into paths. Pure: no schema knowledge.
 *  `"author,editions.books"` -> `[["author"], ["editions", "books"]]`. */
export function parseEmbedParam(raw: string | null | undefined): string[][] {
  if (raw === null || raw === undefined) return [];
  const paths: string[][] = [];
  for (const group of raw.split(',')) {
    const segments = group
      .split('.')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (segments.length > 0) paths.push(segments);
  }
  return paths;
}

/** Resolve + validate parsed paths into an embed forest. Throws `badRequest`
 *  on any unknown / ambiguous selector, over-cap depth or count, or
 *  unembeddable target. Paths sharing a prefix are merged so a relation is
 *  embedded at most once per parent. */
export function resolveEmbedSpec(
  root: Resource,
  paths: string[][],
  lookup: ResourceLookup,
): EmbedSpec {
  const counter = { n: 0 };
  const forest: EmbedNode[] = [];
  for (const path of paths) {
    if (path.length > MAX_EMBED_DEPTH) {
      throw badRequest(`Embed depth ${path.length} exceeds the maximum of ${MAX_EMBED_DEPTH}.`);
    }
    insertPath(root, path, 0, forest, lookup, counter);
  }
  return forest;
}

function insertPath(
  parent: Resource,
  path: string[],
  index: number,
  siblings: EmbedNode[],
  lookup: ResourceLookup,
  counter: { n: number },
): void {
  if (index >= path.length) return;
  const resolved = resolveSegment(parent, path[index], lookup);
  let node = siblings.find(
    (s) =>
      s.kind === resolved.kind &&
      s.target.qualifiedName === resolved.target.qualifiedName &&
      s.relation.field === resolved.relation.field,
  );
  if (node === undefined) {
    if (counter.n >= MAX_EMBED_RELATIONS) {
      throw badRequest(`Embed requests too many relations (max ${MAX_EMBED_RELATIONS}).`);
    }
    const key = chooseKey(resolved.target, resolved.relation, siblings, parent);
    node = { kind: resolved.kind, relation: resolved.relation, target: resolved.target, key, children: [] };
    siblings.push(node);
    counter.n += 1;
  }
  insertPath(node.target, path, index + 1, node.children, lookup, counter);
}

type ResolvedSegment = { kind: EmbedKind; relation: RelationContext; target: Resource };

/** Resolve one selector against a parent: a forward relation first, then a
 *  reverse (child) relation. Views expose neither. */
function resolveSegment(parent: Resource, selector: string, lookup: ResourceLookup): ResolvedSegment {
  if (parent.kind === 'view') {
    throw badRequest(`Resource "${parent.name}" is a view and exposes no embeddable relations.`);
  }
  const forward = matchForward(parent, selector);
  if (forward !== undefined) {
    return { kind: 'to-one', relation: forward, target: resolveTarget(forward, lookup) };
  }
  const reverse = matchReverse(parent, selector, lookup);
  if (reverse !== undefined) {
    return { kind: 'to-many', relation: reverse.relation, target: reverse.child };
  }
  throw badRequest(`Unknown embed relation "${selector}" on resource "${parent.name}".`);
}

/** Match a forward to-one relation by FK field name, or by referenced table
 *  name when exactly one FK targets it. */
function matchForward(parent: Resource, selector: string): RelationContext | undefined {
  const byField = parent.relations.find((r) => r.field === selector);
  if (byField !== undefined) return byField;
  const byTable = parent.relations.filter((r) => r.references.table === selector);
  if (byTable.length === 1) return byTable[0];
  if (byTable.length > 1) {
    const fields = byTable.map((r) => r.field).join('", "');
    throw badRequest(
      `Ambiguous embed "${selector}" on "${parent.name}": foreign keys "${fields}" all reference "${selector}"; use the foreign-key column name.`,
    );
  }
  return undefined;
}

/** Match a reverse to-many relation by child table name, when exactly one of
 *  that child's foreign keys references the parent. */
function matchReverse(
  parent: Resource,
  selector: string,
  lookup: ResourceLookup,
): ReverseRelation | undefined {
  const candidates = lookup.reverse(parent.qualifiedName).filter((e) => e.child.name === selector);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const fields = candidates.map((e) => e.relation.field).join('", "');
    throw badRequest(
      `Ambiguous reverse embed "${selector}" on "${parent.name}": "${selector}" references it via "${fields}"; embedding multiple reverse keys is not yet supported.`,
    );
  }
  return undefined;
}

function resolveTarget(relation: RelationContext, lookup: ResourceLookup): Resource {
  const qn = `${relation.references.schema}.${relation.references.table}`;
  const target = lookup.resolve(qn);
  if (target === undefined) {
    throw badRequest(`Embed target "${qn}" is not an available resource.`);
  }
  return target;
}

/** Pick a result key that collides with neither a sibling embed nor a real
 *  column on the parent (which would shadow the raw scalar value). Prefers the
 *  target table name, then the FK field with a trailing id-suffix stripped,
 *  then the raw FK field. */
function chooseKey(
  target: Resource,
  relation: RelationContext,
  siblings: EmbedNode[],
  parent: Resource,
): string {
  const taken = new Set(siblings.map((s) => s.key));
  const columns = new Set(parent.columns.map((c) => c.name));
  const candidates = [target.name, stripIdSuffix(relation.field), relation.field];
  for (const key of candidates) {
    if (key.length > 0 && !taken.has(key) && !columns.has(key)) return key;
  }
  throw badRequest(
    `Cannot derive a non-conflicting embed key for "${relation.field}" on "${parent.name}".`,
  );
}

function stripIdSuffix(field: string): string {
  const stripped = field.replace(/_(id|uuid|fk|key)$/i, '');
  return stripped.length > 0 ? stripped : field;
}

/** Render the SELECT-list fragment for an embed forest, composed recursively
 *  for depth. `parentRef` is the SQL reference for the parent row scope (the
 *  qualified table name at the top level, a generated alias below); `counter`
 *  keeps aliases unique across the whole statement. Identifiers only — no
 *  bound parameters are produced.
 *
 *  - to-one  -> `(SELECT to_jsonb(eN) FROM (...) eN) AS "key"`              (object | null)
 *  - to-many -> `(SELECT coalesce(jsonb_agg(...), '[]') FROM (...) eN) AS "key"` (array) */
export function buildEmbedSelectFragment(
  spec: EmbedNode[],
  parentRef: string,
  counter: { n: number },
): string {
  let out = '';
  for (const node of spec) {
    counter.n += 1;
    const alias = `e${counter.n}`;
    const cols =
      node.target.columns.length > 0
        ? node.target.columns.map((c) => quoteIdent(c.name)).join(', ')
        : '*';
    const children = buildEmbedSelectFragment(node.children, alias, counter);
    const fkField = quoteIdent(node.relation.field);
    const refCol = quoteIdent(node.relation.references.column);

    if (node.kind === 'to-one') {
      const inner = `SELECT ${cols}${children} FROM ${qualified(node.target)} ${alias} WHERE ${alias}.${refCol} = ${parentRef}.${fkField}`;
      out += `, (SELECT to_jsonb(${alias}) FROM (${inner}) ${alias}) AS ${quoteIdent(node.key)}`;
    } else {
      const order = orderByPrimaryKey(node.target, alias);
      const inner = `SELECT ${cols}${children} FROM ${qualified(node.target)} ${alias} WHERE ${alias}.${fkField} = ${parentRef}.${refCol}${order} LIMIT ${MAX_EMBED_CHILDREN}`;
      out += `, (SELECT coalesce(jsonb_agg(to_jsonb(${alias})${order}), '[]'::jsonb) FROM (${inner}) ${alias}) AS ${quoteIdent(node.key)}`;
    }
  }
  return out;
}

/** `ORDER BY <alias>.<pk>...` for deterministic, bounded to-many results.
 *  Empty when the target has no primary key. */
function orderByPrimaryKey(target: Resource, alias: string): string {
  if (target.primaryKey.length === 0) return '';
  const cols = target.primaryKey.map((c) => `${alias}.${quoteIdent(c)}`).join(', ');
  return ` ORDER BY ${cols}`;
}
