import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The real scaffold templates (not the copy mechanics — scaffold.test.ts
// covers those). Guards the contract between config.ts's env-var surface
// and what the scaffolded compose stack actually forwards: a variable
// documented in env.example but not forwarded by docker-compose.yml never
// reaches the container, which silently disables auth.

const composeUrl = new URL('../src/templates/docker-compose.yml', import.meta.url);
const envExampleUrl = new URL('../src/templates/env.example', import.meta.url);

// Every shipped compose file that brings up `kozou dev` — the Admin UI and the
// MCP HTTP server are unauthenticated by default, so they must be published on
// host loopback, never on all interfaces.
const NO_AUTH_HTTP_COMPOSE_FILES = [
  composeUrl,
  new URL('../../../examples/quickstart/docker-compose.yml', import.meta.url),
];

// Every auth-related env var accepted by loadConfig (injectAuthFromEnv in
// src/config.ts). Extending the config surface without forwarding the new
// variable here re-creates the silent-auth-off footgun.
const AUTH_ENV_VARS = [
  'KOZOU_JWT_SECRET',
  'KOZOU_JWT_PUBLIC_KEY',
  'KOZOU_JWT_JWKS_URI',
  'KOZOU_JWT_ALGORITHMS',
  'KOZOU_JWT_ISSUER',
  'KOZOU_JWT_AUDIENCE',
  'KOZOU_JWT_ROLE_CLAIM',
  'KOZOU_JWT_ALLOWED_ROLES',
  'KOZOU_JWT_DEFAULT_ROLE',
  'KOZOU_JWT_ANON_ROLE',
  'KOZOU_JWT_CLAIMS_GUC',
  'KOZOU_UI_ROLE',
  'KOZOU_UI_CLAIMS',
  'KOZOU_ADAPTER_TOKEN',
];

describe('scaffold templates', () => {
  it('docker-compose.yml forwards every auth env var with an empty-string default', async () => {
    const compose = await readFile(fileURLToPath(composeUrl), 'utf8');
    for (const name of AUTH_ENV_VARS) {
      // `${VAR:-}` so an unset host variable arrives as an empty string,
      // which loadConfig treats as unset (covered in config.test.ts).
      expect(compose).toContain(`${name}: \${${name}:-}`);
    }
  });

  it('every KOZOU_* variable mentioned in env.example is forwarded by docker-compose.yml', async () => {
    const compose = await readFile(fileURLToPath(composeUrl), 'utf8');
    const envExample = await readFile(fileURLToPath(envExampleUrl), 'utf8');
    const mentioned = [...envExample.matchAll(/^#?\s*(KOZOU_[A-Z0-9_]+)=/gm)].map((m) => m[1]!);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const name of mentioned) {
      // KOZOU_ORIGIN is consumed by compose interpolation itself (ORIGIN);
      // KOZOU_ADAPTER_URL is part of the documented external-REST opt-out
      // editing, not the default stack.
      if (name === 'KOZOU_ORIGIN' || name === 'KOZOU_ADAPTER_URL') continue;
      expect(compose, `${name} is documented in env.example but not forwarded`).toContain(
        `${name}: \${${name}:-}`,
      );
    }
  });

  it('publishes every port on host loopback only (no all-interface binds)', async () => {
    for (const url of NO_AUTH_HTTP_COMPOSE_FILES) {
      const compose = await readFile(fileURLToPath(url), 'utf8');
      const label = url.pathname;
      // Uncommented compose short-syntax port entries (`- "<mapping>"`),
      // allowing a trailing inline comment (`# Admin UI`); a mapping ends in
      // `:<container-port>`. Commented lines start with `#` and are skipped by
      // the leading `-` anchor.
      const ports = [...compose.matchAll(/^\s*-\s*"([^"]+)"\s*(?:#.*)?$/gm)]
        .map((m) => m[1]!)
        .filter((s) => /:\d+$/.test(s));
      expect(ports.length, `${label}: expected at least one published port`).toBeGreaterThan(0);
      for (const mapping of ports) {
        // The bundled stack runs no-auth surfaces (Admin UI, MCP) and a
        // default-credential database; every host publish must be loopback-only.
        expect(mapping, `${label}: "${mapping}" must publish on 127.0.0.1`).toMatch(
          /^127\.0\.0\.1:/,
        );
      }
    }
  });
});
