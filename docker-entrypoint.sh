#!/bin/sh
set -e

# Container start sequence.
#
# `migrate deploy` is the deliberate choice over `db push`: it only replays
# committed migration files, never infers a diff, and never drops a column to
# make the database match the schema. It is a no-op when everything is applied,
# so it is safe on every restart.
#
# It runs before the server binds a port, so Caddy's health check cannot route
# traffic at a half-migrated schema.

echo "[entrypoint] applying database migrations..."
node_modules/.bin/prisma migrate deploy

echo "[entrypoint] starting Next.js on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec "$@"
