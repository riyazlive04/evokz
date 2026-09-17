#!/usr/bin/env bash
#
# Triggers the dispatch sweep. Install on the host crontab:
#
#   * * * * * /opt/evokz/scripts/dispatch-cron.sh >> /opt/evokz/backups/cron.log 2>&1
#
# The request is issued from *inside* the app container over loopback rather
# than against the public URL. Three reasons that matters:
#
#   - CRON_SECRET never crosses the internet.
#   - The sweep keeps running when DNS is mid-change or the TLS certificate is
#     being renewed — neither has anything to do with dispatching content.
#   - It never touches the edge at all, so no change to Caddy or to the app's
#     own auth can break scheduled runs.
#
# There is no window to keep in step with the interval: each sweep generates a
# few queued campaign posters (CAMPAIGN_GENERATION_LIMIT), books approved days,
# and sends every campaign delivery whose time has already come. The interval
# only sets how late a send can be; a delivery still unsent once its local day
# is over is marked missed rather than sent late.

set -euo pipefail

cd "$(dirname "$0")/.."

# Read the one value needed rather than sourcing .env. Sourcing would run the
# file through the shell, so any `$` inside a credential — an API key, a
# generated password — would expand to something else or to nothing.
CRON_SECRET="$(grep -m1 '^CRON_SECRET=' .env | cut -d= -f2- | tr -d '"')"
: "${CRON_SECRET:?CRON_SECRET is not set in .env}"

echo "[$(date -Is)] dispatch sweep starting"

# -m 300 matches the route's own maxDuration. Without it a stuck sweep would
# still be holding the connection open when the next one starts.
docker compose exec -T app \
  curl -fsS -m 300 \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  http://127.0.0.1:3000/api/cron

echo ""
echo "[$(date -Is)] dispatch sweep finished"
