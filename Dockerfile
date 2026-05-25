# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the `kozou` CLI image
# (ghcr.io/kozou-dev/kozou). Per Kozou v0.1 design spec §14.2 /
# §16.1.1 A the image ships only the CLI (inspect / mcp / dev
# hand-off) plus its transitive production dependencies. PostgREST
# source / binary is intentionally absent (license compliance §4);
# operators run the PostgREST image side-by-side via docker compose
# - see the scaffold templates shipped under `packages/kozou/dist/
# templates/`.

# ---------------------------------------------------------------------------
# Stage 1 (builder): compile the four publish-target TypeScript
# packages so `pnpm deploy` in stage 2 can resolve their `dist/`
# outputs.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /repo

# Copy workspace metadata first so the install layer survives source
# edits that do not change dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .nvmrc ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile

# Build every workspace package in topological order so the
# `pnpm deploy` step below can resolve each transitive
# `workspace:*` reference against a real `dist/` (or `build/` for
# svelte-ui). svelte-ui's vite build only inflates the builder
# layer; it never reaches the runtime image because `kozou`'s
# production dependency closure does not include `@kozou/svelte-ui`
# in v0.1. v0.1.1's `kozou dev` host integration is where the
# Admin UI bundle starts shipping alongside the CLI.
RUN pnpm -r run build

# Materialize a flat, self-contained tree under /deploy. pnpm
# rewrites every `workspace:*` reference into a copy of the
# resolved package, so the runtime stage can just lift the
# directory across with no pnpm of its own. `--legacy` keeps
# pnpm 10's default behavior (which now demands
# `inject-workspace-packages=true` at workspace level) confined
# to this Dockerfile; we do not want to flip that setting for the
# whole repo because it changes how `pnpm install` lays out the
# local dev tree. Revisit when pnpm 11 lands - the flag may be
# deprecated by then.
RUN pnpm --filter kozou deploy --prod --legacy /deploy

# ---------------------------------------------------------------------------
# Stage 2 (runtime): copy the flat deployment in. No pnpm install,
# no corepack - the image only needs node + the deployed tree.
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app
COPY --from=builder /deploy /app

# `node:24-alpine` ships a non-root `node` user. Switching to it
# means a future `kozou dev` HTTP transport (v0.1.1) starts under a
# least-privilege account. The CLI itself does not bind any port in
# v0.1, so no `EXPOSE` directive yet.
USER node

ENTRYPOINT ["node", "/app/dist/cli.js"]
