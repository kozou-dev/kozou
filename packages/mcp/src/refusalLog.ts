// Server-side record of why an OAuth-mode request was refused. The client is
// told as little as before — a 401 never says which check failed — but the
// operator gets one stderr line per refusal naming it, which is the only way
// to tell an issuer mismatch from an expired token from a missing role claim
// when the client shows nothing but "needs authentication".
//
// A line is built from fixed text, configuration (the role claim's name, a
// scope's configured name) and the reason code. Never from the request: not
// the token, not a claim value, not a header, not the path the client sent.
//
// Volume is capped per reason, so a flood of garbage tokens cannot bury the
// one line the operator is looking for, nor grow the log without bound: at
// most PER_WINDOW lines per reason per window, then a single count when the
// window closes.

import type { AuthFailureReason } from '@kozou/core/auth';

/** Every reason this endpoint can refuse for: the authenticator's, plus the
 *  scope check that lives in this package, plus a catch-all for an auth error
 *  that arrives without a reason. */
export type RefusalCode = AuthFailureReason | 'insufficient_scope' | 'unclassified';

const PER_WINDOW = 5;
const WINDOW_MS = 60_000;

/** What a line may name beyond fixed text — configuration only. */
export type RefusalContext = {
  /** The configured role claim name. */
  roleClaim: string;
  /** The configured name of the scope a request lacked. */
  scope?: string;
};

/** The status each code answers with, so a line cannot claim one the
 *  response did not send. Every code is listed, so a new one does not
 *  compile until it is given a status. */
export function refusalStatus(code: RefusalCode): 401 | 403 {
  switch (code) {
    case 'role_missing':
    case 'role_unreadable':
    case 'role_not_allowed':
    case 'insufficient_scope':
      return 403;
    case 'no_token':
    case 'malformed_header':
    case 'malformed_token':
    case 'algorithm_not_allowed':
    case 'unknown_key':
    case 'ambiguous_key':
    case 'jwks_unavailable':
    case 'bad_signature':
    case 'expired':
    case 'not_yet_valid':
    case 'issuer_mismatch':
    case 'issuer_missing':
    case 'audience_mismatch':
    case 'audience_missing':
    case 'claims_invalid':
    case 'other_token_error':
    case 'unclassified':
      return 401;
  }
}

/** Where a setting named in a line lives. The library's `auth` option and the
 *  kozou CLI's `server.mcp.http.auth` hold the same keys; the CLI's top-level
 *  `auth` block is the REST surface's, and its `jwt.audience` never reaches
 *  this endpoint, so a line must not send the operator there. */
const IN_SETTINGS = 'in the MCP auth settings (server.mcp.http.auth for the kozou CLI)';

/** The explanation for a code. */
export function describeRefusal(code: RefusalCode, ctx: RefusalContext): string {
  switch (code) {
    case 'no_token':
      return (
        'the request carried no bearer token. A client sends one of these first, before it ' +
        'signs in, so on its own this is the normal start of a connection.'
      );
    case 'malformed_header':
      return 'the Authorization header is not of the form "Bearer <token>".';
    case 'malformed_token':
      return 'the bearer token is not a well-formed JWT.';
    case 'algorithm_not_allowed':
      return `the token is signed with an algorithm that jwt.algorithms ${IN_SETTINGS} does not accept.`;
    case 'unknown_key':
      return (
        'no key in the JWKS matches the token: usually its "kid" is not published (a token from ' +
        'another realm or tenant, or one signed with a key that has been rotated out).'
      );
    case 'ambiguous_key':
      return (
        'more than one key in the JWKS matches the token, so none is chosen: the token carries no ' +
        '"kid" while several keys fit, or the key set repeats its "kid". The key set or the ' +
        'authorization server is at fault, not this one token.'
      );
    case 'jwks_unavailable':
      return (
        `the key set at jwt.jwksUri ${IN_SETTINGS} answered with something unusable (a timeout, ` +
        'a non-200 response, a body that is not JSON, or a malformed key set). This is a fault on ' +
        'the server side, not the client\'s.'
      );
    case 'bad_signature':
      return 'the token\'s signature does not verify against the configured key.';
    case 'expired':
      return 'the token has expired ("exp" is in the past).';
    case 'not_yet_valid':
      return 'the token is not valid yet ("nbf" is in the future); check the clocks.';
    case 'issuer_mismatch':
      return (
        `the token's "iss" is not an accepted issuer: jwt.issuer ${IN_SETTINGS}, or their ` +
        'authorizationServers when it is unset.'
      );
    case 'issuer_missing':
      return 'the token carries no "iss" claim, and one is required.';
    case 'audience_mismatch':
      return (
        `the token's "aud" is not an accepted audience: jwt.audience ${IN_SETTINGS}, or their ` +
        "resource when it is unset. The REST surface's audience never applies here."
      );
    case 'audience_missing':
      return 'the token carries no "aud" claim, and one is required.';
    case 'claims_invalid':
      return 'a registered claim of the token is malformed (a time claim that is not a number).';
    case 'other_token_error':
      return (
        'the JWT verifier refused the token for a reason none of the other codes cover (an ' +
        'unrecognised critical header parameter, for example).'
      );
    case 'role_missing':
      return (
        `the token carries no "${ctx.roleClaim}" claim. This endpoint has no default role: ` +
        'the role must come from the token, so assign it in the authorization server.'
      );
    case 'role_unreadable':
      return (
        `the token's "${ctx.roleClaim}" claim is not a single role name (a list, a number, an ` +
        'object, or an empty string). An authorization-server mapper that emits a list is the ' +
        'usual cause.'
      );
    case 'role_not_allowed':
      return `the role the token names is not in allowedRoles ${IN_SETTINGS}.`;
    case 'insufficient_scope':
      return `the token lacks the "${ctx.scope ?? ''}" scope this request needs.`;
    case 'unclassified':
      return 'the request was refused for a reason this server does not classify.';
  }
}

type Window = {
  start: number;
  logged: number;
  suppressed: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

export type RefusalLogOptions = {
  prefix: string;
  /** Where lines go. Default: process.stderr. */
  write?: (line: string) => void;
  /** Clock and timers, injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** One stderr line per refusal, capped per reason. */
export class RefusalLog {
  private readonly prefix: string;
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly windows = new Map<RefusalCode, Window>();

  constructor(opts: RefusalLogOptions) {
    this.prefix = opts.prefix;
    this.write = opts.write ?? ((line) => void process.stderr.write(line));
    // Monotonic: a wall clock stepped back would hold a window open, and
    // silence its reason, for as long as the step.
    this.now = opts.now ?? (() => performance.now());
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        // A pending count must not keep the process alive on its own.
        timer.unref();
        return timer;
      });
    this.clearTimer = opts.clearTimer ?? clearTimeout;
  }

  record(code: RefusalCode, ctx: RefusalContext): void {
    const now = this.now();
    let window = this.windows.get(code);
    if (window !== undefined && now - window.start >= WINDOW_MS) {
      // The window closed before its timer fired: report it here instead.
      this.flush(code, window);
      window = undefined;
    }
    if (window === undefined) {
      window = { start: now, logged: 0, suppressed: 0, timer: undefined };
      this.windows.set(code, window);
    }
    if (window.logged < PER_WINDOW) {
      window.logged += 1;
      this.write(`${this.line(code)}: ${describeRefusal(code, ctx)}\n`);
      return;
    }
    window.suppressed += 1;
    if (window.timer === undefined) {
      const open = window;
      open.timer = this.setTimer(() => {
        open.timer = undefined;
        if (this.windows.get(code) === open) this.flush(code, open);
      }, open.start + WINDOW_MS - now);
    }
  }

  /** Report whatever is still uncounted and drop every pending timer. */
  close(): void {
    for (const [code, window] of [...this.windows]) this.flush(code, window);
  }

  private flush(code: RefusalCode, window: Window): void {
    if (window.timer !== undefined) {
      this.clearTimer(window.timer);
      window.timer = undefined;
    }
    this.windows.delete(code);
    if (window.suppressed === 0) return;
    const seconds = Math.round(WINDOW_MS / 1000);
    this.write(
      `${this.line(code)}: ${window.suppressed} more in the same ${seconds}s, ` +
        `not logged one by one.\n`,
    );
  }

  private line(code: RefusalCode): string {
    return `${this.prefix} auth ${refusalStatus(code)} ${code}`;
  }
}
