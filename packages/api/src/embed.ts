// The `embed` sub-language for the read path. Inlines forward to-one /
// one-to-one related rows as nested JSON objects, to a capped depth, in a
// single SQL statement.
//
// Pipeline:
//   parseEmbedParam          "a,b.c"        -> string[][]            (pure syntax)
//   resolveEmbedSpec         paths + lookup -> EmbedNode[]           (validate; all 400s)
//   buildEmbedSelectFragment spec           -> SQL SELECT-list text  (identifiers only)
//
// Safety: every identifier emitted comes from the introspected schema (a
// relation's referenced table/column, or a target's declared columns), never
// from the raw request string. The selector only *chooses* which allowlisted
// relation to follow. No bound parameters are produced, so the caller's $n
// numbering is untouched.

import type { RelationContext } from '@kozou/core';
import { badRequest } from './errors.js';
import { quoteIdent, qualified } from './ident.js';
import type { Resource, ResourceLookup } from './schema-lookup.js';

/** Maximum relation chain length (dot-separated segments) per embed path. */
export const MAX_EMBED_DEPTH = 5;
/** Maximum number of distinct relations a single request may embed. */
export const MAX_EMBED_RELATIONS = 25;

export type EmbedNode = {
  /** The foreign key on the parent followed to reach this node. */
  relation: RelationContext;
  /** The resolved target resource; its columns form the nested allowlist. */
  target: Resource;
  /** The key the nested object is returned under. */
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
  const relation = resolveRelation(parent, path[index]);
  let node = siblings.find((s) => s.relation.field === relation.field);
  if (node === undefined) {
    if (counter.n >= MAX_EMBED_RELATIONS) {
      throw badRequest(`Embed requests too many relations (max ${MAX_EMBED_RELATIONS}).`);
    }
    const target = resolveTarget(relation, lookup);
    const key = chooseKey(relation, siblings, parent);
    node = { relation, target, key, children: [] };
    siblings.push(node);
    counter.n += 1;
  }
  insertPath(node.target, path, index + 1, node.children, lookup, counter);
}

function resolveRelation(parent: Resource, selector: string): RelationContext {
  const relations = parent.relations;
  if (relations.length === 0) {
    if (parent.kind === 'view') {
      throw badRequest(`Resource "${parent.name}" is a view and exposes no embeddable relations.`);
    }
    throw badRequest(`Resource "${parent.name}" has no embeddable relations.`);
  }
  const byField = relations.find((r) => r.field === selector);
  if (byField !== undefined) return byField;
  const byTable = relations.filter((r) => r.references.table === selector);
  if (byTable.length === 1) return byTable[0];
  if (byTable.length > 1) {
    const fields = byTable.map((r) => r.field).join('", "');
    throw badRequest(
      `Ambiguous embed "${selector}" on "${parent.name}": foreign keys "${fields}" all reference "${selector}"; use the foreign-key column name.`,
    );
  }
  throw badRequest(`Unknown embed relation "${selector}" on resource "${parent.name}".`);
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
function chooseKey(relation: RelationContext, siblings: EmbedNode[], parent: Resource): string {
  const taken = new Set(siblings.map((s) => s.key));
  const columns = new Set(parent.columns.map((c) => c.name));
  const candidates = [relation.references.table, stripIdSuffix(relation.field), relation.field];
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

/** Render the SELECT-list fragment for an embed forest. Each node becomes a
 *  correlated scalar subquery `(SELECT to_jsonb(eN) FROM (...) eN) AS "key"`,
 *  composed recursively for depth. `parentRef` is the SQL reference for the
 *  parent row scope (the qualified table name at the top level, a generated
 *  alias below); `counter` keeps aliases unique across the whole statement.
 *  Identifiers only — no bound parameters are produced. */
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
    const refCol = quoteIdent(node.relation.references.column);
    const fkField = quoteIdent(node.relation.field);
    const inner = `SELECT ${cols}${children} FROM ${qualified(node.target)} ${alias} WHERE ${alias}.${refCol} = ${parentRef}.${fkField}`;
    out += `, (SELECT to_jsonb(${alias}) FROM (${inner}) ${alias}) AS ${quoteIdent(node.key)}`;
  }
  return out;
}
