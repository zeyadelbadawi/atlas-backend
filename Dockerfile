# Atlas backend — production image.
#
# Phase 7. Multi-stage: full devDependencies only exist in the `build`
# stage (needed for `nest build`/`prisma generate`); the final runtime
# image installs production dependencies fresh, matching the actual
# deployed dependency graph rather than pruning the build stage's tree.
# Runs as a non-root user. No secrets baked in — all configuration is
# supplied at container-start via environment variables (docker-compose
# `env_file`).

FROM node:20-alpine AS build
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

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm run prisma:generate && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN addgroup -S atlas && adduser -S atlas -G atlas
USER atlas

EXPOSE 3000
CMD ["node", "dist/main.js"]
