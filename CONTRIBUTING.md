# Contributing to Kozou

Thank you for your interest in contributing to Kozou — a PostgreSQL compiler that emits an Admin UI, REST API, and MCP context from your DDL and COMMENT.

This project is in an early stage (`v0.0.x`, package name reservation). Implementation work has not yet started in this repository. Once it begins (v0.1), the contribution flow described below becomes active.

## License

Kozou is released under the **Apache License 2.0**. See [LICENSE](LICENSE) for the full text.

By submitting a contribution (pull request, patch, or any other code or content) to this repository, you agree that your contribution is licensed under the same Apache License 2.0, in accordance with Section 5 of the license:

> Unless You explicitly state otherwise, any Contribution intentionally submitted for inclusion in the Work by You to the Licensor shall be under the terms and conditions of this License, without any additional terms or conditions.

No separate Contributor License Agreement (CLA) or Developer Certificate of Origin (DCO) signoff is required. We rely on the Apache 2.0 inbound license grant.

## Reporting Issues

Please use [GitHub Issues](https://github.com/kozou-dev/kozou/issues) for:

- **Bug reports** — include reproduction steps, expected vs. actual behavior, and environment details (OS, Node / Python version)
- **Feature requests** — describe the problem you are solving, not only the proposed solution

Search existing issues before opening a new one.

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

## Communication

GitHub Issues is the primary channel for now. GitHub Discussions may be enabled as the community grows.

---

Project home: <https://kozou.org>
