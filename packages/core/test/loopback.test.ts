import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isLoopbackUrl } from '../src/loopback.js';

describe('isLoopbackHost', () => {
  it('recognises loopback hosts', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('recognises every spelling of this machine, not only the common four', () => {
    // Each of these used to be reported as a non-loopback bind, so the startup
    // messages told a loopback deployment it was reachable from elsewhere.
    for (const host of [
      'LOCALHOST',
      'Localhost',
      'localhost.',
      '127.0.0.2',
      '127.0.0.5',
      '::ffff:127.0.0.2',
      '::FFFF:7F00:1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('gives the same answer as the declared-address check for a canonically spelled host', () => {
    // One question asked in three places: the bind host, a declared
    // advertisedUrl, and an advertised OAuth URL. A host must not be loopback
    // for one of them and off-box for another.
    for (const host of [
      '127.0.0.1',
      'LOCALHOST',
      'localhost.',
      '127.0.0.5',
      '::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
      '::',
      '192.168.1.10',
      'mcp.example.com',
    ]) {
      const authority = host.includes(':') ? `[${host}]` : host;
      expect(isLoopbackHost(host), host).toBe(isLoopbackUrl(new URL(`http://${authority}/`)));
    }
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '::', '', '192.168.1.10', 'example.com', '::ffff:0.0.0.0']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('rejects a string that is not a bare host, rather than reading a host out of it', () => {
    // A URL parser finds a loopback host in every one of these; it silently
    // drops a tab or newline, so the last two read as `::1`. None of them can be
    // bound, and a warning gated on this has to err toward speaking.
    for (const host of [
      'evil.com@localhost',
      'localhost/x',
      '%6Cocalhost',
      'localhost:3334',
      '[::1]',
      '::\t1',
      '::1\n',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('rejects a host the URL parser would rewrite, which a resolver may read differently', () => {
    // A URL parser reads `0177.0.0.1` as octal (127.0.0.1); the macOS resolver
    // reads it as decimal (177.0.0.1) and binds there, or fails. Shorthand and
    // full-width spellings are rewritten the same way, so none is trusted.
    for (const host of [
      '0177.0.0.1',
      '127.000.0.1',
      '127.1',
      '0x7f.1',
      '2130706433',
      'ｌｏｃａｌｈｏｓｔ',
      'local­host',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('answers false rather than throwing for a value that is not a string', () => {
    // Exported: a plain JavaScript caller can pass an unset environment variable.
    for (const value of [undefined, null, 3334]) {
      expect(isLoopbackHost(value as unknown as string), String(value)).toBe(false);
    }
  });
});
