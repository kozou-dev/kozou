import { describe, expect, it } from 'vitest';

import { loadConfig, type KozouConfig } from '../src/config.js';
import { resolveMcpAnnotationRole } from '../src/commands/mcp.js';

async function makeConfig(): Promise<KozouConfig> {
  return loadConfig({ skipFile: true, env: { DATABASE_URL: 'postgres://u:p@db:5432/app' } });
}

describe('resolveMcpAnnotationRole (#99) — the role describe tools annotate', () => {
  it('returns undefined when respectPrivileges is off (schema-wide)', async () => {
    const config = await makeConfig();
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBeUndefined();
    // Even with execution active, off means off.
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBeUndefined();
  });

  it('describe-only: resolves the configured role', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'reporter' },
    };
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('reporter');
  });

  it('describe-only: falls back to auth.ui.role / defaultRole', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user' } },
    };
    expect(resolveMcpAnnotationRole(config, undefined, {})).toBe('app_user');
  });

  it('describe-only: refuses to guess a ready-made token’s role', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
      auth: { jwt: { secret: 's' }, ui: { role: 'app_user', token: 'ready.made.jwt' } },
    };
    expect(() => resolveMcpAnnotationRole(config, undefined, {})).toThrow();
  });

  it('execution on: annotates the execution role (so it matches what the agent does)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true },
    };
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBe('mcp_exec');
  });

  it('execution on: a conflicting introspection.role throws (no silent says-A-does-B)', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'reporter' },
    };
    expect(() => resolveMcpAnnotationRole(config, 'mcp_exec', {})).toThrow(/differs from/);
  });

  it('execution on: a matching introspection.role is accepted', async () => {
    const base = await makeConfig();
    const config: KozouConfig = {
      ...base,
      introspection: { respectPrivileges: true, role: 'mcp_exec' },
    };
    expect(resolveMcpAnnotationRole(config, 'mcp_exec', {})).toBe('mcp_exec');
  });
});
