# Security Policy

Thank you for taking the time to investigate Kozou's security. We
appreciate responsible disclosure and aim to work with reporters to
resolve issues quickly.

## Reporting a Vulnerability

If you discover a security vulnerability in Kozou, **please do not
open a public GitHub issue.** Instead, report it through one of the
private channels below:

1. **Preferred — GitHub Security Advisories:**
   <https://github.com/kozou-dev/kozou/security/advisories/new>
2. **Alternative — email:** hello@kozou.org

We aim to acknowledge reports within **3 business days**.

When reporting, please include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce, including a minimal proof-of-concept if possible
- The affected version (`kozou`, `@kozou/core`, `@kozou/introspect`,
  `@kozou/mcp`, `@kozou/svelte-ui`, or the `ghcr.io/kozou-dev/kozou`
  image tag)
- Any suggested mitigation or fix

## Supported Versions

Only the latest `v0.1.x` line receives security fixes. The `v0.0.x`
tags were package-name reservations published before any functional
code existed; they are not supported.

| Version  | Supported          |
|----------|--------------------|
| `0.1.x`  | :white_check_mark: |
| `0.0.x`  | :x:                |

## Scope

In scope:

- The published npm packages (`kozou`, `@kozou/core`,
  `@kozou/introspect`, `@kozou/mcp`, `@kozou/svelte-ui`,
  `create-kozou`)
- The published container image (`ghcr.io/kozou-dev/kozou`)
- The source code in this repository

Out of scope:

- Issues that require the attacker to already control the PostgreSQL
  schema (DDL or `COMMENT` text). Schema authors are inside Kozou's
  trust boundary by design — see [docs/security.md](docs/security.md)
  for the threat model and the mitigations under consideration for
  `v0.1.1+`.
- Issues in third-party dependencies (PostgreSQL itself, PostgREST,
  Docker, Node.js). Please report those upstream.

## Disclosure Policy

- We will confirm receipt of your report within 3 business days.
- We will keep you informed as we investigate and develop a fix.
- We will coordinate the public disclosure timeline with you so that
  users have a patched version available before details are made
  public.
- We will credit reporters in the security advisory unless you ask to
  remain anonymous.
