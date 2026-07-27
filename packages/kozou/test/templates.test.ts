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

const quickstartComposeUrl = new URL(
  '../../../examples/quickstart/docker-compose.yml',
  import.meta.url,
);
const quickstartEnvExampleUrl = new URL(
  '../../../examples/quickstart/.env.example',
  import.meta.url,
);

// Every shipped compose file that brings up `kozou dev` — the Admin UI and the
// MCP HTTP server are unauthenticated by default, so they must be published on
// host loopback, never on all interfaces.
const NO_AUTH_HTTP_COMPOSE_FILES = [composeUrl, quickstartComposeUrl];

// Each shipped stack, paired with the .env.example its README tells the reader
// to copy. Compose reads .env for ${VAR} interpolation only, so a variable
// documented in the example but not forwarded by the compose file never
// reaches the container: the operator sets it and nothing happens.
const SHIPPED_STACKS = [
  { compose: composeUrl, envExample: envExampleUrl, label: 'scaffold template' },
  { compose: quickstartComposeUrl, envExample: quickstartEnvExampleUrl, label: 'quickstart' },
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

  it('every KOZOU_* variable a stack documents in .env.example is forwarded by its compose file', async () => {
    // Run over both shipped stacks. Only the scaffold template was checked
    // before, so the quickstart — the copy most people run first — could
    // document an opt-out its compose file never forwards.
    for (const { compose: composeAt, envExample: envExampleAt, label } of SHIPPED_STACKS) {
      const compose = await readFile(fileURLToPath(composeAt), 'utf8');
      const envExample = await readFile(fileURLToPath(envExampleAt), 'utf8');
      const mentioned = [...envExample.matchAll(/^#?\s*(KOZOU_[A-Z0-9_]+)=/gm)].map((m) => m[1]!);
      expect(mentioned.length, `${label}: .env.example documents no KOZOU_* variable`).toBeGreaterThan(0);
      for (const name of mentioned) {
        // KOZOU_ORIGIN is consumed by compose interpolation itself (ORIGIN);
        // KOZOU_ADAPTER_URL is part of the documented external-REST opt-out
        // editing, not the default stack.
        if (name === 'KOZOU_ORIGIN' || name === 'KOZOU_ADAPTER_URL') continue;
        expect(compose, `${label}: ${name} is documented but not forwarded`).toContain(
          `${name}: \${${name}:-}`,
        );
      }
    }
  });

  it('every stack that forwards the MCP opt-out also documents it where the reader looks', async () => {
    // The other direction: the compose file tells the reader to set
    // KOZOU_MCP_HTTP_ENABLED, and the README tells them to copy .env.example.
    // If the variable is absent there, the instruction has no landing place.
    for (const { envExample: envExampleAt, label } of SHIPPED_STACKS) {
      const envExample = await readFile(fileURLToPath(envExampleAt), 'utf8');
      expect(envExample, `${label}: .env.example never mentions the MCP opt-out`).toMatch(
        /^#?\s*KOZOU_MCP_HTTP_ENABLED=/m,
      );
    }
  });

  it('every shipped stack forwards the MCP opt-out it documents', async () => {
    // Both files tell their reader that KOZOU_MCP_HTTP_ENABLED=false is how to
    // turn the endpoint off in a stack that ships no kozou.config.yaml. Compose
    // reads .env for interpolation only, so a variable that is not forwarded
    // here never reaches the container: the opt-out would silently do nothing
    // and the endpoint would keep serving. Only the scaffold template was
    // guarded, and the quickstart is the copy most people run first.
    for (const url of NO_AUTH_HTTP_COMPOSE_FILES) {
      const compose = await readFile(fileURLToPath(url), 'utf8');
      expect(
        compose,
        `${url.pathname}: documents the MCP opt-out but does not forward it`,
      ).toContain('KOZOU_MCP_HTTP_ENABLED: ${KOZOU_MCP_HTTP_ENABLED:-}');
    }
  });

  it('the published MCP port does not present itself as unconditionally served', async () => {
    for (const url of NO_AUTH_HTTP_COMPOSE_FILES) {
      const compose = await readFile(fileURLToPath(url), 'utf8');
      const mapping = compose.split('\n').find((line) => /^\s*-\s*"[^"]*:3334"/.test(line));
      expect(mapping, `${url.pathname}: no published MCP port found`).toBeDefined();
      // Compose has no conditional `ports`, so the line stays even when the
      // opt-out is set and nothing is served. A label that states the posture
      // flatly ("MCP HTTP (no auth)") then tells the operator the opposite of
      // what they just configured — in the one artifact that documents the
      // container path.
      const label = mapping ?? '';
      expect(label, `${url.pathname}: "${label.trim()}" claims a served endpoint`).toMatch(
        /opted out|opt-out|KOZOU_MCP_HTTP_ENABLED/i,
      );
      // The endpoint is unauthenticated unless server.mcp.http.auth is set.
      // That half predates the opt-out and must not quietly drop out while
      // the label is being edited to add the other one.
      expect(label, `${url.pathname}: the label no longer says the endpoint is unauthenticated`)
        .toMatch(/no auth/i);
      // And the condition must run in the direction it actually works: unset
      // means the endpoint IS served, so a label reading "set
      // KOZOU_MCP_HTTP_ENABLED=true to serve" is worse than no caveat at all.
      expect(label, `${url.pathname}: the label states the opt-out backwards`).not.toMatch(
        /=\s*true|to serve\b|to enable\b/i,
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
