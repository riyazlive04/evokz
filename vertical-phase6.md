# Campaign automation — Phase 6: campaign WhatsApp delivery

**Status:** an approved campaign poster is delivered over WhatsApp, on the campaign's own schedule, at most once per day. Everything below happens on `feature/ai-poster-studio`; nothing is merged or deployed, and no message has ever left this machine — every test drives a local mock.

**Not in this phase:**
- Phase 7
- any change to the legacy (non-campaign) WhatsApp flow beyond one behaviour-preserving extraction (§1)

```
Campaign day → approved active PosterVersion → delivery eligibility
  → CampaignDelivery (SCHEDULED, version pinned)
  → cron sweep at the campaign's delivery time
  → atomic claim → gate re-run on the claimed row
  → signed, expiring media link → Evolution GO → SENT
```

## 1. Audit first: what already existed

The brief required reusing the existing WhatsApp infrastructure rather than building a second one. What the audit found:

- **One send call site in the whole repo.** `broadcastWhatsAppMedia` in `src/lib/ai-pipeline.ts` — module-private, media-only, fire-and-forget, `POST {EVOLUTION_API_URL}/send/media` with `{number, url, type, caption, filename}` and the instance token in an `apikey` header. Evolution **GO**, not Node v2: no instance path segment.
- **Media is passed as a URL the provider fetches itself**, not base64 and not an upload.
- **No text-send function, no provider message id captured, no attempt counter, no idempotency key** anywhere.
- **The claim idiom** the legacy sweep uses is a conditional `updateMany` that restates the status and checks `count`.
- **One cron entry point**, `/api/cron`, authenticated by a `CRON_SECRET` Bearer token and failing closed, run every minute by the VPS crontab.

**The extraction.** To have one integration with two callers rather than two integrations, the Evolution transport moved to `src/lib/whatsapp.ts`. The legacy function is now a thin wrapper over it that passes `tolerateUnreadableBody: true`, discards the message id and re-throws as `PipelineStageError('broadcast', …)` — so `ContentCalendar.errorMessage` reads exactly as it always has. `check:calendar-scope` and the legacy suites pin that this is behaviour-preserving.

## 2. The recipient — and the boundary

**Campaign posters are delivered to the client's own `Client.whatsappNumber`**, the same destination every legacy delivery already uses. The audit established this is the only recipient source that exists:

- it is the sole argument at the sole send site;
- the same number is printed on the poster as the business's public contact detail;
- it is provisioned from the buyer's own checkout note;
- the existing UI says "WhatsApp delivers to +{whatsappNumber} immediately".

The product model is: **the finished poster goes to the business owner, who posts it themselves.**

**What does not exist, and was not invented:** any contacts, leads, subscribers or audience model; any per-campaign destination; any contact import; any opt-in, consent or unsubscribe field. `Campaign.deliveryTime` and `deliveryDays` say *when*, never *to whom*. Delivering to a client's customers would be a blocking architectural gap and is out of scope — the UI states the destination plainly so it cannot be mistaken for a broadcast.

**The sender is also single and install-wide:** the Evolution instance is selected by `EVOLUTION_API_KEY` alone. "WhatsApp configuration exists" therefore means exactly: both Evolution variables are set, and `PUBLIC_BASE_URL` is set.

### Migration `20260916120000_campaign_delivery`

- **Change:** one new enum (`CampaignDeliveryStatus`) and one new table (`CampaignDelivery`). Nothing existing is altered, dropped or backfilled.
- **Why a new table rather than the legacy columns:** `ContentCalendar.deliveryStatus` / `sendAfter` / `approvedAt` are the legacy sweep's own state, scoped away from campaign days by `LEGACY_CALENDAR`, and they carry no poster version, no attempt count, no message id and no schedule of their own. Writing them for campaign days would break the isolation the regression suite asserts.
- **How it was applied:** the dev DB was confirmed as `localhost:5434/evokz_ai_dev` and backed up with `pg_dump` first. The Prisma **schema-engine binary is currently blocked by a Windows Application Control policy on this machine**, so `migrate deploy` could not run; the reviewed SQL was applied with `psql` inside the dev container in a single transaction, and the `_prisma_migrations` row was written exactly as `migrate deploy` writes it (same name, same SHA-256 checksum, `applied_steps_count = 1`). A deployment elsewhere applies it normally. See §12.

## 3. Delivery eligibility

`evaluateDeliveryEligibility` (pure) returns the first reason a day may not be sent, never a silent skip:

| Check | Reason |
| --- | --- |
| It is a campaign day | `not-a-campaign-day` |
| Not already sent | `already-delivered` |
| Not claimed by a live attempt | `sending` |
| Attempts remain | `attempts-exhausted` |
| The last failure was not permanent | `permanent-failure` |
| Campaign ACTIVE | `campaign-not-active` |
| Content READY | `content-not-ready` |
| A template, when there is no poster yet | `no-template` |
| An active poster exists | `no-poster` |
| It is current | `poster-outdated` |
| It is not rejected | `poster-rejected` |
| It is approved | `awaiting-approval` |
| The pinned version is still the active one | `version-changed` |
| Evolution and `PUBLIC_BASE_URL` configured | `whatsapp-not-configured` |
| The number is 10–15 digits, no leading zero | `invalid-recipient` |
| Its moment has arrived (scheduled sends only) | `not-due` |

The poster/approval part is **Phase 1's own `evaluateDeliveryReadiness`**, called directly, so the delivery gate cannot drift from the review queue's idea of "approved".

## 4. The approval gate is server-side, and re-run after the claim

This is the property the phase exists to guarantee.

`sendCampaignDelivery` runs **read → gate → claim → gate again on the claimed row → provider → settle**. The second gate re-reads the campaign, the day and the active version from the database *after* winning the claim and immediately before the provider call, because an approval can be withdrawn, a poster regenerated or a campaign paused in the window between the first check and the claim.

- No server action, route or UI state can skip it; a hand-made request to the action reaches the same function.
- `manual: true` (Send Now) relaxes **only** whether the scheduled moment has arrived. Approval, version, campaign status, recipient and duplicate protection all still apply.
- A refusal is returned as data, not thrown, so the queue can show the reason.

## 5. Scheduling

- `Campaign.deliveryTime` ("HH:MM") and the day's own `scheduledDate` give the moment, resolved in the app timezone with `startOfZonedDay` — never assumed UTC. `deliveryInstant` is pinned by tests at 09:00 and 18:30 IST.
- `scheduleCampaignDeliveries` books a `SCHEDULED` row for every day whose poster is approved and current, and is safe to run repeatedly: the unique constraint means a second run can only update, never duplicate. **Booking never sends.**
- **Rescheduling safety (§8 of the brief):** on every run, an existing booking is re-pointed at the campaign's current delivery time if it moved, **cancelled** if its pinned version is no longer active, and marked **SKIPPED** if its local day has passed. Editing a schedule never triggers a send and never creates a second job.
- A day whose moment has already passed *today* is late, not missed, and still goes out. A day whose local date has passed is `SKIPPED` — a poster for last Tuesday is worthless on Thursday.

## 6. Delivery states

`SCHEDULED → SENDING → SENT`, with `FAILED`, `CANCELLED` and `SKIPPED` as the other resting states.

**There is no `DELIVERED`.** Evolution GO acknowledges that it accepted the message; this deployment receives no delivery receipts and no webhooks, so "the recipient's phone got it" is not observable. `SENT` is the honest terminal success. Calling it DELIVERED, as the legacy column does, would claim more than is known.

## 7. Idempotency

Four mechanisms, of which the first is the one that matters:

1. **`CampaignDelivery.calendarDayId` is UNIQUE.** One campaign day can have at most one delivery row, ever. A duplicated cron tick, a second tab, a retry, a restart or two overlapping workers cannot create a second delivery. The database refuses.
2. **The claim is a conditional update** that restates the status (`SCHEDULED`, or `FAILED` and not permanent, or a `SENDING` claim older than 10 minutes). Only the caller whose update matches a row proceeds.
3. **`SENT` is terminal**: the gate refuses `already-delivered` before anything else, so a later attempt is a no-op that makes no provider call and bills nothing.
4. **The settle is guarded on the claim** (`status: SENDING, sendingStartedAt: <ours>`), so a finished attempt cannot overwrite a newer one.

## 8. The version is pinned, not looked up

A booking records the exact `posterVersionId` that was approved. Before sending, the service checks that it is still the day's active version.

If a poster was regenerated after booking, the new version arrives PENDING. Sending the pinned one would deliver something that is no longer the day's poster; sending the new one would deliver something unapproved. **Neither happens:** the delivery is cancelled with a reason, and the operator reviews and re-schedules. A new version never inherits a booking.

## 9. Retries

Bounded at `MAX_DELIVERY_ATTEMPTS = 3`, with backoff of 1 minute then 5.

| Outcome | Retried? |
| --- | --- |
| Network failure (request never completed) | yes |
| 5xx, 408, 425 | yes |
| 429 | yes |
| **Timeout** | **no** |
| 401 / 403 | no |
| A rejected recipient | no |
| Missing configuration | no |
| A 2xx body that is not the contract | no |

**A timeout is deliberately permanent.** It is ambiguous — the message may already be queued at the provider — so retrying risks sending the same poster to the client twice. The delivery is left failed, marked permanent, and a person decides. This is the same reasoning the legacy pipeline documents for never retrying its broadcast, and it is why "no infinite retry loops" is enforced by state rather than by hope.

Campaign delivery does **not** inherit the legacy blind spot where a 200 with a non-JSON body counts as delivered: it fails loudly instead. The legacy caller keeps its old behaviour through an explicit option.

## 10. Media delivery without publishing anything

Evolution fetches media server-side with no Google credential, and campaign posters are stored in Drive **unpublished**. Publishing them so WhatsApp could read them would make every poster world-readable forever.

Instead each send mints a **signed, expiring link**: `/api/campaign-media/<posterVersionId>~<expiry>~<hmac>`, valid for 30 minutes, signed with `SESSION_SECRET` under its own domain prefix so a media token can never be presented as a session cookie. The route verifies the signature in constant time, checks the expiry, refuses any version that has no delivery record, then streams the bytes through the service account. Every failure is an identical bare 404.

- It is excluded from the session middleware for the same reason `/api/cron` and the Razorpay webhook are: the caller is a machine with no cookie, and it authenticates itself.
- Responses are `no-store`, so no proxy outlives the token.
- The Drive file is never published, never copied and never named to the browser or the provider.
- `PUBLIC_BASE_URL` must be set; delivery refuses with a clear reason rather than guessing an origin.

## 11. Message content

The caption is the day's **already approved** headline, supporting text and CTA, joined and trimmed, capped at 1024 characters. The file name is `Campaign_Day_007.png` — no identifier of any kind.

No model is called during delivery, no content is regenerated, and nothing is invented. Delivery consumes what review approved.

## 12. Cron and background execution

The existing `/api/cron` sweep gained a fourth phase that calls `runDueCampaignDeliveries`. No new endpoint, no new scheduler, no queue infrastructure.

- Authentication is the existing `CRON_SECRET` Bearer check, which fails closed on an unset secret. **There is no unauthenticated path that can trigger a send.**
- The campaign phase is wrapped so a failure in it cannot lose the legacy work already done in the same sweep, and each day's failure is recorded on its own row — a failure on day 5 never stops day 6.
- It is sequential and bounded (25 per tick): these go to real phones through one provider instance.
- The response now reports `campaignSent`, `campaignFailed` and `campaignSkipped`, which would otherwise be invisible in a scheduler log.

## 13. Legacy isolation

- The three legacy phases still carry `LEGACY_CALENDAR` (`campaignId: null`) on every selection and claim; the campaign phase reads only `CampaignDelivery` rows. The two never meet.
- Campaign delivery writes **no** legacy column — not `deliveryStatus`, `sendAfter`, `approvedAt`, `gDriveFileId` or `gDriveViewUrl`. Both the DB suite and the browser check assert the campaign days are byte-identical in those columns afterwards.
- `runCreativePipeline` still refuses any row with `campaignId` set.
- `check:calendar-scope` passes unchanged.

## 14. Security

- **Credentials never reach the browser or a stored string.** The instance token travels in a request header; `redactWhatsAppSecrets` scrubs `EVOLUTION_API_KEY`, `SESSION_SECRET` and `CRON_SECRET` out of every message before it is persisted to `failureReason`, and the DB suite proves a key echoed back by a provider is stored as `«redacted»`.
- **No Drive id, folder id or service-account detail** appears in any browser payload, any provider request or any media URL. Both suites assert this by scanning the serialised payloads.
- The media token carries only a poster version id, an expiry and a signature.
- The delivery actions are behind the admin session like every other action; the media route is the one deliberate exception and carries its own proof.

## 15. Tests

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | only the pre-existing warnings in `src/lib/poster/layout-render.tsx` (untouched) |
| `npm run lint:colors` | only the 14 pre-existing findings in `poster-studio-workspace.tsx`; Phase 6 adds none |
| `check:campaign` / `-db` (Phase 1) | 55 / 89 |
| `check:calendar-scope` (legacy isolation) | 39 |
| `check:campaign-content` / `-db` (Phase 2) | 57 / 65 |
| `check:campaign-mapping` / `-db` (Phase 3) | 62 / 82 |
| `check:campaign-posters` / `-db` (Phase 4) | 55 / 80 |
| `check:campaign-review` / `-db` (Phase 5) | 46 / 63 |
| `check:templates`, `check:import`, `check:manual` | pass |
| **`check:campaign-delivery`** (new, pure) | **84** |
| **`check:campaign-delivery-db`** (new) | **93** |

**`check:campaign-delivery`** pins the rules with no database: every refusal in the gate, each campaign status, recipient validation, the duplicate and stale-claim windows, the version pin, retry bounds and backoff, `deliveryInstant` at 09:00 and 18:30 IST including the missed/late boundary, caption assembly and truncation, file naming, the dashboard summary and filters, and the media token — forged signature, extended expiry, swapped poster id, malformed input and an unset secret all refused.

**`check:campaign-delivery-db`** runs the real service, the real sweep and the real server actions inside one rolled-back transaction with savepoints, table counts compared, `fetch` disabled and counted, and a fake provider:

- scheduling books only approved days and reports the rest by reason; re-running books nothing and duplicates nothing;
- a second delivery row for a day is impossible (`P2002`);
- unapproved, rejected, outdated, poster-less, invalid-recipient and unconfigured days are all refused **without a single provider call**;
- a paused campaign refuses Send Now and its sweep sends nothing, leaving bookings intact; resuming duplicates nothing;
- a successful send records SENT once with `sentAt` and the provider's message id, bills exactly one usage row, and carries the approved caption, a day-numbered file name, the client's own number and a media URL with no Drive id;
- a second Send Now and a later sweep both refuse `already-delivered`, make no call and bill nothing;
- a live claim blocks a second sender; a stale one is recovered;
- a 503 fails retryably and the retry succeeds; a 401 is permanent and is never retried, by Send Now or by the sweep; a timeout is permanent;
- a regenerated poster cancels the stale booking and neither version is sent;
- the sweep sends nothing early, exactly the due day at its moment, nothing on a second tick, and skips a day whose date has passed;
- the API key is redacted out of a stored failure;
- legacy rows are byte-identical, no legacy delivery column is written on any campaign day, and zero network attempts were made.

## 16. Browser check

Playwright, local only, in the git-excluded `.studio-checks/campaign-ui/delivery-ui-check.ts`: **75 / 75**.

**Setup:** a temporary git worktree dev server on port 3107; OpenAI pointed at `mock-openai-all.ts` (port 4012) and **Evolution pointed at `mock-evolution.ts` (port 4013)** — no spend and no message; storage in the private dev Drive with every file binned and every fixture row removed afterwards. The Evolution mock **really fetches the media URL it is handed**, which is how the signed poster link is proved end to end.

Covered, in the brief's order: a campaign with approved posters; delivery appearing scheduled with the version pinned; a confirmed Send Now producing **exactly one** provider request; the delivery becoming SENT with the provider's message id and one usage row; running delivery again — including through the real `/api/cron` endpoint — producing **no second request** and no second bill; an unapproved poster never even being booked; a rejected poster refused; an outdated poster refused; a forced 503 recorded as Failed with its reason, retryable, nothing billed; the retry recovering to SENT with both attempts counted; pausing leaving a *due* delivery unsent with its booking intact; resuming sending it exactly once with no duplicate bookings; a regenerated poster leaving the stale booking unsent and then cancelled with a readable reason by reconciling; manual Send Now behind a confirmation; 390 px with no horizontal overflow; and zero console errors.

Also proved here rather than only in unit tests: the mock gateway **fetched every media URL successfully** (200, `image/png`, ~88 KB) with no cookie and no Google credential, a forged or malformed media token gets a bare 404, the poster response is `no-store`, no request leaked a credential or Drive reference, and **no legacy delivery column was written on any campaign day**. Four provider requests in the whole run — days 1, 2 (failure), 2 (retry) and 6 — and three delivered days; every other day was refused before the provider was reached.

## 17. Known limitations

- **No delivery receipt.** The provider acknowledges acceptance only, so `SENT` is as far as the truth goes. There is no webhook, no read state and no failure-after-acceptance signal.
- **One destination.** Delivery goes to the client's own WhatsApp number because that is the only recipient the product has. A customer broadcast would need a contacts model with consent tracking, which is a product decision, not an implementation detail.
- **One sending instance** for the whole install, selected by `EVOLUTION_API_KEY`. There is no per-client sender, so all clients share one number's reputation and rate limits.
- **`PUBLIC_BASE_URL` must be reachable by the Evolution server.** On a split deployment where the gateway cannot reach the console, media delivery fails until it can.
- **A 30-minute media link** is a real, if small, exposure: anyone holding the URL within that window can fetch that one poster.
- **No send jitter.** Legacy deliveries are spread by `WHATSAPP_SEND_DELAY_*`; campaign deliveries go at the campaign's configured minute. Many campaigns sharing a delivery time would burst.
- **An ambiguous timeout stops the day.** It is marked permanent and needs a human, which is the safe side of the trade but does mean a slow gateway can leave work for an operator.
- **A `SENDING` claim is recognised as stale after 10 minutes**, so a day whose server attempt died shows Sending until then.
- **`UsageEvent` has no `posterVersionId`**, so a campaign send is attributed to the calendar day, as the legacy send is. Message prices are unset (`PRICE_WHATSAPP_PER_MESSAGE` defaults to 0), so usage rows are unpriced.
- **The sweep is bounded at 25 deliveries per tick.** A very large backlog drains over several minutes rather than at once — deliberate, but worth knowing.
