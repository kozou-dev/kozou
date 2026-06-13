import { describe, expect, it } from 'vitest';

import {
  COMPOSITE_CLEAR_VALUE,
  type RelationFieldConfig,
} from '../../src/lib/form/relation-field-config.js';
import {
  readActionFormSubmission,
  readFormWithCompositePicks,
} from '../../src/lib/server/composite-form.js';

const binRelation: RelationFieldConfig = {
  field: 'aisle',
  fields: ['aisle', 'shelf'],
  keyFields: ['aisle', 'shelf'],
  resource: 'public.warehouse_bins',
  labelField: 'name',
  searchFields: ['name'],
};

const singleRelation: RelationFieldConfig = {
  field: 'author_id',
  resource: 'public.authors',
  labelField: 'display_name',
  searchFields: ['display_name'],
};

function formRequest(fields: Record<string, string>): Request {
  const params = new URLSearchParams(fields);
  return new Request('http://ui.local/tables/public.bin_assignments/new', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

describe('readFormWithCompositePicks', () => {
  it('returns the request untouched when the table has no pickers', async () => {
    const request = formRequest({ title: 'no relations here' });
    const result = await readFormWithCompositePicks(request, []);
    expect(result).toBe(request);
  });

  it('converts a native submission to a plain object even for single pickers', async () => {
    // Picker columns carry union schemas, which superforms refuses to parse
    // from FormData — the object form is what superValidate must receive.
    const request = formRequest({ author_id: 'a1', title: 'x' });
    const result = await readFormWithCompositePicks(request, [singleRelation]);
    expect(result).toEqual({ author_id: 'a1', title: 'x' });
  });

  it('returns the request untouched for a non-form content type', async () => {
    const request = new Request('http://ui.local/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ aisle: 1 }),
    });
    const result = await readFormWithCompositePicks(request, [binRelation]);
    expect(result).toBe(request);
  });

  it('leaves the enhanced superforms envelope alone', async () => {
    const request = formRequest({
      __superform_json: '[{"aisle":1}]',
      __composite__aisle: '9,9',
    });
    const result = await readFormWithCompositePicks(request, [binRelation]);
    // Still FormData (not the plain-object conversion): superValidate reads
    // the envelope and ignores plain fields. The instance may come from
    // undici, so duck-type rather than instanceof.
    const data = result as FormData;
    expect(typeof data.get).toBe('function');
    expect(data.get('__superform_json')).toBe('[{"aisle":1}]');
    expect(data.get('__composite__aisle')).toBe('9,9');
    expect(data.get('aisle')).toBeNull();
  });

  it('decodes a pick into the component fields', async () => {
    const request = formRequest({ __composite__aisle: '1,2', note: 'hi' });
    const fields = (await readFormWithCompositePicks(request, [
      binRelation,
    ])) as Record<string, unknown>;

    expect(fields).toEqual({ aisle: '1', shelf: '2', note: 'hi' });
  });

  it('decodes percent-encoded comma components losslessly', async () => {
    const request = formRequest({ __composite__aisle: 'a%2Cb,c' });
    const fields = (await readFormWithCompositePicks(request, [
      binRelation,
    ])) as Record<string, unknown>;

    // The first component contained a comma; percent-encoding keeps it
    // intact through the single encoded control.
    expect(fields.aisle).toBe('a,b');
    expect(fields.shelf).toBe('c');
  });

  it('maps components through permuted keyFields', async () => {
    const permuted: RelationFieldConfig = {
      ...binRelation,
      field: 'src_line',
      fields: ['src_line', 'src_order'],
      // Target key order is (order, line): component 0 -> src_order.
      keyFields: ['src_order', 'src_line'],
    };
    const request = formRequest({ __composite__src_line: 'o1,7' });
    const fields = (await readFormWithCompositePicks(request, [
      permuted,
    ])) as Record<string, unknown>;

    expect(fields.src_order).toBe('o1');
    expect(fields.src_line).toBe('7');
  });

  it('clears every component (and its baseline) on the explicit clear marker', async () => {
    const request = formRequest({
      __composite__aisle: COMPOSITE_CLEAR_VALUE,
      aisle: '1',
      shelf: '2',
    });
    const fields = (await readFormWithCompositePicks(request, [
      binRelation,
    ])) as Record<string, unknown>;

    // Absent fields let the unselected defaults apply — a literal '' would
    // coerce to 0 on a plain numeric column instead.
    expect('aisle' in fields).toBe(false);
    expect('shelf' in fields).toBe(false);
  });

  it('keeps the baseline component values when no selection was made', async () => {
    // An unselected select (e.g. a partial-null current value) submits '';
    // an untouched native save must keep the server-rendered baselines, not
    // erase them as a clear would. A blank baseline ('' = a null component)
    // is omitted so its schema default ('') applies — same downstream
    // result, and consistent with how blank fields parse generally.
    const request = formRequest({
      __composite__aisle: '',
      aisle: 'A',
      shelf: '',
    });
    const fields = (await readFormWithCompositePicks(request, [
      binRelation,
    ])) as Record<string, unknown>;

    expect(fields.aisle).toBe('A');
    expect('shelf' in fields).toBe(false);
    expect('__composite__aisle' in fields).toBe(false);
  });

  it('omits blank non-picker fields so their schema defaults apply', async () => {
    // superforms maps a blank FormData entry to the field default (null for
    // a nullable scalar / date); the object conversion must not skew that —
    // feeding '' through would turn a blank nullable date into a validation
    // failure and a blank nullable text into '' instead of null.
    const request = formRequest({
      author_id: 'a1',
      qty: '',
      shipped_at: '',
      note: 'kept',
    });
    const fields = (await readFormWithCompositePicks(request, [
      singleRelation,
    ])) as Record<string, unknown>;

    expect(fields).toEqual({ author_id: 'a1', note: 'kept' });
  });

  it('keeps the baseline when the control is absent (disabled readonly select)', async () => {
    // A disabled select submits nothing at all; the baselines must survive
    // so a readonly composite group round-trips unchanged.
    const request = formRequest({ aisle: '7', shelf: '8', note: 'ro' });
    const fields = (await readFormWithCompositePicks(request, [
      binRelation,
    ])) as Record<string, unknown>;

    expect(fields.aisle).toBe('7');
    expect(fields.shelf).toBe('8');
  });

  it('rejects an arity mismatch (the action turns null into a 400)', async () => {
    const request = formRequest({ __composite__aisle: '1,2,3' });
    expect(await readFormWithCompositePicks(request, [binRelation])).toBeNull();
  });

  it('rejects an empty-string component (sentinel collision)', async () => {
    // '' is the picker contract's unselected sentinel — decoding it into a
    // component field would normalize to null and write a partial key, and
    // letting it fall through to defaults would silently clear an optional
    // relation.
    const request = formRequest({ __composite__aisle: 'A,' });
    expect(await readFormWithCompositePicks(request, [binRelation])).toBeNull();
  });

  it('rejects hostile percent-encoding without throwing (no 500)', async () => {
    const request = formRequest({ __composite__aisle: '%,%E0%A4%A' });
    expect(await readFormWithCompositePicks(request, [binRelation])).toBeNull();
  });
});

describe('readActionFormSubmission (RPC action form)', () => {
  it('converts a native submission to a plain object, omitting blank fields', async () => {
    // A defaulted argument left blank must be DROPPED (so PostgreSQL applies
    // its DEFAULT) — and the object form is what lets superValidate parse the
    // defaulted argument's multi-type union at all (FormData would be rejected).
    const request = formRequest({ base: '5', bonus: '' });
    const result = await readActionFormSubmission(request);
    expect(result).toEqual({ base: '5' });
  });

  it('leaves the enhanced superforms envelope as FormData (parsed as JSON)', async () => {
    const request = formRequest({ __superform_json: '[{"base":5}]' });
    const result = await readActionFormSubmission(request);
    expect(typeof (result as FormData).get).toBe('function');
    expect((result as FormData).get('__superform_json')).toBe('[{"base":5}]');
  });

  it('returns the request untouched for a non-form content type', async () => {
    const request = new Request('http://ui.local/actions/public.f', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base: 5 }),
    });
    expect(await readActionFormSubmission(request)).toBe(request);
  });
});
