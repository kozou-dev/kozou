import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_HTTP_PORT,
  buildMcpConnectionInfo,
  isMcpLinkOffered,
  resolveMcpHttpPort,
} from '../../src/lib/connect/mcp-connection.js';

describe('isMcpLinkOffered', () => {
  it('treats an absent value as offered, so a standalone UI keeps the page', () => {
    // Only `kozou dev` with server.mcp.http.enabled false sets this. Every
    // other way of running the UI leaves it unset and must behave as before.
    expect(isMcpLinkOffered(undefined)).toBe(true);
    expect(isMcpLinkOffered('')).toBe(true);
    expect(isMcpLinkOffered('   ')).toBe(true);
  });

  it('opts out only on the value kozou dev writes', () => {
    expect(isMcpLinkOffered('off')).toBe(false);
    expect(isMcpLinkOffered('OFF')).toBe(false);
    expect(isMcpLinkOffered(' off ')).toBe(false);
  });

  it('treats any other value as offered rather than guessing at intent', () => {
    // A malformed value must not hide a page for an endpoint that is serving;
    // the safe direction here is the pre-existing behaviour. Note this is an
    // internal CLI-to-UI channel, so `false` is not a value anything writes —
    // the operator-facing knob is server.mcp.http.enabled /
    // KOZOU_MCP_HTTP_ENABLED, which loadConfig validates strictly.
    expect(isMcpLinkOffered('true')).toBe(true);
    expect(isMcpLinkOffered('false')).toBe(true);
    expect(isMcpLinkOffered('0')).toBe(true);
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
    });
    // The MCP server is co-located on the same host, different port; the path
    // (/connect) is irrelevant — only the origin's protocol + hostname matter.
    expect(info.httpUrl).toBe('https://kozou.example.com:3334/mcp');
  });

  it('reflects a custom MCP port', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('http://127.0.0.1:3333/'),
      mcpPort: 9999,
    });
    expect(info.httpUrl).toBe('http://127.0.0.1:9999/mcp');
  });

  it('the config never carries a secret (no DATABASE_URL on the HTTP path)', () => {
    const info = buildMcpConnectionInfo({
      requestUrl: new URL('http://localhost:3333/'),
      mcpPort: 3334,
    });
    expect(info.jsonConfig).not.toContain('DATABASE_URL');
    expect(info.claudeCodeCommand).not.toContain('DATABASE_URL');
  });
});
