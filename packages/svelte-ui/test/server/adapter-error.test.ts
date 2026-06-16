import { describe, expect, it } from 'vitest';

import { AdapterError } from '@kozou/ui-core';

import { adapterErrorToFailure } from '../../src/lib/server/adapter-error.js';

function adapterError(status: number): AdapterError {
  return new AdapterError({
    message: `request failed with status ${status}`,
    status,
    url: 'http://api.example/widgets',
    responseBody: null,
    code: status === 0 ? 'network' : 'http',
  });
}

describe('adapterErrorToFailure', () => {
  it('maps a 409 conflict to a readable failure', () => {
    const failure = adapterErrorToFailure(adapterError(409));
    expect(failure?.status).toBe(409);
    expect(failure?.message).toMatch(/unique|conflict|already in use/i);
  });

  it('maps a 403 privilege / RLS denial to a permission message', () => {
    const failure = adapterErrorToFailure(adapterError(403));
    expect(failure?.status).toBe(403);
    expect(failure?.message).toMatch(/permission/i);
  });

  it('maps a 400 constraint violation to a generic rejected-values message', () => {
    const failure = adapterErrorToFailure(adapterError(400));
    expect(failure?.status).toBe(400);
    expect(failure?.message).toMatch(/rejected/i);
  });

  it('maps 404 and 405 to dedicated messages', () => {
    expect(adapterErrorToFailure(adapterError(404))?.status).toBe(404);
    expect(adapterErrorToFailure(adapterError(404))?.message).toMatch(/found/i);
    expect(adapterErrorToFailure(adapterError(405))?.status).toBe(405);
    expect(adapterErrorToFailure(adapterError(405))?.message).toMatch(/not allowed/i);
  });

  it('does NOT leak the raw backend message', () => {
    const raw = 'duplicate key value violates unique constraint "widgets_email_key"';
    const failure = adapterErrorToFailure(
      new AdapterError({
        message: raw,
        status: 409,
        url: 'http://api.example/widgets',
        responseBody: raw,
        code: 'http',
      }),
    );
    expect(failure?.message).not.toContain(raw);
    expect(failure?.message).not.toMatch(/widgets_email_key/);
  });

  it('returns null for a 5xx so a genuine server fault is not disguised as a form error', () => {
    expect(adapterErrorToFailure(adapterError(500))).toBeNull();
    expect(adapterErrorToFailure(adapterError(503))).toBeNull();
  });

  it('returns null for a 0-status network error (propagate, do not swallow)', () => {
    expect(adapterErrorToFailure(adapterError(0))).toBeNull();
  });

  it('returns null for a non-AdapterError (a plain Error or anything else)', () => {
    expect(adapterErrorToFailure(new Error('boom'))).toBeNull();
    expect(adapterErrorToFailure('boom')).toBeNull();
    expect(adapterErrorToFailure(undefined)).toBeNull();
  });
});
