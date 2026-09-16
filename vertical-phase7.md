# Campaign automation — Phase 7: operations and reliability

**Status:** campaign poster generation runs on the server and survives a closed tab; an operator can see a campaign's health and everything blocking it in one place; AI spend is attributed per campaign and labelled as an estimate. Everything below happens on `feature/ai-poster-studio`; nothing is merged or deployed, and no WhatsApp message was sent — every test drives a local mock.

**No migration.** See §2. The Prisma schema-engine is still blocked on this machine, and nothing here needed it.

**Not in this phase:** Phase 8, any change to the recipient architecture, any customer-facing marketing.

```
Operator queues a batch → ContentCalendar.generationStatus = QUEUED  (instant, no spend)
   ↓ tab may close
cron sweep → claim (QUEUED → GENERATING) → Phase 4 pipeline → SUCCEEDED / FAILED
   ↓
Campaign health + needs-attention queue → the day that needs a decision
```

## 1. The audit, and what it changed

The brief required auditing before coding. Three findings shaped the phase:

- **The queue already existed.** Phase 1 defined `PosterGenerationStatus.QUEUED` as "a request nobody has claimed yet" with the transitions `NOT_REQUESTED/SUCCEEDED/FAILED → QUEUED → GENERATING`, and `posterGenerationStartedAt` as the claim token with stale recovery. Until now `QUEUED` was only ever momentary. Server-side generation is therefore a worker over an existing durable state — **no new table, no Redis, no queue infrastructure.**
- **Cost needed no column.** `UsageEvent.calendarId` already carries the campaign day id on every campaign render, and `ContentCalendar.campaignId` joins it to the campaign; `PosterStudioGeneration` already stores model, size, quality and aspect ratio. The unpriced-image problem is *configuration* — `pricing.ts` has the three `PRICE_OPENAI_IMAGE_*` rates and `priceOpenAiImageCall` returns `null` rather than a fake zero until they are set.
- **Two real performance defects in Phases 5–6**, both mine, both fixed here (§8).

A security review of the whole Phase 1–6 campaign surface found **no actual vulnerability**; its defence-in-depth findings are in §7.

## 2. Migration status

**None required, and none created.** Every Phase 7 feature is built from columns that already exist. Per the brief's §19 this means "continue normally" — the schema-engine was not invoked, no SQL was applied by hand, and `_prisma_migrations` was not touched.

One optional index is **reported, not applied**: `UsageEvent.calendarId` has no index, so the per-campaign cost aggregate scans as the ledger grows. It is a migration, it is not needed for correctness, and it should wait until the schema-engine can run normally.

## 3. Server-side generation

**`queueCampaignPosters`** plans a batch with Phase 4's own planner, then marks each eligible day `QUEUED` with a conditional update that restates the day's content revision. It calls no provider and spends nothing, so it returns instantly and the browser may close. Queueing twice queues nothing twice — a day already waiting is reported, not re-queued.

**`runQueuedCampaignGenerations`** is the worker, called once per cron tick as sweep phase 4. It selects queued days of **ACTIVE campaigns only**, plus `GENERATING` claims older than `STALE_GENERATION_MS` (10 minutes), and runs the unchanged `generateCampaignDayPoster` for each.

**Every Phase 4 safety property is preserved, because the per-day work is unchanged:**

- eligibility is re-evaluated from fresh rows before the claim;
- the claim is a conditional update restating generation status, content revision, active version, both template columns and campaign ACTIVE;
- `posterGenerationStartedAt` still identifies the attempt, so a crashed worker is recoverable and a finished attempt cannot overwrite a newer one;
- two workers cannot both generate — or both bill for — the same day.

Two small, default-off relaxations make the queue drainable: `acceptQueued` on the claim (only the worker may take a `QUEUED` day) and the matching relaxation in `evaluatePosterEligibility`, which otherwise reports a queued day as "generating". A live `GENERATING` claim still blocks, which is what stops two workers colliding.

**Recovery:** a failed day settles `FAILED` with its reason and is **not** re-queued automatically — bounded by construction, and a configuration or credential failure would repeat identically. An operator re-queues it. A configuration/credential/billing failure stops the whole sweep and leaves the rest `QUEUED` for the next tick, rather than marking every day failed and burying the cause.

**Pause/resume:** pausing stops the queue without touching a row (the worker only sees ACTIVE campaigns), and queueing is refused while paused. Resuming lets the same queued days continue — no duplicates, because nothing moved.

## 4. Bounded concurrency

Two bounds, both configurable, both conservative:

| Setting | Default | Cap |
| --- | --- | --- |
| `CAMPAIGN_GENERATION_LIMIT` (days per tick) | 4 | ≥ 1 |
| `CAMPAIGN_GENERATION_CONCURRENCY` (at once) | **1** | 4 |

Each day is an image call plus a composite plus two Drive writes, and the sweep shares a request budget and provider quota with the legacy dispatch phases. The default of 1 is deliberate; the cap of 4 exists so a misconfiguration cannot swamp OpenAI, Drive or the database.

## 5. Cost accounting

**Per campaign, from the existing ledger.** `loadCampaignUsage` aggregates `UsageEvent` rows whose `calendarId` is one of the campaign's days — which picks up image generations and campaign WhatsApp messages alike — and returns generations, exact token counts, cost in USD micros, and the number of generations recorded **unpriced**.

**Estimated, never a bill.** The image API returns token counts and no price. So:

- a row recorded while `PRICE_OPENAI_IMAGE_*` were unset carries exact tokens and `costUsdMicros = 0`, which means *not priced*, not free;
- the dashboard says so in as many words and names the variables to set, rather than showing a confident zero;
- when the rates are configured, new calls price themselves at write time from the rate card — which is centralised in `src/lib/pricing.ts` and nowhere else;
- the panel is labelled **Estimated** and states that it comes from recorded tokens and the configured rate card, not from a provider invoice.

## 6. Operational dashboard

A **Campaign health** card, first on the campaign page:

- **Counters** — Content, Templates, Posters, Approved, Delivered — each a link into the queue that fixes the shortfall. Content and templates are counted campaign-wide; posters and approvals across the rolling window, because only the window is generated.
- **AI usage** — generations, messages, estimated spend, queued-to-generate.
- **Needs attention** — every blocker, grouped `CONTENT → TEMPLATE → POSTER → APPROVAL → DELIVERY`, each naming its day and linking to `?review=…` or `?delivery=…`. Capped at 40 items so a systematic fault does not render hundreds of identical rows; the counters stay exact.

`loadCampaignHealth` and `loadClientCampaignAttention` use the same `derivePosterState` as the queues they link to, so a count here can never disagree with what the operator finds when they click it.

## 7. Security

The review of Phases 1–6 found **no actual vulnerability**: the middleware gate, the cron Bearer check, the media token's HMAC-before-expiry with a constant-time compare, the `SENT`-is-terminal rule and the absence of Drive ids in browser payloads all hold as documented. Phase 7 hardens four things it flagged:

- **Cron comparison is now constant-time.** It was the only credential check in the codebase that was not.
- **The `?token=` cron fallback now warns.** It puts `CRON_SECRET` into the request URI and therefore into proxy access logs. Neither shipped scheduler uses it, but removing it could break an unknown one, so it logs a warning naming the fix instead of failing silently. **Recommendation: retire it.**
- **Media tokens are redacted** out of anything persisted. A gateway echoing the request URL in an error body would otherwise store a live, replayable poster link in `CampaignDelivery.failureReason`, which the console renders. `OPENAI_API_KEY` was added to the same list.
- **Delivery actions are campaign-scoped.** `sendCampaignDayNowAction`, `retryCampaignDeliveryAction` and `cancelCampaignDeliveryAction` now take `(campaignId, dayId)` and verify membership, as poster generation has since Phase 4. With one shared login this is blast radius rather than authorization — but Send Now is the one action that reaches a real phone, and a stale tab can no longer point it at another client's day.

Still open, and reported rather than changed: the login throttle is per-process and in-memory, and the middleware's exclusions are prefix matches, so a future `/api/cron-*` route would be unauthenticated by accident.

## 8. Performance

Measured against a 365-day campaign:

- **The delivery queue's thumbnails were eager.** 365 `<img>` tags with no `loading="lazy"`, each a Drive download plus a re-encode on the server, for one page view. One attribute; the biggest single win on the surface.
- **The client page ran an N+1.** It called `loadCampaignReview` — a full poster overview, all days, all active versions, the whole template set, five eligibility evaluations per day — once per campaign, serially, to print six integers. Replaced by `loadClientCampaignAttention`: one query for all of a client's campaigns.
- **The campaign page serialised three independent reads.** `loadPosterOverview`, `loadCampaignDeliveryOverview` and `loadCampaignHealth` now run in one `Promise.all`.

Not done, and deliberately: the campaign page still reads the day set more than once across its three overviews, and the queues are not paginated. Both are real, neither is a correctness problem, and unpicking the overviews' shared shape is a larger refactor than this phase should carry. Recorded in §11.

## 9. Rejection → regeneration

When a day whose **active version is REJECTED** is regenerated, the reviewer's note becomes one instruction at the end of the brief: *"The previous version of this poster was rejected in review for: …. Fix that specifically, and do not repeat it."*

Constrained on purpose:

- **only the note on the version being replaced** — never a history, never an earlier rejection, never who reviewed it;
- an approved or merely outdated poster contributes nothing;
- the note is operator free text, so it is **sanitised**: uuids, links, email addresses and long digit runs are stripped, and it is capped at 200 characters. A note that is only punctuation yields nothing rather than noise;
- **nothing regenerates automatically after a rejection.** This changes what a regeneration says, not when one happens.

## 10. Tests

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | only the pre-existing warnings in `src/lib/poster/layout-render.tsx` (untouched) |
| `npm run lint:colors` | only the 14 pre-existing findings in `poster-studio-workspace.tsx`; Phase 7 adds none |
| `check:campaign` / `-db` (Phase 1) | 55 / 89 |
| `check:calendar-scope` (legacy isolation) | 39 |
| `check:campaign-content` / `-db` (Phase 2) | 57 / 65 |
| `check:campaign-mapping` / `-db` (Phase 3) | 62 / 82 |
| `check:campaign-posters` / `-db` (Phase 4) | 55 / 80 |
| `check:campaign-review` / `-db` (Phase 5) | 46 / 63 |
| `check:campaign-delivery` / `-db` (Phase 6) | 84 / **96** |
| `check:templates`, `check:import`, `check:manual` | pass |
| **`check:campaign-operations`** (new, pure) | **50** |
| **`check:campaign-operations-db`** (new) | **90** |

Phase 6's DB suite grew from 93 to 96: its exact-`scheduledFor` assertion now asserts *nominal time plus this day's deterministic spread*, and it gained the cross-campaign scoping checks.

**`check:campaign-operations`** pins the rules with no database: rejection guidance and every sanitisation case, the brief carrying it only when it applies, the delivery spread's determinism and distribution over 400 samples, the queue's bounds, the bounded fan-out's real overlap, and the needs-attention queue's grouping, ordering and cap.

**`check:campaign-operations-db`** runs the real queue, worker, health model, cost aggregate and server actions inside one rolled-back transaction with savepoints, table counts compared, `fetch` disabled and counted:

- queueing is instant, spends nothing, writes `QUEUED`, and is idempotent; an interactive request will not steal a queued day;
- the worker drains within its limit, leaves the rest queued, and produces exactly one version per day;
- a second worker finds nothing to claim, and a day under a live claim is refused — one render paid for, one version;
- a stale claim is recovered and generated; a fresh one is never stolen;
- pausing generates nothing and leaves the queue intact, queueing is refused while paused, and resuming continues without duplicates;
- a rejected day's regeneration carries the reviewer's words and no identifier; a non-rejected or approved poster carries none;
- every generation is billed to a day of its campaign with exact tokens; unpriced rows are reported as unpriced, not free; configuring the rates prices new calls to the exact rate-card figure; another campaign's usage stays zero;
- health counts content and templates campaign-wide, posters window-only; each blocker kind appears in the attention queue with a link; the payload carries no Drive id; the client-page counts agree with the queue;
- bookings carry the deterministic spread and reconciling does not move them;
- another campaign's day is refused by the send, cancel and retry actions;
- legacy rows are untouched and zero network attempts were made.

## 11. Browser check

Playwright, local only, in the git-excluded `.studio-checks/campaign-ui/operations-ui-check.ts`: **52 / 52**. Phase 6's check re-run unchanged: **75 / 75**.

Setup as in Phase 6 — a worktree dev server on 3107, OpenAI on the mock at 4012, **Evolution on the mock at 4013** — with `CAMPAIGN_GENERATION_LIMIT=3` so the batching is observable. Generation is driven by calling the real `/api/cron` with its real Bearer token, which is exactly what the host crontab does.

Covered: the health panel and its counters; the needs-attention queue; queueing a batch (which writes `QUEUED`, spends nothing and creates no version); **closing the page** and watching the cron sweep generate anyway, bounded to 3 per tick; a second sweep finishing the queue; an idle sweep generating nothing and creating no duplicate; an abandoned `GENERATING` claim recovered on the next sweep; cost shown with the unpriced warning and never as an invoice; approve → schedule → deliver through the sweep with exactly one provider request and none on the next; a forced 503 recorded failed-but-retryable and then recovered; pause generating nothing and leaving the queue intact, then resume; reject → regenerate with the reviewer's words reaching the model (`rejection=true` and an excerpt, with `leak=false` on every call) and the rejected version byte-identical afterwards and the new one PENDING; 390 px with no horizontal overflow; `/api/cron` returning 401 unauthenticated and with a wrong token; no legacy delivery column written; zero console errors.

## 12. Known limitations

- **The sweep is the only worker.** Generation advances once per cron tick at up to 4 days a tick, so a large backlog drains over minutes, not seconds. There is no long-running process, by design — the deployment has no worker to host one.
- **A failed generation is not retried automatically.** It is bounded by being operator-driven; the cost is that a transient provider blip needs a person to re-queue.
- **A stale claim is recognised after 10 minutes**, so a day whose worker died shows Generating until then.
- **Cost is an estimate and the historical rows are unpriced.** Setting `PRICE_OPENAI_IMAGE_*` prices new calls only; older rows keep exact tokens and no price. Re-pricing them at read time would be approximate, because the text/image input split is collapsed into one `inputTokens` column on write.
- **Campaign *copy* spend is not attributable to a campaign.** `content-generation.ts` bills with `clientId` but no `calendarId`, so a client with two campaigns cannot split it. A code fix, not a schema one — deliberately left for a phase that can test it properly.
- **`UsageEvent.calendarId` is unindexed**, so the per-campaign aggregate scans as the ledger grows. The index is a migration and is therefore reported, not applied.
- **The needs-attention list is capped at 40.** The counters stay exact; the list is a way in, not an inventory.
- **The queues are still unpaginated**, and the campaign page still reads the day set more than once across its three overviews. Both are real at 365 days and neither is a correctness problem.
- **`?token=` on `/api/cron` still works** and still writes the secret into proxy logs. It warns now; retiring it is a deployment decision.
- **The rejection note is advisory.** It is passed to the model as an instruction; nothing verifies that the next image actually fixes the problem, and the reviewer still has to look.
- **No cleanup was automated.** Orphaned Drive artifacts from failed generations are already binned by the pipeline's own error path; a broader retention sweep was judged too risky to add without a way to prove it would never touch a referenced file.
