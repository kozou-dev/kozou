# Contributing to Kozou

Thank you for your interest in contributing to Kozou — a PostgreSQL compiler that emits an Admin UI, REST API, and MCP context from your DDL and COMMENT.

Kozou is publicly released — the CLI, schema introspection, MCP server, and reference Admin UI are all available on npm, and the runtime image is on GHCR. The contribution flow described below is active.

## License

Kozou is released under the **Apache License 2.0**. See [LICENSE](LICENSE) for the full text.

By submitting a contribution (pull request, patch, or any other code or content) to this repository, you agree that your contribution is licensed under the same Apache License 2.0, in accordance with Section 5 of the license:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions.

No separate Contributor License Agreement (CLA) or Developer Certificate of Origin (DCO) signoff is required. We rely on the Apache 2.0 inbound license grant.

## Reporting Issues

Please use [GitHub Issues](https://github.com/kozou-dev/kozou/issues) for:

- **Bug reports** — include reproduction steps, expected vs. actual behavior, and environment details (OS, Node / Python version)
- **Feature requests** — describe the problem you are solving, not only the proposed solution

Search existing issues before opening a new one. **Security-sensitive issues should go through the private channels in [Security policy](#security-policy) below, not the public tracker.**

## Security policy

If you discover a security issue in Kozou — for example a bug that lets `@kozou/mcp` bypass its read-only transaction guarantee, return data beyond what the configured PostgreSQL role can read, or otherwise behave outside its documented trust boundary — please *do not* open a public issue. Instead, report it privately via [GitHub Security Advisories](https://github.com/kozou-dev/kozou/security/advisories/new) or by mailing hello@kozou.org. We aim to acknowledge reports within 3 business days. See [SECURITY.md](SECURITY.md) for the full policy, including what is and is not in scope.

## Development Environment

Required:

- **Node.js 20 or later** — install via `nvm install 20` (a `.nvmrc` will be added once the monorepo skeleton lands)
- **pnpm 9 or later** — enable via `corepack enable && corepack prepare pnpm@latest --activate`, or install with `npm install -g pnpm`
- **Docker 24 or later** — used by the test harness (testcontainers) and the `docker compose up` development stack
- **PostgreSQL 16 or later** — automatically managed by testcontainers in unit tests; for manual integration testing, run `postgres:16` via Docker

Once the monorepo skeleton is in place (in progress), the standard workflow will be:

```sh
pnpm install
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

## Submitting Pull Requests

1. Fork the repository and create a branch from `main`.
2. Make your changes.
3. Ensure CI passes — every push and pull request runs the [License integrity check](.github/workflows/license-check.yml) workflow, which verifies that the license metadata is consistent and that build artifacts do not include copyleft-licensed components.
4. Open a pull request with a clear description of what changed and why.

For larger changes, please open an issue first to discuss the approach.

## Commit Message Style

Existing commits in this repository follow a short prefix convention:

- `Add: ...` for new functionality
- `Update: ...` for changes to existing features
- `Fix: ...` for bug fixes

Keep the first line under 70 characters. Include reasoning ("why") in the body when the change is non-trivial.

## Code of Conduct

This project adopts the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Communication

GitHub Issues is the primary channel for now. GitHub Discussions may be enabled as the community grows.

---

Project home: <https://kozou.org>
