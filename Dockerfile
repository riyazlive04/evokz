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
# The browser is installed once, in the runner, where it is actually used.
# Letting playwright's postinstall pull it here would download ~170 MB into the
# deps layer and another copy into the builder, neither of which ever runs it.
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

# ---------------------------------------------------------------------------
# The poster renderer's own assets.
#
# **These two COPY lines are load-bearing and easy to lose.** This image carries
# no `src` — the application is served from the compiled `.next` — but the HTML
# renderer reads its templates and its typefaces off the filesystem at render
# time, because a template is meant to be a real `.html` file that somebody can
# open. Without these lines everything builds, deploys, and passes a health
# check, and then the first poster on a migrated template fails at compose with
# a missing file, days later, on one client's row.
#
# The assertion below is here for the same reason: to turn that into a build
# failure with a name on it rather than a runtime surprise.
# ---------------------------------------------------------------------------
COPY --from=builder --chown=node:node /app/src/lib/poster/templates ./src/lib/poster/templates
COPY --from=builder --chown=node:node /app/src/lib/poster/fonts ./src/lib/poster/fonts

# ---------------------------------------------------------------------------
# Chromium.
#
# Pinned by pinning `playwright` to an exact version in package.json — the
# browser build is a property of the library release, and a caret range would
# let a `docker compose up --build` months from now install a different Chromium
# and change every poster's pixels. That matters because a retry after a
# WhatsApp failure is compared against the original render.
#
# `--with-deps` installs the ~40 shared libraries Chromium needs on
# bookworm-slim (fontconfig, nss, libdrm, the X client libs) via apt. Doing it
# with the flag rather than by hand keeps the list correct across upgrades. The
# font packages it pulls are worth keeping even though the renderer embeds its
# own faces: they are the fallback for a character outside the bundled latin
# subset, which an Indian client's copy can easily contain.
#
# **The headless shell, not the full browser.** `install chromium` lays down
# both — 389 MB of full Chromium and 262 MB of shell — and `chromium.launch()`
# with the default `headless: true` runs the shell, so the larger one is 389 MB
# of image nobody executes. Anything that changes the launch to `headless: false`
# or to `channel: 'chromium'` needs the full browser back.
#
# Installed to a fixed path rather than root's home cache, so the unprivileged
# `node` user the container runs as can find it.
# ---------------------------------------------------------------------------
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node_modules/.bin/playwright install --with-deps chromium-headless-shell && rm -rf /var/lib/apt/lists/*

# Fails the build if anything the renderer needs at runtime is absent — and
# proves it by launching the browser and taking a picture, which is the only
# check that covers the shared libraries as well as the files.
COPY --chown=node:node scripts/assert-renderer-assets.mjs ./scripts/assert-renderer-assets.mjs
RUN node scripts/assert-renderer-assets.mjs

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

# Caddy is the only thing that talks to this port, so binding 0.0.0.0 inside the
# container network is not an exposure — compose publishes no host port for it.
# Two questions, because they have different answers.
#
# /login asks whether the web server is up. /api/health asks whether the thing
# the server exists to do still works: it returns 503 once the poster renderer
# has failed several attempts in a row, which is a state the login page is
# entirely happy in. A dead Chromium used to report healthy indefinitely, and
# the first person to know was a client who did not get their poster.
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
