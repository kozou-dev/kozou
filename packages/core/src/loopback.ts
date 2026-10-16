// Whether a host or a URL names the local machine. One implementation shared
// by every server package (@kozou/mcp and @kozou/api re-export
// `isLoopbackHost` under the same name), so a bind host is never loopback to
// one of them and off-box to another, and a startup message never calls a
// loopback listener non-loopback because a second copy fell out of step.
//
// This module is exported as `@kozou/core/net` — a separate entry point so
// that the type declarations of `@kozou/core` itself never name the global
// `URL` type, which a consumer compiling without DOM or Node typings lacks.

/** Whether a URL names the local machine: loopback per the RFC 8252 native-app
 *  convention — `localhost`, any 127.0.0.0/8 address, `::1` — plus the
 *  IPv4-mapped forms of those addresses. The one answer to "is this address
 *  off-box?" wherever it is asked: the plaintext refusal for advertised OAuth
 *  URLs, the no-authentication warning for a declared reachable address, and
 *  the bind host itself ({@link isLoopbackHost}, which asks through this).
 *  Each of those is an address the operator configured; this is not meant to
 *  judge untrusted input. */
export function isLoopbackUrl(url: URL): boolean {
  // A WHATWG URL keeps IPv6 brackets in `hostname`, so they are stripped first.
  const bracketed =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  // A single trailing dot is the absolute form of the same name — the same rule
  // the rebinding guard applies to a Host header, so the two must agree about
  // whether `localhost.` is local.
  const host = bracketed.length > 1 && bracketed.endsWith('.') ? bracketed.slice(0, -1) : bracketed;
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  // An IPv4-mapped IPv6 loopback is loopback. WHATWG URL rewrites the mapped
  // address in hex (`::ffff:127.0.0.1` -> `::ffff:7f00:1`), so the dotted
  // spelling an operator writes is never the one that arrives here.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped !== null) {
    const high = Number.parseInt(mapped[1] as string, 16);
    return high >> 8 === 127;
  }
  return /^::ffff:127(\.\d{1,3}){3}$/.test(host);
}

/** Whether a bind host is the local machine. Answered by the same predicate as
 *  an advertised or declared URL ({@link isLoopbackUrl}), so one host is never
 *  loopback in one startup message and off-box in the next: hostnames are
 *  case-insensitive, a trailing dot names the same host, and all of
 *  127.0.0.0/8, `::1` and their IPv4-mapped forms are loopback.
 *
 *  Not loopback, so a warning gated on this errs toward speaking: a string
 *  that is not a bare host (it carries a port, brackets, a path or userinfo),
 *  which cannot be bound; a name the URL parser would rewrite (IPv4 shorthand,
 *  a leading zero, a full-width character), which a resolver need not read the
 *  same way; and a value that is not a string at all.
 *
 *  It answers whether the host is this machine, not whether its spelling is
 *  one a caller already lists: a `127.0.0.2` bind is loopback, but its clients
 *  send `Host: 127.0.0.2`, so an allowlist of Host names needs that name added
 *  all the same. Nor is it meant to judge untrusted input: it decides what a
 *  startup message says about a bind host the operator configured. */
export function isLoopbackHost(host: string): boolean {
  // Exported, so a plain JavaScript caller can hand it an unset environment
  // variable; that names no host, and must not throw.
  if (typeof host !== 'string' || host === '' || /[\s/\\?#@%[\]]/.test(host)) return false;
  const ipv6 = host.includes(':');
  let url: URL;
  try {
    url = new URL(`http://${ipv6 ? `[${host}]` : host}/`);
  } catch {
    return false;
  }
  // `0177.0.0.1` is 127.0.0.1 to a URL parser and 177.0.0.1 to the macOS
  // resolver, so only a name the parser reads back unchanged is trusted. An
  // IPv6 literal has one reading, so its canonical rewrite is no disagreement.
  if (!ipv6 && url.hostname !== host.toLowerCase()) return false;
  return isLoopbackUrl(url);
}
