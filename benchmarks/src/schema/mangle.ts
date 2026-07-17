// Deterministic legacy-name mangling.
//
// Turns a semantic key (which a human reading THIS source can follow) into an
// OPAQUE, legacy-style SQL identifier from which the business meaning cannot
// be recovered by an agent that only sees the schema. The mapping is a pure
// function of (seed, kind, key), so:
//   - the generated schema is fully reproducible for a pinned seed, and
//   - the mapping table is auditable (emit.ts prints it): the fixture author
//     cannot smuggle a semantic hint into a name, because names are derived,
//     not chosen.
//
// This directly targets the previous benchmark's failure mode where a naive
// arm recovered meaning from readable relation/view names. See README.md.

export type IdentKind = 'table' | 'view' | 'column' | 'constraint';

const PREFIX: Record<IdentKind, string> = {
  table: 't',
  view: 'v',
  column: 'c',
  constraint: 'x',
};

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** 32-bit FNV-1a. Stable across platforms (integer math only). */
function fnv1a(input: string): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Deterministic identifier generator.
 *
 * `name(kind, namespace, key)` returns a stable opaque token for the given
 * semantic key, unique within its namespace. Namespaces:
 *   - relations (tables + views) share one namespace so a table and a view
 *     never collide (Postgres forbids it);
 *   - a table's columns share a per-table namespace;
 *   - constraints share a schema-global namespace.
 * Collisions are resolved with a deterministic numeric suffix, so the mapping
 * is a pure function of construction order (which is itself deterministic).
 */
export class Mangler {
  private readonly seed: string;
  private readonly used = new Map<string, Set<string>>();
  private readonly cache = new Map<string, string>();

  constructor(seed: string) {
    this.seed = seed;
  }

  private base(kind: IdentKind, qualifiedKey: string): string {
    const h = fnv1a(`${this.seed}|${kind}|${qualifiedKey}`).toString(36);
    return `${PREFIX[kind]}_${h}`;
  }

  name(kind: IdentKind, namespace: string, key: string): string {
    const cacheKey = `${namespace}::${kind}::${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const base = this.base(kind, `${namespace}:${key}`);
    const used = this.used.get(namespace) ?? new Set<string>();
    let candidate = base;
    let n = 1;
    while (used.has(candidate)) {
      candidate = `${base}_${n}`;
      n += 1;
    }
    used.add(candidate);
    this.used.set(namespace, used);
    this.cache.set(cacheKey, candidate);
    return candidate;
  }
}

/** Namespace constant for the relation (table + view) namespace. */
export const REL_NS = 'rel';
/** Namespace constant for the schema-global constraint namespace. */
export const CON_NS = 'con';
