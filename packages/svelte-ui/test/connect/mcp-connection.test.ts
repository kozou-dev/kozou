import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_HTTP_PORT,
  buildMcpConnectionInfo,
  describeMcpAuth,
  resolveMcpHttpPort,
  resolveMcpPosture,
} from '../../src/lib/connect/mcp-connection.js';

describe('resolveMcpPosture', () => {
  it('reads an absent value as local, so a standalone UI keeps the page', () => {
    // Every way of running the UI that is not `kozou dev` leaves this unset,
    // and that run *is* the unauthenticated local posture.
    expect(resolveMcpPosture(undefined)).toBe('local');
    expect(resolveMcpPosture('')).toBe('local');
    expect(resolveMcpPosture('   ')).toBe('local');
  });

  it('reads the three postures kozou dev writes', () => {
    expect(resolveMcpPosture('off')).toBe('off');
    expect(resolveMcpPosture('local')).toBe('local');
    expect(resolveMcpPosture('oauth')).toBe('oauth');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(resolveMcpPosture('OFF')).toBe('off');
    expect(resolveMcpPosture(' off ')).toBe('off');
    expect(resolveMcpPosture(' OAuth ')).toBe('oauth');
  });

  it('reads an unrecognized value as unknown rather than guessing local', () => {
    // The only way here is a CLI newer than this build (a posture added later).
    // Guessing `local` would state "no authentication" about an endpoint that
    // may have some — the exact defect this channel exists to remove. `off`
    // would hide a page for an endpoint that is in fact serving, so `unknown`
    // keeps the (posture-independent) URL and snippets and drops the claim.
    expect(resolveMcpPosture('mtls')).toBe('unknown');
    expect(resolveMcpPosture('true')).toBe('unknown');
    expect(resolveMcpPosture('false')).toBe('unknown');
    expect(resolveMcpPosture('0')).toBe('unknown');
  });
});

describe('describeMcpAuth', () => {
  it('states the absence of authentication only for the local posture', () => {
    expect(describeMcpAuth('local')).toContain('no authentication');
  });

  it('says nothing about where the endpoint listens or how far it reaches', () => {
    // The note used to say the server "binds to loopback by default". Both
    // shipped compose stacks set KOZOU_MCP_HTTP_HOST=0.0.0.0, so for the
    // flagship `docker compose up` the page and the container's own stderr
    // disagreed — and the page was the reassuring one. Pointing at the bind
    // host instead was no better: in that deployment reach is decided by the
    // compose port publishing (127.0.0.1:3334), not by the 0.0.0.0 bind, and
    // an Admin UI run on its own resolves to `local` with no CLI output to
    // consult at all.
    //
    // Shapes, not fixed phrases: every wording that slipped past the first
    // version of this guard was a different spelling of one idea ("your
    // machine only", "the local interface", "not reachable from the LAN",
    // "::1", "only from this computer"). Matching the *shape* of a reach
    // claim catches those without banning ordinary words — the OAuth note
    // legitimately says the URL is "already right for a proxy or another
    // machine", which a plain vocabulary ban would have failed.
    const REACH_CLAIMS = [
      /\bloopback\b/,
      /\blocalhost\b/,
      /\b127\./,
      /::1/,
      /\b0\.0\.0\.0\b/,
      /\bbinds?\b|\bbound\b/,
      /\bonly (?:from|on|to)\b/,
      /\b(?:machine|computer|host|interface|network|lan)s? only\b/,
      /\bnot reachable\b/,
      /\breachable (?:only|from)\b/,
    ];
    for (const posture of ['local', 'oauth', 'unknown'] as const) {
      const note = describeMcpAuth(posture).toLowerCase();
      for (const claim of REACH_CLAIMS) {
        expect(note, `${posture} note makes a reach claim: ${String(claim)}`).not.toMatch(claim);
      }
    }
    // What remains is true wherever the note renders: no authentication, so
    // reaching the port is the whole of the access control.
    expect(describeMcpAuth('local')).toBe(
      'The MCP HTTP server has no authentication, so anything that can reach the port ' +
        'can read your schema.',
    );
  });

  it('describes an OAuth-protected resource without claiming there is no auth', () => {
    const note = describeMcpAuth('oauth');
    expect(note).not.toContain('no authentication');
    expect(note).toContain('OAuth 2.1 protected resource');
    // What still holds under OAuth is the *shape* — one URL, no client secret.
    // It must not claim the URL is the same as in the other postures: in this
    // posture it is the declared canonical resource, which is the whole point.
    expect(note).not.toContain('the same either way');
    expect(note).toContain('canonical');
  });

  it('hedges rather than asserting a posture it does not know', () => {
    const note = describeMcpAuth('unknown');
    expect(note).not.toContain('no authentication');
    expect(note).toContain('server.mcp.http.auth');
    // Points at the likelier cause of all: a typo in a value the README tells
    // operators to set by hand. Blaming version skew alone sent them looking
    // for a mismatch that a standalone UI (no CLI at all) cannot have.
    expect(note).toContain('KOZOU_UI_MCP_POSTURE');
    expect(note).toContain('typo');
  });
});

describe('resolveMcpHttpPort', () => {
  it('returns the parsed port for a valid env value', () => {
    expect(resolveMcpHttpPort('9999')).toBe(9999);
  });

  it('falls back to the default for absent / blank / malformed / out-of-range', () => {
    expect(resolveMcpHttpPort(undefined)).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('')).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('  ')).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('not-a-number')).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('3334.5')).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('0')).toBe(DEFAULT_MCP_HTTP_PORT);
    expect(resolveMcpHttpPort('70000')).toBe(DEFAULT_MCP_HTTP_PORT);
  });
});

describe('buildMcpConnectionInfo', () => {
  it('builds the live endpoint from the request host + MCP port (local dev)', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/'),
      mcpPort: 3334,
      posture: 'local',
    });
    expect(info.httpUrl).toBe('http://localhost:3334/mcp');
    expect(info.claudeCodeCommand).toBe(
      'claude mcp add --transport http kozou http://localhost:3334/mcp',
    );
    expect(JSON.parse(info.jsonConfig)).toEqual({
      mcpServers: { kozou: { type: 'http', url: 'http://localhost:3334/mcp' } },
    });
  });

  it('takes the host from the request, not a hardcoded localhost', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('https://kozou.example.com/connect'),
      mcpPort: 3334,
      posture: 'local',
    });
    // This is the *fallback*, and it holds only while the MCP server really is
    // co-located on the same host at the bind port. That assumption is what a
    // published-port remap, a tunnel or a proxy breaks, which is why a declared
    // address wins over it — see the advertisedUrl tests below. The path
    // (/connect) is irrelevant either way: only the origin's protocol +
    // hostname feed the guess.
    expect(info.httpUrl).toBe('https://kozou.example.com:3334/mcp');
  });

  it('reflects a custom MCP port', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('http://127.0.0.1:3333/'),
      mcpPort: 9999,
      posture: 'local',
    });
    expect(info.httpUrl).toBe('http://127.0.0.1:9999/mcp');
  });

  it('the config never carries a secret (no DATABASE_URL on the HTTP path)', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/'),
      mcpPort: 3334,
      posture: 'local',
    });
    expect(info.jsonConfig).not.toContain('DATABASE_URL');
    expect(info.claudeCodeCommand).not.toContain('DATABASE_URL');
  });

  it('registers the same shape whatever the posture: one URL, no secret', () => {
    // An MCP client discovers the authorization server from the endpoint's own
    // RFC 9728 metadata, so no posture needs an extra field in the config — no
    // client id, no token. If that ever stops holding, the page needs more than
    // a different paragraph.
    const at = (posture: 'local' | 'oauth' | 'unknown') =>
      buildMcpConnectionInfo({
        requestUrl: new URL('https://kozou.example.com/connect'),
        mcpPort: 3334,
        posture,
        resourceUrl: 'https://mcp.example.com/mcp',
      });
    for (const posture of ['local', 'oauth', 'unknown'] as const) {
      const info = at(posture);
      expect(JSON.parse(info.jsonConfig)).toEqual({
        mcpServers: { kozou: { type: 'http', url: info.httpUrl } },
      });
      expect(info.claudeCodeCommand).toBe(
        `claude mcp add --transport http kozou ${info.httpUrl}`,
      );
    }
    // The URL is not posture-independent, and that is the fix: only `oauth` has
    // a declared canonical address to prefer over the request host.
    expect(at('oauth').httpUrl).toBe('https://mcp.example.com/mcp');
    expect(at('local').httpUrl).toBe('https://kozou.example.com:3334/mcp');
    expect(at('unknown').httpUrl).toBe('https://kozou.example.com:3334/mcp');
  });

  it('prefers the canonical resource URI in the OAuth posture, verbatim', () => {
    // The deployment `resource` exists for: a proxy in front of the endpoint, so
    // the browser's host and port say nothing about where a client should
    // connect. Used verbatim — it identifies the endpoint, so no path is
    // appended and no port is invented.
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('https://admin.internal:3333/connect'),
      mcpPort: 3334,
      posture: 'oauth',
      resourceUrl: 'https://mcp.example.com/mcp',
    });
    expect(info.httpUrl).toBe('https://mcp.example.com/mcp');
    expect(info.claudeCodeCommand).toContain('https://mcp.example.com/mcp');
    expect(info.jsonConfig).toContain('https://mcp.example.com/mcp');
    expect(info.httpUrl).not.toContain('admin.internal');
    expect(info.httpUrl).not.toContain('3334');
  });

  it('prefers the declared reachable address outside the OAuth posture, verbatim', () => {
    // Issue #258: the endpoint is published on a remapped host port, so the
    // bind port the page is handed is not where anything answers. Used
    // verbatim, exactly like `resource` — no port appended, no path invented.
    for (const posture of ['local', 'unknown'] as const) {
      const info = buildMcpConnectionInfo({
        requestUrl: new URL('http://localhost:3333/connect'),
        mcpPort: 3334,
        posture,
        advertisedUrl: 'http://localhost:4334/mcp',
      });
      expect(info.httpUrl).toBe('http://localhost:4334/mcp');
      expect(info.claudeCodeCommand).toContain('http://localhost:4334/mcp');
      expect(info.jsonConfig).toContain('http://localhost:4334/mcp');
      expect(info.httpUrl).not.toContain('3334');
    }
  });

  it('does not derive the URL from the request at all when an address is declared', () => {
    // A form-level guard rather than a copy check: whatever the browser reached
    // the Admin UI on — scheme, host, port — the declared address is what comes
    // out, byte for byte. A rebuild that merely happens to agree on one input
    // (or that grafts on the request's scheme or port) breaks invariance here,
    // where a substring assertion on a single case would let it through.
    const declared = 'https://mcp.example.com/mcp';
    const requests = [
      'http://localhost:3333/connect',
      'https://kozou.example.com/connect',
      'http://127.0.0.1:8080/connect',
      'https://admin.internal:9443/connect?x=1',
    ];
    const built = requests.map(
      (href) =>
        buildMcpConnectionInfo({
          requestUrl: new URL(href),
          mcpPort: 3334,
          posture: 'local',
          advertisedUrl: declared,
        }).httpUrl,
    );
    expect(new Set(built)).toEqual(new Set([declared]));
  });

  it('ignores a declared reachable address in the OAuth posture', () => {
    // The schema refuses the combination, so this is defence in depth — but the
    // direction matters: an MCP client discovers the endpoint from its RFC 9728
    // metadata, which names `resource`, so `resource` is the address to hand out
    // whenever both somehow arrive.
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('https://admin.internal:3333/connect'),
      mcpPort: 3334,
      posture: 'oauth',
      resourceUrl: 'https://mcp.example.com/mcp',
      advertisedUrl: 'http://localhost:4334/mcp',
    });
    expect(info.httpUrl).toBe('https://mcp.example.com/mcp');
  });

  it('falls back to the request host when the declared address is blank', () => {
    // Same treatment as an empty resource: render the guess rather than an
    // empty or `undefined/mcp` URL.
    for (const advertisedUrl of ['', '   ']) {
      const info = buildMcpConnectionInfo({
        requestUrl: new URL('http://localhost:3333/'),
        mcpPort: 3334,
        posture: 'local',
        advertisedUrl,
      });
      expect(info.httpUrl).toBe('http://localhost:3334/mcp');
    }
  });

  it('says the URL was declared when it was, and points at the right field', () => {
    // The template used to carry one fixed sentence: "the URL uses the host
    // Kozou is configured with and the MCP port… adjust the host accordingly".
    // With a declared address that is false, and it sends the operator away
    // from the address they declared. The note has to track the address.
    const declared = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/connect'),
      mcpPort: 3334,
      posture: 'local',
      advertisedUrl: 'http://localhost:4334/mcp',
    });
    expect(declared.addressNote).toContain('server.mcp.http.advertisedUrl');
    expect(declared.addressNote).not.toMatch(/adjust the host/i);

    const viaResource = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/connect'),
      mcpPort: 3334,
      posture: 'oauth',
      resourceUrl: 'https://mcp.example.com/mcp',
    });
    expect(viaResource.addressNote).toContain('server.mcp.http.auth.resource');
  });

  it('says the URL is derived, and names the field that would replace it, when nothing was declared', () => {
    const guessed = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/connect'),
      mcpPort: 3334,
      posture: 'local',
    });
    // Naming the fix is the point: this page is where an operator finds out the
    // address is wrong, so it is where the way to correct it belongs.
    expect(guessed.addressNote).toContain('server.mcp.http.advertisedUrl');
    expect(guessed.addressNote).not.toContain('you declared');
  });

  it('never claims an address was declared when it was guessed, or the reverse', () => {
    // Form-level: the note and the URL must agree across every combination,
    // rather than each being right in the one case a copy check pins down.
    const cases = [
      { posture: 'local' as const, advertisedUrl: 'http://localhost:4334/mcp', declared: true },
      { posture: 'local' as const, advertisedUrl: undefined, declared: false },
      { posture: 'unknown' as const, advertisedUrl: 'http://localhost:4334/mcp', declared: true },
      { posture: 'unknown' as const, advertisedUrl: undefined, declared: false },
    ];
    for (const { posture, advertisedUrl, declared } of cases) {
      const info = buildMcpConnectionInfo({
        requestUrl: new URL('http://localhost:3333/connect'),
        mcpPort: 3334,
        posture,
        advertisedUrl,
      });
      const saysDeclared = info.addressNote.includes('you declared');
      expect(saysDeclared).toBe(declared);
      // And the claim matches what actually came out.
      expect(info.httpUrl === advertisedUrl).toBe(declared);
    }
  });

  it('ignores a resource URI outside the OAuth posture', () => {
    // Only `oauth` means the operator declared one; a value reaching the other
    // postures is stale inheritance, not an address for this runtime.
    for (const posture of ['local', 'unknown'] as const) {
      const info = buildMcpConnectionInfo({
        requestUrl: new URL('http://localhost:3333/'),
        mcpPort: 3334,
        posture,
        resourceUrl: 'https://mcp.example.com/mcp',
      });
      expect(info.httpUrl).toBe('http://localhost:3334/mcp');
    }
  });

  it('falls back to the request host when OAuth reports no resource', () => {
    // The schema requires `resource` wherever an auth block exists, so this is
    // unreachable through the CLI — but rendering nothing, or `undefined/mcp`,
    // would be worse than the guess the other postures live with.
    for (const resourceUrl of [undefined, '', '   ']) {
      const info = buildMcpConnectionInfo({
        requestUrl: new URL('http://localhost:3333/'),
        mcpPort: 3334,
        posture: 'oauth',
        resourceUrl,
      });
      expect(info.httpUrl).toBe('http://localhost:3334/mcp');
    }
  });
});
