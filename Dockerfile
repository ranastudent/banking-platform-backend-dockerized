# syntax=docker/dockerfile:1

# Prisma 7 reads DATABASE_URL through prisma.config.ts even during generation.
# This build-only URL is never used at runtime.
FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"

# Install all dependencies and compile TypeScript.
FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Install only runtime dependencies in a clean layer.
# Prisma's postinstall generates the client using the schema/config copied above.
FROM base AS production-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci --omit=dev

# Minimal runtime image. Debian slim is used for predictable native-module
# compatibility (bcrypt/Prisma) rather than Alpine/musl.
FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*


WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000

COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./
COPY --chown=node:node docs ./docs

USER node
EXPOSE 5000

CMD ["node", "dist/server.js"]
