# syntax=docker/dockerfile:1
#
# Standalone NestJS API. Build context is this directory (the repo root when
# apps/api is pushed as its own repository).

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
# pnpm is installed directly rather than via corepack. Corepack downloads and
# signature-verifies the pnpm tarball at first invocation, and the corepack
# bundled with the Node image is often too old to verify a recent pnpm release
# -- which surfaces as `pnpm install` failing with exit code 1.
RUN npm install -g pnpm@11.22.0
WORKDIR /app

# ---------- deps ----------
# Manifest + lockfile only, so this layer caches until a dependency changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm --version && pnpm install --frozen-lockfile

# ---------- build ----------
FROM deps AS build
# .dockerignore keeps node_modules out of this COPY, so the pnpm symlink tree
# installed above is never overwritten. Copying an installed node_modules over
# a populated layer is what produces buildkit's "cannot replace to directory
# ... with file" error.
COPY . .
RUN pnpm run build

# ---------- runtime ----------
# Fresh production-only install: no devDependencies (nest CLI, jest, eslint,
# typescript) ship in the final image.
FROM base AS runner
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
EXPOSE 3000
# main.ts reads PORT from the environment and binds 0.0.0.0, which Railway's
# proxy requires.
CMD ["node", "dist/main"]
