# Deploying Evokz ACE to a Hostinger VPS

Target: `app.evokz.in` — and only that name — served from a single VPS running
Docker Compose: Caddy at the edge (TLS + reverse proxy), Next.js, and PostgreSQL.

Every command below runs **on the VPS as a non-root user in the `docker` group**,
from the project directory, unless a step says otherwise.

---

## 0. What this replaces

The repo was written for Vercel. Two things Vercel provided have to be rebuilt here:

| Vercel provided | Replacement on the VPS |
|---|---|
| `vercel.json` crons (`*/5 * * * *` → `/api/cron`) | system crontab, §7 |
| Password Protection in front of the console | The app's own login, §4 |
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

`evokz.in` uses `atlas.dns-parking.com` / `hyperion.dns-parking.com` —
Hostinger's parking nameservers. Records are editable in hPanel under
**Domains → evokz.in → DNS / Nameservers**.

**This VPS serves exactly one name: `app.evokz.in`.** One record, and nothing
else pointing here:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `app` | *your VPS IPv4* | 300 |

Do **not** point the apex, `www`, or any other domain at this box. `evokz.in`,
`www.evokz.in` and `app.brivokz.com` were all detached on 2026-08-06 and are
reserved for unrelated sites; the Caddyfile has no block for them, so a request
that still arrives gets a 404 or a failed TLS handshake. Every name listed in
`APP_DOMAIN` is a name Caddy requests a certificate for and therefore claims —
adding one back is how you accidentally take a domain over again.

Confirm propagation before going further. Caddy's ACME challenge will not
succeed until this returns the VPS address:

```bash
dig +short app.evokz.in @1.1.1.1
```

If a record you deleted keeps resolving with a TTL that never counts down, the
domain is attached as a **website** in hPanel (**Websites** list), which injects
its own A record and overrides the zone editor. Removing the website entry is
what releases it — editing DNS alone does nothing.

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
#    messages — because /api/cron carries no session and authenticates on this
#    value alone.
CRON_SECRET="PASTE_FROM_openssl_rand_-hex_32"

# 3. Consumed by the `db` service in docker-compose.yml.
POSTGRES_USER="evokz"
POSTGRES_PASSWORD="PASTE_FROM_openssl_rand_-hex_24"
POSTGRES_DB="evokz_ace"

# 4. Console login — see 4b.
ADMIN_PASSWORD_HASH="..."
SESSION_SECRET="..."

# 5. Encrypts anything the console stores on the operator's behalf — today the
#    fal.ai key entered under Dashboard → Image generation key. Without it that
#    panel refuses to save rather than storing a key in plain text, so set it now
#    even if nobody uses the panel yet. Rotating it later orphans the stored key.
SETTINGS_ENCRYPTION_KEY="PASTE_FROM_openssl_rand_-hex_32"
```

Generate the random values:

```bash
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 24   # POSTGRES_PASSWORD
openssl rand -hex 32   # SETTINGS_ENCRYPTION_KEY
```

And the console credentials — this prints both lines ready to paste, and the
prompt does not echo:

```bash
docker run --rm -it -v "$PWD:/app" -w /app node:20-bookworm-slim \
  node scripts/hash-password.mjs
```

> **The console password is now the only lock** — the Caddy Basic Auth gateway
> that used to sit in front of it is gone (see "One password" below). Generate
> `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` fresh on the server and keep the
> plaintext out of this repo, which is public. A password that has lived in a
> local file, a chat log, or a commit is not a production credential.

Lock the file down: `chmod 600 .env`

### 4b. Edge config — one file

```bash
# Domain + ACME contact. No secrets, no `$` characters.
cp .env.caddy.example .env.caddy
nano .env.caddy                 # set APP_DOMAIN (one name) and ACME_EMAIL
chmod 600 .env.caddy
```

> **Keep `$` out of every value in this file.** Docker Compose interpolates
> `env_file` contents, so `$anything` is replaced by an environment lookup —
> silently, leaving a value that is wrong rather than one that errors. Verified
> against Compose v5.3.0. This is why the old Caddy gateway password had to live
> in a bind-mounted file of its own, and it still applies to anything added here.

It is in `.gitignore`. Confirm before your first commit on the server:

```bash
git check-ignore -v .env .env.caddy
```

### Changing the edge config later

`docker compose up -d caddy` is **not** enough for a `Caddyfile` edit. The file is
a bind mount, so Compose sees no change to the service and leaves the container
running with the old config — it reports success and nothing happens. `caddy
reload` is not available either: `admin off` in the global block removes the
admin API it would talk to. Use `restart`, and validate first, because
`restart: unless-stopped` turns a parse error into a crash loop with the site
down:

```bash
# Validate against the env the container will actually get. Use -e, not
# --env-file: `docker run --env-file` keeps the surrounding quotes that Compose
# strips, and APP_DOMAIN then fails with a bogus "site addresses cannot contain
# a comma".
docker run --rm -v /opt/evokz/Caddyfile:/etc/caddy/Caddyfile:ro \
  -e APP_DOMAIN="app.evokz.in" -e ACME_EMAIL="you@example.com" \
  caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

docker compose restart caddy
```

An `.env.caddy` edit is the opposite case: it *is* an `env_file`, so
`docker compose up -d caddy` recreates the container and does take effect.

### One password, and what guards the rest

There is a single credential: **the app login** at `/login`. It issues a session
with a 12-hour sliding expiry, a sign-out button, and a per-IP brute-force
throttle, and it is enforced by `src/middleware.ts` on every path below.

Caddy used to add a Basic Auth gateway in front of the whole origin, so reaching
the console meant answering a browser popup *and then* signing in. It was removed
because two credentials for one page is a daily tax on the operator. The trade is
worth understanding:

- **Unchanged:** the middleware fails closed, so an anonymous visitor still
  cannot reach `/admin/*` or invoke a Server Action. Nothing became reachable
  that was not reachable before.
- **Changed:** the login endpoint is now exposed to the open internet, so online
  password guessing is answered by the in-memory throttle in
  `src/app/login/actions.ts` (8 attempts per IP per 15 minutes, reset by a
  container restart) rather than by Caddy. Keep the console password long, and
  put the gateway back if the origin starts getting probed.

`/api/webhooks/razorpay` and `/api/cron` are excluded from the middleware because
Razorpay and the system cron are machines with no session cookie. Both verify
their own callers — HMAC-SHA256 over the raw body, and a Bearer token that fails
closed when unset — so neither is unguarded.

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

`app.evokz.in` is the only host that answers. The apex is not a redirect any
more — it is not served at all.

```bash
# TLS issued, and an anonymous visitor is redirected to the login.
# Use a GET, not `curl -I`: HEAD is not GET, so the middleware answers it on the
# expired-session path with a bare 401 and no Location. That 401 is correct and
# is NOT evidence of a gateway — the next check is what tells them apart.
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' \
  https://app.evokz.in/                                     # 307 -> .../login

# There must be NO `WWW-Authenticate` header anywhere here. One would mean a
# Basic Auth gateway is still live and the removal did not reach this box.
curl -sI https://app.evokz.in/ | grep -i 'www-authenticate'                   # no output

# A server action with no session is rejected outright rather than redirected
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'next-action: probe' \
  https://app.evokz.in/admin/dashboard                                        # 401

# The cron endpoint takes no session but rejects a bad token
curl -s -o /dev/null -w '%{http_code}\n' https://app.evokz.in/api/cron        # 401
curl -s -H "Authorization: Bearer $CRON_SECRET" https://app.evokz.in/api/cron # JSON summary

# Razorpay endpoint takes no session but rejects an unsigned body
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  https://app.evokz.in/api/webhooks/razorpay                                  # {"error":"Invalid signature"}
```

Confirm the deployed password without opening a browser — this reads the hash out
of the **running** container, so it catches a `.env` edit that never took effect:

```bash
# Leading space keeps the password out of shell history (bash HISTCONTROL).
 docker compose exec -T -e PW='your-console-password' app node <<'JS'
const c = require('node:crypto');
const [s, cost, salt, want] = (process.env.ADMIN_PASSWORD_HASH || '').split(':');
console.log(s === 'pbkdf2-sha256' &&
  c.pbkdf2Sync(process.env.PW, Buffer.from(salt, 'hex'), +cost, 32, 'sha256').toString('hex') === want
  ? 'ACCEPTED' : 'rejected');
JS
```

Then in a browser: `https://app.evokz.in` → `/login` → console password →
dashboard, **with no browser popup at any point**. Check the dashboard's config
banner reports **no** unset integration keys.

Poster rendering is the one path with a native dependency (`@resvg/resvg-js`) and
a platform-specific binary, so exercise it explicitly:

```bash
# `cookies.txt` must hold a live session — the preview route is behind the
# middleware, so without one this saves a redirect to /login, not a PNG.
curl -b cookies.txt \
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
* * * * * /opt/evokz/scripts/dispatch-cron.sh >> /opt/evokz/backups/cron.log 2>&1
```

**This interval and `CRON_WINDOW_MINUTES` in `.env` are one setting in two
places — change them together or not at all.** A client's `cronTime` is not a
trigger; it is a value each sweep looks *back* for across its trailing window.
Every minute paired with a window of 1 means a client set to `17:07` is swept at
`17:07`. Running `*/5` instead (the original setting) is not broken, but `17:07`
is then first seen by the `17:10` sweep, because no sweep is awake at `17:07`.
See `.env.example` for what each mismatch costs — one direction drops sends
silently, the other can send the same poster twice.

The send itself is inline, so the message lands 15–20s after the minute.

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

**Dumps now contain a credential — as ciphertext.** If an operator has saved a
fal.ai key in the console, `AppSetting.falKeyCipher` is in every dump. It is
AES-256-GCM and useless without `SETTINGS_ENCRYPTION_KEY`, which lives in `.env`
and is deliberately *not* in the dump. Two consequences: an off-site dump does not
leak the key, and a restore onto a box with a different `SETTINGS_ENCRYPTION_KEY`
comes up with a key it cannot read. Store that value with the restore notes.

Restore:

```bash
gunzip -c backups/evokz_ace_YYYY-MM-DD_HHMMSS.sql.gz \
  | docker compose exec -T db psql -U evokz -d evokz_ace
```

---

## 9. External integrations

1. **Razorpay** — dashboard → Settings → Webhooks → add
   `https://app.evokz.in/api/webhooks/razorpay`, subscribe to **`order.paid`**, and
   set the signing secret to match `RAZORPAY_WEBHOOK_SECRET`. It must be the
   console host: the apex no longer redirects here, so a webhook still pointed at
   `https://evokz.in/...` fails and the customer is never provisioned.
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

### The operator's own fal.ai key

Entered in the console at **Dashboard → Image generation key**, not in `.env`. It
is encrypted with `SETTINGS_ENCRYPTION_KEY` and stored in `AppSetting`, and it is
resolved per render — so saving one takes effect on the next generation with no
restart and no redeploy.

While a key is saved, **`FAL_KEY` is never used**. A rejected key, an empty
balance, or a key that will not decrypt all fail the row with a message naming the
cause; none of them quietly fall back to the platform key, because that would spend
Evokz's money against an explicit instruction and nobody would notice until the
invoice.

**The switch is one-way from the console.** There is no remove control and no
`clearFalApiKey` server action — hiding a button would not be enough, since Next.js
publishes Server Action IDs in the client bundle. The operator can replace their key
with another of their own; they cannot hand billing back to Evokz. Reverting takes
server access, deliberately:

```bash
docker compose exec db psql -U evokz -d evokz_ace \
  -c 'UPDATE "AppSetting" SET "falKeyCipher" = NULL, "falKeyLast4" = NULL,
      "falKeyLabel" = NULL, "falKeyUpdatedAt" = NULL;'
```

No restart is needed — the credential is resolved per render, so the next poster
uses `FAL_KEY` again. Confirm it is still set in `.env` first, or generation will
fail with `Missing required environment variable: FAL_KEY`.

Two further operational notes:

- **`docker compose restart app` does not re-read `.env`.** Restart re-runs the
  container with the environment it was *created* with. After adding or changing
  `SETTINGS_ENCRYPTION_KEY`, use `docker compose up -d app`, which recreates it.
- **Rotating `SETTINGS_ENCRYPTION_KEY` orphans the stored key.** Nothing
  re-encrypts it. The panel shows a "cannot be decrypted" state and every render
  fails until the operator pastes their key in again and saves, which overwrites the
  unreadable one. Rotate it only when you intend that, and keep the old value until
  the new key is saved.

---

## 11. Troubleshooting

| Symptom | Cause |
|---|---|
| Every request returns **503**, log says `SESSION_SECRET and/or ADMIN_PASSWORD_HASH are unset` | Auth env vars missing. `middleware.ts` fails closed on purpose — it will not degrade to an open console. |
| Login always says "That password is not correct" despite a fresh hash | `ADMIN_PASSWORD_HASH` was mangled. It must use `:` separators, never `$` — Next expands `$NAME` in `.env` values. Re-run the generator. |
| Caddy loops on ACME, no certificate | DNS not resolving to this VPS yet, port 80 blocked (check the Hostinger panel firewall as well as `ufw`), or `APP_DOMAIN` lists a name with no A record. |
| A browser popup asks for a username and password before the console | A Basic Auth gateway is still live at the edge. The stack is running an older `Caddyfile` — redeploy it and `docker compose up -d caddy`; check for a stray `basic_auth` or `import` directive. |
| Build stops with no error | OOM killer during `next build`. Add swap (§1). |
| App restarts in a loop, log shows a Prisma connection error | `DATABASE_URL` still points at `localhost`. Inside compose the host is `db`. |
| `prisma migrate deploy` errors on a non-empty schema | Baseline it — §5, "If the database is not empty". |
| Posters fail with `Unsupported OpenType signature wOF2` | Outbound access to `fonts.googleapis.com` is blocked. Set `POSTER_FONT_DIR` to a directory of TTFs and mount it into the container. |
| Clients receive nothing, no errors anywhere | The §7 cron was never installed. |
| WhatsApp delivery fails, everything else works | `EVOLUTION_API_KEY` is the global key rather than the per-instance token. |
| The key panel still says `SETTINGS_ENCRYPTION_KEY is not set` after adding it | You ran `docker compose restart app`. Restart re-runs the container with the environment it was *created* with; `.env` is only re-read on create. Use `docker compose up -d app`. |
| Deliveries fail with `[generate] Stored key could not be decrypted` | `SETTINGS_ENCRYPTION_KEY` changed, or `.env` came from a different box, since the fal.ai key was saved. Save the key again in the console to overwrite the unreadable one — there is deliberately no fallback to `FAL_KEY`. |
| Deliveries fail with `[generate] fal.ai rejected the operator key` | The saved key is revoked, mistyped, or the account is out of balance. Use **Test key** on the dashboard, then save a working key. A valid key can also be rejected because the account cannot reach `FAL_MODEL_ENDPOINT` — the error names the endpoint. The console cannot revert to `FAL_KEY`; that is the `UPDATE "AppSetting"` above. |

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
- **At-rest encryption on a single box has a short reach.** The operator's fal.ai
  key is encrypted with a value that lives in `.env` on the same host, so anyone
  holding both the database and `.env` holds the key. That is the honest boundary:
  it protects a leaked dump or an off-site backup, not a compromised host.
- **In-memory login throttle.** Per-process, and reset by any restart. With the
  Caddy gateway removed this is the outermost defence against online guessing,
  and it does not stop a distributed attempt. It is the weakest point of the
  single-password setup — the mitigation is a long console password.
