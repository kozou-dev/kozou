// Map a thrown adapter error to a recoverable form-action failure.
//
// The create / update / delete form actions run a DataAdapter mutation that
// the database can reject (a unique / FK / CHECK violation, a privilege /
// row-level-security denial). @kozou/api maps those database outcomes to
// stable HTTP statuses with safe, generic messages, and the external REST
// adapter surfaces the backend's equivalent status; both raise an
// `AdapterError` carrying that status. Without handling, the rejection
// propagates to a generic 500 and the user loses everything they typed.

import { AdapterError } from '@kozou/ui-core';

export interface AdapterErrorFailure {
  /** The status to return from the form action (a client-meaningful 4xx). */
  status: number;
  /** A readable, backend-agnostic message safe to show the user. */
  message: string;
}

/**
 * Translate a caught error into a form-action failure descriptor, or return
 * `null` when it is not a recoverable client error and should propagate.
 *
 * Only a client-meaningful 4xx from an `AdapterError` is converted, so the
 * form can re-render with the user's input and a readable message. A 5xx, a
 * `0`-status network error, or any non-adapter error returns `null` and is
 * re-thrown by the caller — a genuine fault must stay a real error, not be
 * disguised as "your values were rejected".
 */
export function adapterErrorToFailure(err: unknown): AdapterErrorFailure | null {
  if (!(err instanceof AdapterError)) return null;
  const { status } = err;
  if (status < 400 || status >= 500) return null;
  return { status, message: messageForStatus(status) };
}

function messageForStatus(status: number): string {
  switch (status) {
    case 409:
      // unique / foreign-key conflict
      return 'That change conflicts with an existing record — a value that must be unique is already in use, or a related record is missing.';
    case 403:
      // privilege / row-level-security denial
      return 'You do not have permission to make this change.';
    case 404:
      return 'That record could not be found — it may have been deleted.';
    case 405:
      return 'This action is not allowed on this resource.';
    default:
      // 400 (check / not-null / unknown column / invalid value) and any other
      // client error: the database rejected the submitted values.
      return 'Some of the submitted values were rejected by the database. Please review them and try again.';
  }
}
