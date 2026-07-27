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

  it('describes an OAuth-protected resource without claiming there is no auth', () => {
    const note = describeMcpAuth('oauth');
    expect(note).not.toContain('no authentication');
    expect(note).toContain('OAuth 2.1 protected resource');
    // The point of the page still holds under OAuth: nothing above it changes.
    expect(note).toContain('the same either way');
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
    // The MCP server is co-located on the same host, different port; the path
    // (/connect) is irrelevant — only the origin's protocol + hostname matter.
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

  it('registers the same URL and snippets whatever the posture', () => {
    // The finding this page was wrong about: an MCP client discovers the
    // authorization server from the endpoint's own RFC 9728 metadata, so an
    // OAuth deployment registers exactly what an unauthenticated one does.
    // Only the wording differs — if that ever stops holding, the page needs
    // more than a different paragraph.
    const at = (posture: 'local' | 'oauth' | 'unknown') =>
      buildMcpConnectionInfo({
        requestUrl: new URL('https://kozou.example.com/connect'),
        mcpPort: 3334,
        posture,
      });
    const local = at('local');
    for (const posture of ['oauth', 'unknown'] as const) {
      const other = at(posture);
      expect(other.httpUrl).toBe(local.httpUrl);
      expect(other.jsonConfig).toBe(local.jsonConfig);
      expect(other.claudeCodeCommand).toBe(local.claudeCodeCommand);
      expect(other.authNote).not.toBe(local.authNote);
    }
  });
});
