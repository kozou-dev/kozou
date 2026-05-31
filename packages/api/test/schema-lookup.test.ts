import { describe, it, expect } from 'vitest';
import { buildResourceLookup } from '../src/schema-lookup.js';
import { schemaOf, col } from './helpers.js';

describe('buildResourceLookup', () => {
  it('resolves tables and views by bare name and by qualified name', () => {
    const lookup = buildResourceLookup(
      schemaOf(
        [{ name: 'authors', columns: [col('id', 'uuid')], primaryKey: ['id'] }],
        [{ name: 'vw_active', columns: [col('id', 'uuid')] }],
      ),
    );
    expect(lookup.resolve('authors')?.kind).toBe('table');
    expect(lookup.resolve('public.authors')?.name).toBe('authors');
    expect(lookup.resolve('authors')?.primaryKey).toEqual(['id']);
    expect(lookup.resolve('vw_active')?.kind).toBe('view');
    expect(lookup.resolve('public.vw_active')?.primaryKey).toEqual([]);
    expect(lookup.resolve('missing')).toBeUndefined();
  });

  it('lists every resource by qualified name, sorted', () => {
    const lookup = buildResourceLookup(schemaOf([{ name: 'b' }, { name: 'a' }]));
    expect(lookup.list()).toEqual(['public.a', 'public.b']);
  });

  it('does not resolve an ambiguous bare name shared across schemas', () => {
    const lookup = buildResourceLookup(
      schemaOf([
        { schema: 's1', name: 'items' },
        { schema: 's2', name: 'items' },
      ]),
    );
    expect(lookup.resolve('items')).toBeUndefined();
    expect(lookup.resolve('s1.items')?.schema).toBe('s1');
    expect(lookup.resolve('s2.items')?.schema).toBe('s2');
  });
});
