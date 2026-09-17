# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: `@resvg/resvg-js` ships prebuilt native addons
# and the glibc build is the well-trodden one. Prisma's query engine also wants
# glibc + openssl. Node 20 is the newest LTS both Next 14.2 and Prisma 5.17
# publish support for.
FROM node:20-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app


# ---------------------------------------------------------------------------
# deps — full install including devDependencies: `next build` needs typescript,
# and the `postinstall` hook shells out to the prisma CLI to generate a client.
# ---------------------------------------------------------------------------
FROM base AS deps
# openssl is what Prisma's query engine links against; node:*-slim omits it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# `playwright` is a dependency for local browser checks only; nothing in the
# image runs a browser. Skipping its postinstall download keeps ~170 MB of
# Chromium out of the deps and builder layers.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
# prisma/ must land before `npm ci` — postinstall runs `prisma generate`, which
# reads schema.prisma and fails the install if it is not there yet.
COPY prisma ./prisma
RUN npm ci


# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM deps AS builder
COPY . .
# Nothing connects to a database during `next build`, but modules imported at
# build time construct a PrismaClient, and the constructor rejects a missing or
# malformed URL. This placeholder satisfies the parser and is never dialled.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN npm run build


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------
FROM base AS runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# node_modules is copied wholesale instead of reinstalled with `--omit=dev`:
# the prisma CLI lives in devDependencies and the entrypoint needs it to run
# `prisma migrate deploy` on every container start. Copying also guarantees the
# generated client and the resvg native addon are byte-identical to what the
# build was compiled against.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=node:node /app/package.json ./package.json

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

# Caddy is the only thing that talks to this port, so binding 0.0.0.0 inside the
# container network is not an exposure — compose publishes no host port for it.
# Two questions, because they have different answers.
#
# /login asks whether the web server renders pages; /api/health asks whether it
# answers route handlers, the same runtime the cron sweep and the campaign media
# links use.
#
# Worth being clear about what this buys, because it is easy to over-read:
# Compose restarts a container when it *exits*, not when it goes unhealthy. This
# repairs nothing. It makes docker ps say unhealthy instead of healthy, which is
# the difference between a problem someone can find and one that waits for a
# complaint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/login >/dev/null \
     && curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node_modules/.bin/next", "start"]
