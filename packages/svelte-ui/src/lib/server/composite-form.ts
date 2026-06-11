// Prepare a native (non-enhanced) form submission for validation on a table
// that has relation pickers.
//
// Two things make the native path special:
//
//  1. Picker columns (single-column relation-selects and promoted composite
//     components) carry a `string | number` union schema, and superforms
//     rejects unions outright when parsing FormData ("Unions are only
//     supported when the dataType option for superForm is set to 'json'").
//     Parsing a plain object has no such restriction, so the native
//     submission is converted to one. The enhanced path is untouched: it
//     serializes the form store into superforms' __superform_json envelope,
//     which superValidate handles itself.
//
//  2. The composite picker's <select> submits ONE control — the picked row's
//     canonical encoded id (each component percent-encoded, comma-joined)
//     under a synthetic name (see compositeParamName) — because a no-JS
//     submission cannot fan the selection out to the component fields
//     itself. Each pick is decoded into its component fields here, and a
//     cleared optional relation drops its components so the unselected
//     defaults apply. Percent-encoding keeps the round-trip lossless for
//     commas; an empty-string key component, however, collides with the
//     picker contract's '' unselected sentinel and is a documented
//     limitation (see promoteCompositeMemberWidgets).

import type { RelationFieldConfig } from '$lib/form/relation-field-config.js';
import {
  COMPOSITE_CLEAR_VALUE,
  compositeParamName,
} from '$lib/form/relation-field-config.js';

/**
 * Return what the route action should hand to `superValidate`: the request
 * itself when the table has no pickers, the raw FormData when it carries the
 * enhanced JSON envelope, or a plain object holding the native submission
 * with each composite pick decoded into its component fields. Returns `null`
 * for a malformed composite control — wrong arity, invalid percent-encoding,
 * or an empty-string component — so the action can reject the submission:
 * letting it fall through to the schema defaults would silently CLEAR an
 * optional relation instead of reporting the bad value (a required one
 * already fails validation through the '' defaults).
 */
export async function readFormWithCompositePicks(
  request: Request,
  relations: RelationFieldConfig[],
): Promise<Request | FormData | Record<string, unknown> | null> {
  if (relations.length === 0) return request;

  const contentType = request.headers.get('content-type') ?? '';
  if (
    !contentType.includes('application/x-www-form-urlencoded') &&
    !contentType.includes('multipart/form-data')
  ) {
    // Not a form post (e.g. a JSON body): nothing to rewrite.
    return request;
  }

  const data = await request.formData();
  // The enhanced submission carries the whole form store in superforms'
  // JSON envelope; superValidate ignores plain fields then.
  if (data.has('__superform_json')) return data;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of data.entries()) {
    // These forms have no file inputs; skip File entries defensively. Blank
    // fields are OMITTED so the schema defaults apply — mirroring how
    // superforms itself parses blank FormData entries. Feeding '' through
    // the object path instead would skew unrelated scalars (a blank
    // nullable date fails validation, a blank nullable text becomes ''
    // instead of null); the picker columns are unaffected either way, since
    // their promoted schema default IS ''.
    if (typeof value === 'string' && value !== '') fields[key] = value;
  }

  for (const config of relations) {
    const keyFields = config.keyFields ?? [config.field];
    if (keyFields.length < 2) continue;
    const param = compositeParamName(config.field);
    const raw = fields[param];
    if (typeof raw !== 'string') continue;
    delete fields[param];

    if (raw === '') {
      // No selection made (the select rendered unselected — e.g. a
      // partial-null current value, or a disabled readonly group submits
      // nothing at all): keep the baseline hidden component fields so an
      // untouched save preserves the current values.
      continue;
    }

    if (raw === COMPOSITE_CLEAR_VALUE) {
      // Explicit clear: drop the components (and their baselines) so the
      // unselected defaults apply.
      for (const field of keyFields) delete fields[field];
      continue;
    }

    // A malformed value — wrong arity, invalid percent-encoding (the value
    // is client-controlled; a bare '%' would make decodeURIComponent throw),
    // or an empty-string component (which would collide with the '' clear
    // sentinel and corrupt the write) — rejects the whole submission. The
    // legitimate picker only ever submits real option ids or ''.
    let components: string[];
    try {
      components = raw.split(',').map((part) => decodeURIComponent(part));
    } catch {
      return null;
    }
    if (components.length !== keyFields.length) return null;
    if (components.some((part) => part === '')) return null;
    keyFields.forEach((field, i) => {
      fields[field] = components[i];
    });
  }
  return fields;
}
