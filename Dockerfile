# Atlas backend — production image.
#
# Phase 7. Multi-stage: full devDependencies only exist in the `build`
# stage (needed for `nest build`/`prisma generate`); the final runtime
# image installs production dependencies fresh, matching the actual
# deployed dependency graph rather than pruning the build stage's tree.
# Runs as a non-root user. No secrets baked in — all configuration is
# supplied at container-start via environment variables (docker-compose
# `env_file`).
#
# B0-OPS-12 — the base image is pinned to the multi-arch index digest the
# tag resolved to when it was pinned (amd64 and arm64 builds both resolve
# through it), so every build pulls the same bytes. The tag stays for
# readability; Dependabot (.github/dependabot.yml) proposes digest updates
# as reviewable PRs, and src/ci-supply-chain-pins.spec.ts fails CI if a
# FROM loses its digest.

FROM mirror.gcr.io/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app
# Prisma's engine-detection on Alpine needs a real openssl present to pick
# the right engine binary — without it, `prisma generate` falls back to a
# guessed version that silently mismatches at runtime (confirmed by a
# genuine "failed to detect libssl/openssl" warning without this).
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM mirror.gcr.io/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm run prisma:generate && npm cache clean --force

COPY --from=build /app/dist ./dist
# P64 Phase 3 — embedded certificate fonts (OFL), read at runtime by pdfkit.
COPY assets ./assets

RUN addgroup -S atlas && adduser -S atlas -G atlas
USER atlas

EXPOSE 3000
CMD ["node", "dist/main.js"]
