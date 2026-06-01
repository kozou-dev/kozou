import { describe, it, expect } from 'vitest';
import {
  parseEmbedParam,
  resolveEmbedSpec,
  buildEmbedSelectFragment,
  MAX_EMBED_DEPTH,
  MAX_EMBED_RELATIONS,
} from '../src/embed.js';
import { buildResourceLookup } from '../src/schema-lookup.js';
import { KozouApiError } from '../src/errors.js';
import { schemaOf, col, relation } from './helpers.js';

// A forward to-one chain: inventory_items -> editions -> books -> authors.
const lookup = buildResourceLookup(
  schemaOf([
    {
      name: 'inventory_items',
      columns: [col('id', 'uuid', { isPrimaryKey: true }), col('edition_id', 'uuid')],
      relations: [relation('edition_id', 'editions')],
    },
    {
      name: 'editions',
      columns: [col('id', 'uuid', { isPrimaryKey: true }), col('book_id', 'uuid')],
      relations: [relation('book_id', 'books')],
    },
    {
      name: 'books',
      columns: [
        col('id', 'uuid', { isPrimaryKey: true }),
        col('author_id', 'uuid'),
        col('title', 'text'),
      ],
      relations: [relation('author_id', 'authors')],
    },
    {
      name: 'authors',
      columns: [col('id', 'uuid', { isPrimaryKey: true }), col('display_name', 'text')],
      relations: [],
    },
  ]),
);
const books = lookup.resolve('books')!;
const inventory = lookup.resolve('inventory_items')!;
const authors = lookup.resolve('authors')!;

function expect400(fn: () => unknown, re: RegExp): void {
  try {
    fn();
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(KozouApiError);
    expect((err as KozouApiError).status).toBe(400);
    expect((err as KozouApiError).message).toMatch(re);
  }
}

describe('parseEmbedParam', () => {
  it('splits comma and dot, trims, and drops empty segments', () => {
    expect(parseEmbedParam('author, editions.books ,, .x')).toEqual([
      ['author'],
      ['editions', 'books'],
      ['x'],
    ]);
  });

  it('returns an empty list for null / empty / all-empty input', () => {
    expect(parseEmbedParam(null)).toEqual([]);
    expect(parseEmbedParam(undefined)).toEqual([]);
    expect(parseEmbedParam('')).toEqual([]);
    expect(parseEmbedParam(',,')).toEqual([]);
  });
});

describe('resolveEmbedSpec', () => {
  it('resolves a single relation by the target table name', () => {
    const spec = resolveEmbedSpec(books, parseEmbedParam('authors'), lookup);
    expect(spec).toHaveLength(1);
    expect(spec[0].relation.field).toBe('author_id');
    expect(spec[0].key).toBe('authors');
    expect(spec[0].target.name).toBe('authors');
    expect(spec[0].children).toEqual([]);
  });

  it('resolves the same relation by the foreign-key field name', () => {
    const spec = resolveEmbedSpec(books, parseEmbedParam('author_id'), lookup);
    expect(spec[0].relation.field).toBe('author_id');
    expect(spec[0].key).toBe('authors');
  });

  it('resolves a multi-level chain', () => {
    const spec = resolveEmbedSpec(inventory, parseEmbedParam('editions.books.authors'), lookup);
    expect(spec[0].key).toBe('editions');
    expect(spec[0].children[0].key).toBe('books');
    expect(spec[0].children[0].children[0].key).toBe('authors');
    expect(spec[0].children[0].children[0].children).toEqual([]);
  });

  it('merges paths that share a prefix into one node', () => {
    const spec = resolveEmbedSpec(inventory, parseEmbedParam('editions.books,editions'), lookup);
    expect(spec).toHaveLength(1);
    expect(spec[0].children).toHaveLength(1);
    expect(spec[0].children[0].key).toBe('books');
  });

  it('rejects an unknown relation', () => {
    expect400(
      () => resolveEmbedSpec(books, parseEmbedParam('nope'), lookup),
      /Unknown embed relation "nope" on resource "books"/,
    );
  });

  it('rejects an ambiguous target-table selector, but resolves by field name', () => {
    const ambiguous = buildResourceLookup(
      schemaOf([
        {
          name: 'messages',
          columns: [
            col('id', 'uuid', { isPrimaryKey: true }),
            col('sender_id', 'uuid'),
            col('recipient_id', 'uuid'),
          ],
          relations: [relation('sender_id', 'users'), relation('recipient_id', 'users')],
        },
        { name: 'users', columns: [col('id', 'uuid', { isPrimaryKey: true })], relations: [] },
      ]),
    );
    const messages = ambiguous.resolve('messages')!;
    expect400(
      () => resolveEmbedSpec(messages, parseEmbedParam('users'), ambiguous),
      /Ambiguous embed "users"/,
    );
    const spec = resolveEmbedSpec(messages, parseEmbedParam('sender_id,recipient_id'), ambiguous);
    expect(spec.map((n) => n.key)).toEqual(['users', 'recipient']);
  });

  it('rejects an embed path deeper than the maximum', () => {
    const tooDeep = Array<string>(MAX_EMBED_DEPTH + 1).fill('x');
    expect400(() => resolveEmbedSpec(books, [tooDeep], lookup), /Embed depth/);
  });

  it('rejects requesting more than the maximum number of relations', () => {
    const cols = [col('id', 'uuid', { isPrimaryKey: true })];
    const rels = [];
    for (let i = 0; i <= MAX_EMBED_RELATIONS; i++) {
      cols.push(col(`f${i}_id`, 'uuid'));
      rels.push(relation(`f${i}_id`, 'authors'));
    }
    const starLookup = buildResourceLookup(
      schemaOf([
        { name: 'hub', columns: cols, relations: rels },
        { name: 'authors', columns: [col('id', 'uuid', { isPrimaryKey: true })], relations: [] },
      ]),
    );
    const hub = starLookup.resolve('hub')!;
    const fields = Array.from({ length: MAX_EMBED_RELATIONS + 1 }, (_, i) => `f${i}_id`).join(',');
    expect400(() => resolveEmbedSpec(hub, parseEmbedParam(fields), starLookup), /too many relations/);
  });

  it('rejects embedding on a view', () => {
    const viewLookup = buildResourceLookup(
      schemaOf([], [{ name: 'vw', columns: [col('id', 'uuid')] }]),
    );
    const view = viewLookup.resolve('vw')!;
    expect400(
      () => resolveEmbedSpec(view, parseEmbedParam('anything'), viewLookup),
      /is a view and exposes no embeddable relations/,
    );
  });

  it('rejects a relation whose target table is not an exposed resource', () => {
    const orphan = buildResourceLookup(
      schemaOf([
        {
          name: 'books',
          columns: [col('id', 'uuid', { isPrimaryKey: true }), col('author_id', 'uuid')],
          relations: [relation('author_id', 'authors')],
        },
      ]),
    );
    const b = orphan.resolve('books')!;
    expect400(
      () => resolveEmbedSpec(b, parseEmbedParam('authors'), orphan),
      /Embed target "public.authors" is not an available resource/,
    );
  });

  it('rejects when no non-conflicting key can be derived', () => {
    const clash = buildResourceLookup(
      schemaOf([
        {
          name: 'parent',
          columns: [
            col('id', 'uuid', { isPrimaryKey: true }),
            col('x', 'text'),
            col('x_id', 'uuid'),
          ],
          relations: [relation('x_id', 'x')],
        },
        { name: 'x', columns: [col('id', 'uuid', { isPrimaryKey: true })], relations: [] },
      ]),
    );
    const parent = clash.resolve('parent')!;
    expect400(
      () => resolveEmbedSpec(parent, parseEmbedParam('x_id'), clash),
      /Cannot derive a non-conflicting embed key/,
    );
  });

  it('resolves a reverse one-to-many relation by child table name', () => {
    const spec = resolveEmbedSpec(authors, parseEmbedParam('books'), lookup);
    expect(spec).toHaveLength(1);
    expect(spec[0].kind).toBe('to-many');
    expect(spec[0].target.name).toBe('books');
    expect(spec[0].key).toBe('books');
    expect(spec[0].relation.field).toBe('author_id');
  });

  it('composes reverse embeds across two levels', () => {
    const spec = resolveEmbedSpec(authors, parseEmbedParam('books.editions'), lookup);
    expect(spec[0].kind).toBe('to-many');
    expect(spec[0].children[0].kind).toBe('to-many');
    expect(spec[0].children[0].key).toBe('editions');
  });

  it('composes a forward embed under a reverse embed', () => {
    const spec = resolveEmbedSpec(authors, parseEmbedParam('books.authors'), lookup);
    expect(spec[0].kind).toBe('to-many');
    expect(spec[0].children[0].kind).toBe('to-one');
    expect(spec[0].children[0].key).toBe('authors');
  });

  it('rejects an ambiguous reverse selector', () => {
    const social = buildResourceLookup(
      schemaOf([
        { name: 'users', columns: [col('id', 'uuid', { isPrimaryKey: true })], relations: [] },
        {
          name: 'follows',
          columns: [
            col('id', 'uuid', { isPrimaryKey: true }),
            col('follower_id', 'uuid'),
            col('followee_id', 'uuid'),
          ],
          relations: [relation('follower_id', 'users'), relation('followee_id', 'users')],
        },
      ]),
    );
    const users = social.resolve('users')!;
    expect400(
      () => resolveEmbedSpec(users, parseEmbedParam('follows'), social),
      /Ambiguous reverse embed "follows"/,
    );
  });
});

describe('buildEmbedSelectFragment', () => {
  it('renders a one-level correlated subquery', () => {
    const spec = resolveEmbedSpec(books, parseEmbedParam('authors'), lookup);
    const frag = buildEmbedSelectFragment(spec, '"public"."books"', { n: 0 });
    expect(frag).toBe(
      ', (SELECT to_jsonb(e1) FROM (SELECT "id", "display_name" FROM "public"."authors" e1 WHERE e1."id" = "public"."books"."author_id") e1) AS "authors"',
    );
  });

  it('renders a nested multi-level chain with unique aliases', () => {
    const spec = resolveEmbedSpec(inventory, parseEmbedParam('editions.books.authors'), lookup);
    const frag = buildEmbedSelectFragment(spec, '"public"."inventory_items"', { n: 0 });
    expect(frag).toBe(
      ', (SELECT to_jsonb(e1) FROM (SELECT "id", "book_id", (SELECT to_jsonb(e2) FROM (SELECT "id", "author_id", "title", (SELECT to_jsonb(e3) FROM (SELECT "id", "display_name" FROM "public"."authors" e3 WHERE e3."id" = e2."author_id") e3) AS "authors" FROM "public"."books" e2 WHERE e2."id" = e1."book_id") e2) AS "books" FROM "public"."editions" e1 WHERE e1."id" = "public"."inventory_items"."edition_id") e1) AS "editions"',
    );
  });

  it('produces no bound parameters', () => {
    const spec = resolveEmbedSpec(inventory, parseEmbedParam('editions.books.authors'), lookup);
    const frag = buildEmbedSelectFragment(spec, '"public"."inventory_items"', { n: 0 });
    expect(frag).not.toContain('$');
  });

  it('renders a reverse to-many aggregate with ORDER BY and a child cap', () => {
    const spec = resolveEmbedSpec(authors, parseEmbedParam('books'), lookup);
    const frag = buildEmbedSelectFragment(spec, '"public"."authors"', { n: 0 });
    expect(frag).toBe(
      `, (SELECT coalesce(jsonb_agg(to_jsonb(e1) ORDER BY e1."id"), '[]'::jsonb) FROM (SELECT "id", "author_id", "title" FROM "public"."books" e1 WHERE e1."author_id" = "public"."authors"."id" ORDER BY e1."id" LIMIT 100) e1) AS "books"`,
    );
  });

  it('returns an empty string for an empty spec', () => {
    expect(buildEmbedSelectFragment([], '"public"."books"', { n: 0 })).toBe('');
  });
});
