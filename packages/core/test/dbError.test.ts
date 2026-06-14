import { describe, it, expect } from 'vitest';
import { classifyDatabaseError } from '../src/dbError.js';

/** A node-postgres-shaped error: an Error carrying a 5-char SQLSTATE `code`
 *  and a `severity`. */
function dbError(code: string): Error {
  return Object.assign(new Error('raw database detail with identifiers'), {
    code,
    severity: 'ERROR',
  });
}

describe('classifyDatabaseError', () => {
  it('maps the recognized SQLSTATEs to stable, identifier-free outcomes', () => {
    expect(classifyDatabaseError(dbError('42501'))).toEqual({
      status: 403,
      code: 'forbidden',
      message: 'Permission denied.',
    });
    expect(classifyDatabaseError(dbError('23505'))).toEqual({
      status: 409,
      code: 'conflict',
      message: 'Unique constraint violation.',
    });
    expect(classifyDatabaseError(dbError('23503'))).toEqual({
      status: 409,
      code: 'conflict',
      message: 'Foreign key constraint violation.',
    });
    expect(classifyDatabaseError(dbError('23502'))).toEqual({
      status: 400,
      code: 'constraint_violation',
      message: 'Not-null constraint violation.',
    });
    expect(classifyDatabaseError(dbError('23514'))).toEqual({
      status: 400,
      code: 'constraint_violation',
      message: 'Check constraint violation.',
    });
  });

  it('never echoes the raw database message', () => {
    const mapped = classifyDatabaseError(dbError('42501'));
    expect(JSON.stringify(mapped)).not.toContain('raw database detail');
  });

  it('returns null for an unrecognized SQLSTATE (stays an internal error)', () => {
    // A data exception (class 22) is deliberately not classified: those inputs
    // are pre-flighted, so an executed one signals a bug, not a client error.
    expect(classifyDatabaseError(dbError('22007'))).toBeNull();
    expect(classifyDatabaseError(dbError('XX000'))).toBeNull();
  });

  it('returns null for anything that is not a database error', () => {
    expect(classifyDatabaseError(new Error('plain'))).toBeNull();
    expect(classifyDatabaseError({ code: '42501', severity: 'ERROR' })).toBeNull(); // not an Error
    expect(classifyDatabaseError(Object.assign(new Error('x'), { code: 'nope', severity: 'ERROR' }))).toBeNull(); // non-SQLSTATE code
    expect(classifyDatabaseError(Object.assign(new Error('x'), { code: '42501' }))).toBeNull(); // no severity
    expect(classifyDatabaseError(null)).toBeNull();
    expect(classifyDatabaseError('42501')).toBeNull();
  });
});
