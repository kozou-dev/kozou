import { describe, expect, it } from 'vitest';

import { guardOptionsFromEnv } from '../src/cliEnv.js';

// The `kozou-mcp` bin reads no config file, so this mapping is the only route
// to the rebinding guard for that entry point. Left out, a tunnelled or
// `Host`-preserving-proxied deployment is refused on every request — the same
// gap the CLI config closes for `kozou dev` / `kozou mcp --http`.
describe('guardOptionsFromEnv', () => {
  it('maps both variables', () => {
    expect(
      guardOptionsFromEnv({
        KOZOU_MCP_HTTP_ADVERTISED_URL: 'https://mcp.example.com/mcp',
        KOZOU_MCP_HTTP_ALLOWED_HOSTS: 'tunnel.example.com, mcp.internal:3334',
      }),
    ).toEqual({
      advertisedUrl: 'https://mcp.example.com/mcp',
      allowedHosts: ['tunnel.example.com', 'mcp.internal:3334'],
    });
  });

  it('omits what the environment does not name', () => {
    expect(guardOptionsFromEnv({})).toEqual({});
  });

  it('reads empty and whitespace-only values as unset', () => {
    // Both shipped Compose stacks forward these as `${VAR:-}`, so an empty
    // value is the ordinary case: it must not become an unusable option the
    // server then refuses at startup, taking the whole stack down.
    for (const blank of ['', '   ']) {
      expect(
        guardOptionsFromEnv({
          KOZOU_MCP_HTTP_ADVERTISED_URL: blank,
          KOZOU_MCP_HTTP_ALLOWED_HOSTS: blank,
        }),
      ).toEqual({});
    }
    // A list of nothing is also nothing — but only for the list-valued one: a
    // comma is a perfectly ordinary character in a URL, so advertisedUrl keeps
    // whatever it was given and lets the server refuse it by its own rules.
    for (const blank of [',', ' , ']) {
      expect(guardOptionsFromEnv({ KOZOU_MCP_HTTP_ALLOWED_HOSTS: blank })).toEqual({});
    }
  });

  it('keeps one variable when only the other is blank', () => {
    expect(
      guardOptionsFromEnv({
        KOZOU_MCP_HTTP_ADVERTISED_URL: '  https://mcp.example.com/mcp  ',
        KOZOU_MCP_HTTP_ALLOWED_HOSTS: '',
      }),
    ).toEqual({ advertisedUrl: 'https://mcp.example.com/mcp' });
  });
});
