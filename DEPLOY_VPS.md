# Deploying Evokz ACE to a Hostinger VPS

Target: `evokz.in` served from a single VPS running Docker Compose — Caddy at the
edge (TLS + gateway lock), Next.js, and PostgreSQL.

Every command below runs **on the VPS as a non-root user in the `docker` group**,
from the project directory, unless a step says otherwise.

---

## 0. What this replaces

The repo was written for Vercel. Two things Vercel provided have to be rebuilt here:

| Vercel provided | Replacement on the VPS |
|---|---|
| `vercel.json` crons (`*/5 * * * *` → `/api/cron`) | system crontab, §7 |
| Password Protection in front of the console | Caddy Basic Auth + the app's own login, §4 |
| Managed Postgres, managed backups | `db` service + `scripts/backup-db.sh`, §8 |
| Automatic TLS | Caddy's ACME client, automatic once DNS resolves |

`vercel.json` is left in place and is simply ignored by this stack.

---

## 1. VPS sizing

| | Minimum | Comfortable |
|---|---|---|
| RAM | 4 GB | 8 GB |
| vCPU | 2 | 2–4 |
| Disk | 40 GB | 80 GB |
| OS image | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |

Two things drive the memory figure, and neither is the idle footprint:

- **`next build` inside Docker.** Webpack peaks well over 1 GB. On a 2 GB box it
  is killed by the OOM reaper mid-build, which presents as a build that stops
  with no error message.
- **Poster rendering.** satori inflates the source photo to base64 inside an SVG
  string, then resvg rasterises it. `src/app/api/poster/preview/route.ts` already
  caps the placeholder photo's long edge at 1280 px specifically because a
  full-size print preset exhausted the dev server's heap.

If you are on 4 GB, add swap before the first build — it costs nothing when unused:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

---

## 2. DNS

`evokz.in` currently points at `atlas.dns-parking.com` / `hyperion.dns-parking.com`
— Hostinger's parking nameservers. Those are fine to keep; records are editable in
hPanel under **Domains → evokz.in → DNS / Nameservers**.

Delete any existing parking `A` record for `@`, then add:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `@` | *your VPS IPv4* | 300 |
| A | `www` | *your VPS IPv4* | 300 |

The `www` record is optional. Add it **before** listing `www.evokz.in` in
`APP_DOMAIN` — Caddy requests a certificate for every name in that list at
startup, and one name that does not resolve fails the whole batch.

Confirm propagation before going further. Caddy's ACME challenge will not
succeed until this returns the VPS address:

```bash
dig +short evokz.in @1.1.1.1
```

---

## 3. Server preparation

```bash
# --- packages ---
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl git

# --- Docker Engine + Compose plugin (official repo, not the Ubuntu package) ---
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"
newgrp docker           # or log out and back in
docker compose version  # expect v2.x
```

### Firewall

Only three ports need to be reachable. Postgres and the app are on an internal
Docker network and publish **no host port at all** — `docker-compose.yml`
deliberately omits a `ports:` entry for both, so 5432 is not exposed even to
localhost from outside the container network.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp      # HTTP/3
sudo ufw enable
sudo ufw status verbose
```

> Hostinger VPS instances may also have a firewall at the panel level
> (**VPS → Firewall**). If one is active there, open the same ports, or the
> `ufw` rules alone will not be enough.

### Harden SSH

```bash
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

Confirm you can still open a **second** SSH session with your key before closing
the first one.

---

## 4. Get the code and write the secrets

```bash
git clone https://github.com/riyazlive04/evokz.git
cd evokz
git checkout vertical-templates-and-bulk-import   # or main, once merged
chmod +x scripts/backup-db.sh docker-entrypoint.sh
```

### 4a. `.env` — application secrets

Copy your working local `.env` up (it already holds the live OpenAI, fal.ai,
Google service-account, Razorpay and Evolution credentials):

```bash
# from your Windows machine
scp "C:\Users\monis\OneDrive - Sirah Digital\Documents\Evokz\evokz\.env" user@YOUR_VPS_IP:~/evokz/.env
```

Then edit four values on the server — `nano .env`:

```ini
# 1. Point at the compose service, not localhost. The password must match
#    POSTGRES_PASSWORD below, and the database name POSTGRES_DB.
DATABASE_URL="postgresql://evokz:PASTE_DB_PASSWORD@db:5432/evokz_ace?schema=public"

# 2. Still the placeholder shipped in the repo. Anyone who guesses it can
#    trigger the dispatch sweep — which generates images and sends WhatsApp
#    messages — because /api/cron is excluded from the gateway lock by design.
CRON_SECRET="PASTE_FROM_openssl_rand_-hex_32"

# 3. Consumed by the `db` service in docker-compose.yml.
POSTGRES_USER="evokz"
POSTGRES_PASSWORD="PASTE_FROM_openssl_rand_-hex_24"
POSTGRES_DB="evokz_ace"

# 4. Console login — see 4b.
ADMIN_PASSWORD_HASH="..."
SESSION_SECRET="..."
```

Generate the random values:

```bash
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
```

And the console credentials — this prints both lines ready to paste, and the
prompt does not echo:

```bash
docker run --rm -it -v "$PWD:/app" -w /app node:20-bookworm-slim \
  node scripts/hash-password.mjs
```

> **The local `.env` currently carries the dev password `evokz-local-dev-2026`.**
> Replace `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` on the server with freshly
> generated values — a credential that has lived in a local file is not a
> production credential.

Lock the file down: `chmod 600 .env`

### 4b. Edge config and the gateway credential — two files

```bash
# Domain + ACME contact. No secrets, no `$` characters.
cp .env.caddy.example .env.caddy
nano .env.caddy                 # set APP_DOMAIN and ACME_EMAIL

# The gateway password, in its own file.
cp caddy-gateway-auth.conf.example caddy-gateway-auth.conf
docker run --rm caddy:2.10-alpine caddy hash-password --plaintext 'your-gateway-password'
nano caddy-gateway-auth.conf    # paste the hash in place of the placeholder
chmod 600 .env.caddy caddy-gateway-auth.conf
```

> **Why the hash gets its own file.** Docker Compose interpolates `$` sequences
> in `env_file` values, so a bcrypt hash passed that way arrives truncated at its
> second `$` — `$2a$14$abc...` becomes `$2a$14`. Verified against Compose v5.3.0.
> The failure is silent: the stack starts, and the gateway simply never accepts
> the password. A bind-mounted file skips interpolation entirely.

Both files are in `.gitignore`. Confirm before your first commit on the server:

```bash
git check-ignore -v .env .env.caddy caddy-gateway-auth.conf
```

### Why there are two passwords

They are different locks doing different jobs, and you will be asked for both:

- **The Caddy gateway lock** (browser popup) sits in front of the whole origin.
  It is what stops an anonymous visitor from ever reaching the Next.js bundle —
  and therefore from ever seeing the Server Action IDs embedded in it.
- **The app login** (`/login`) is the real session, with a 12-hour sliding
  expiry, a sign-out button, and a brute-force throttle. It is also the only lock
  that exists when you run the app locally.

`/api/webhooks/razorpay` and `/api/cron` bypass the gateway lock, because Razorpay
and cron are machines that cannot answer a Basic Auth challenge. Both verify their
own callers — HMAC-SHA256 over the raw body, and a Bearer token that fails closed
when unset — so nothing is unguarded.

---

## 5. First launch

```bash
docker compose up -d --build
```

The first build takes 5–15 minutes. Then:

```bash
docker compose ps            # all three services healthy
docker compose logs -f app   # watch migrations + startup
```

Expected in the app log:

```
[entrypoint] applying database migrations...
... 1 migration found in prisma/migrations
Applying migration `0_init`
[entrypoint] starting Next.js on 0.0.0.0:3000
```

### If the database is not empty

`prisma migrate deploy` will refuse to run against a database that already has the
schema (created by `prisma db push`, which is how this project was developed).
Baseline it once — this marks `0_init` as already applied without executing it:

```bash
docker compose run --rm app node_modules/.bin/prisma migrate resolve --applied 0_init
docker compose up -d app
```

Against a fresh empty volume, which is the normal case here, no such step is needed.

---

## 6. Verify

```bash
# TLS issued and the gateway lock is live (401 without credentials)
curl -I https://evokz.in

# Gateway credentials accepted, then the app's own login redirect (307 -> /login)
curl -I -u "evokz:YOUR_GATEWAY_PASSWORD" https://evokz.in

# The cron endpoint bypasses the gateway but rejects a bad token
curl -s -o /dev/null -w '%{http_code}\n' https://evokz.in/api/cron            # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://evokz.in/api/cron     # JSON summary

# Razorpay endpoint bypasses the gateway but rejects an unsigned body
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  https://evokz.in/api/webhooks/razorpay                                      # {"error":"Invalid signature"}
```

Then in a browser: `https://evokz.in` → gateway popup → `/login` → console
password → dashboard. Check the dashboard's config banner reports **no** unset
integration keys.

Poster rendering is the one path with a native dependency (`@resvg/resvg-js`) and
a platform-specific binary, so exercise it explicitly:

```bash
curl -u "evokz:YOUR_GATEWAY_PASSWORD" -b cookies.txt \
  "https://evokz.in/api/poster/preview?archetype=scrim" -o test.png
file test.png    # expect: PNG image data
```

---

## 7. The dispatch cron

This is the step most easily forgotten, and nothing visibly breaks without it —
clients simply never receive anything.

```bash
crontab -e
```

```cron
*/5 * * * * /opt/evokz/scripts/dispatch-cron.sh >> /opt/evokz/backups/cron.log 2>&1
```

`scripts/dispatch-cron.sh` issues the request from *inside* the app container
over loopback rather than curling the public URL. `CRON_SECRET` therefore never
crosses the internet, the sweep keeps running while DNS is mid-change or a
certificate is renewing, and the `/api/cron` exclusion in the Caddyfile is not
load-bearing for scheduled runs — it only matters if you trigger the sweep
externally.

Keep the interval and `CRON_WINDOW_MINUTES` in `.env` in agreement: the sweep
matches clients whose delivery time falls inside the window, so a window shorter
than the interval drops deliveries in the gap.

---

## 8. Backups

```bash
mkdir -p backups
(crontab -l 2>/dev/null; echo "30 2 * * * /opt/evokz/scripts/backup-db.sh >> /opt/evokz/backups/backup.log 2>&1") | crontab -
./scripts/backup-db.sh          # run once now to prove it works
ls -lh backups/
```

Retention is 14 days, set at the top of the script.

**A dump on the same disk as the database is not a backup.** It survives an
application bug; it does not survive the VPS. Add an off-site copy — the script
has a commented `rclone` line at the bottom for exactly this.

Restore:

```bash
gunzip -c backups/evokz_ace_YYYY-MM-DD_HHMMSS.sql.gz \
  | docker compose exec -T db psql -U evokz -d evokz_ace
```

---

## 9. External integrations

1. **Razorpay** — dashboard → Settings → Webhooks → add
   `https://evokz.in/api/webhooks/razorpay`, subscribe to **`order.paid`**, and set
   the signing secret to match `RAZORPAY_WEBHOOK_SECRET`.
   The checkout must send these `notes`: `company_name`, `whatsapp_phone`,
   `plan_id`, `category_id`, and optionally `preferred_cron_time`, `image_size`.
   Missing any of the first four returns 422 and the customer is never provisioned.
2. **Google Drive** — share the vault folder (`GOOGLE_DRIVE_PARENT_FOLDER_ID`) with
   `GOOGLE_SERVICE_ACCOUNT_EMAIL` as **Content manager**. Viewer is not enough;
   the app creates per-client subfolders.
3. **Evolution (WhatsApp)** — confirm `EVOLUTION_API_KEY` is the *per-instance*
   token, not the global admin key. The gateway at `EVOLUTION_API_URL` is Evolution
   **GO** (`POST /send/media`), not Evolution Node v2.
4. **Seed data** — create at least one `Plan` and one `Category` in the console
   before any payment arrives. Provisioning validates both foreign keys, and the
   onboarding dialog stays disabled until they exist.

---

## 10. Day-two operations

```bash
# Deploy a new version
git pull && docker compose up -d --build && docker compose logs -f app

# Restart / stop
docker compose restart app
docker compose down                    # keeps volumes (data safe)
docker compose down -v                 # DESTROYS the database volume

# Logs
docker compose logs -f app
docker compose logs -f caddy
tail -f backups/cron.log

# Database shell
docker compose exec db psql -U evokz -d evokz_ace

# Disk pressure from old images after several rebuilds
docker system prune -af
```

### Rotating the console password

```bash
docker run --rm -it -v "$PWD:/app" -w /app node:20-bookworm-slim node scripts/hash-password.mjs
nano .env                # paste both new lines
docker compose up -d app
```

Rotating `SESSION_SECRET` invalidates every live session immediately. That is the
**only** revocation mechanism — sessions are stateless signed tokens, so there is
no session table to delete rows from.

---

## 11. Troubleshooting

| Symptom | Cause |
|---|---|
| Every request returns **503**, log says `SESSION_SECRET and/or ADMIN_PASSWORD_HASH are unset` | Auth env vars missing. `middleware.ts` fails closed on purpose — it will not degrade to an open console. |
| Login always says "That password is not correct" despite a fresh hash | `ADMIN_PASSWORD_HASH` was mangled. It must use `:` separators, never `$` — Next expands `$NAME` in `.env` values. Re-run the generator. |
| Caddy loops on ACME, no certificate | DNS not resolving to this VPS yet, port 80 blocked (check the Hostinger panel firewall as well as `ufw`), or `APP_DOMAIN` lists a name with no A record. |
| Gateway popup rejects the correct password | The bcrypt hash was moved into `.env.caddy` or a compose `environment:` entry, where Compose truncates it at the second `$`. It belongs in `caddy-gateway-auth.conf` — §4b. |
| Build stops with no error | OOM killer during `next build`. Add swap (§1). |
| App restarts in a loop, log shows a Prisma connection error | `DATABASE_URL` still points at `localhost`. Inside compose the host is `db`. |
| `prisma migrate deploy` errors on a non-empty schema | Baseline it — §5, "If the database is not empty". |
| Posters fail with `Unsupported OpenType signature wOF2` | Outbound access to `fonts.googleapis.com` is blocked. Set `POSTER_FONT_DIR` to a directory of TTFs and mount it into the container. |
| Clients receive nothing, no errors anywhere | The §7 cron was never installed. |
| WhatsApp delivery fails, everything else works | `EVOLUTION_API_KEY` is the global key rather than the per-instance token. |

---

## 12. Known gaps carried into production

Being explicit about what this deploy does *not* fix:

- **No test suite.** There is none in the repository. Every change ships on the
  strength of `typecheck` + `lint` + manual verification.
- **Single shared operator credential.** No user accounts, no per-user audit
  trail — "who deleted that client" is unanswerable.
- **Single box, no redundancy.** App and database share a host; losing it loses
  both. §8's off-site copy is what limits the damage.
- **`UsageEvent.backfilled`** is read but never written, so spend reports treat
  every event as live.
- **In-memory login throttle.** Per-process, and reset by any restart. The Caddy
  gateway lock is the real defence against online guessing.
