# Campaign automation — Phase 4: rolling campaign poster generation

**Status:** posters are generated for a rolling window of upcoming campaign days. Everything below happens on `feature/ai-poster-studio`; nothing is merged or deployed.

**Not in this phase:**
- WhatsApp sending
- delivery scheduling
- Phase 5

Legacy calendar behaviour is unchanged.

```
Campaign day (content + mapped template) → Poster Studio pipeline
  → RAW artwork → Brand Canvas footer → FINAL poster → Drive (RAW, FINAL)
  → PosterStudioGeneration row → PosterVersion → activePosterVersionId
```

## 1. Audit findings and architecture

- **Poster Studio already had every stage a campaign poster needs:**
  - `renderStudioImage`: gpt-image-2. `images.edit` when a reference is attached; no retries; typed errors.
  - `buildGeneratePrompt`: brief, format, Brand Canvas guidance, reference rules, identity band, no-invented-branding.
  - `loadStudioBrandCanvas` and `prepareStudioOverlay` / `composeStudioPoster`: the deterministic footer, with a dry run before any spend.
  - `resolveStudioFolder` / `storeStudioFile`: unpublished Drive files.
  - `recordOpenAiImageUsage`, `readStudioImageSize` (decode check), `/api/poster-studio/[id]/image`.
- **One pipeline, a second entry point.** `src/lib/campaign/poster-generation-service.ts` composes those same functions in the same order as `generateStudioPosterAction`. No image code is duplicated and Poster Studio's own flow is unchanged.
  - **Reference image:** the mapped template's image is attached as the reference, so Poster Studio's "visual inspiration only; ignore its identity" rules apply to it.
  - **Testing:** every stage is passed in as a dependency (`PosterGenerationDeps`), which is how the DB tests replace the model and Drive.
- **Records.** Each poster is:
  - a `PosterStudioGeneration` row: the artwork record, with RAW and FINAL files, prompts, model, format and overlay;
  - an immutable `PosterVersion`: the campaign record, with the day, source, content revision, template, approval and `studioGenerationId`.

  So the protected image route, RAW/FINAL separation and Edit/Variation all work on campaign posters unchanged. The browser only ever receives studio row ids, never Drive ids.
- **Phase 1 rule relaxed.** A `PIPELINE` version may now carry `studioGenerationId`. `POSTER_STUDIO` still requires it; `MANUAL_UPLOAD` still forbids it.
- **Poster shape.** The poster format is the client's output preset (as in Phase 3). Only the studio formats 9:16, 1:1 and 16:9 are supported; any other shape is reported as unsupported.

### Migration `20260916000000_campaign_poster_generation`

- **Change:** one additive nullable column, `ContentCalendar.posterGenerationStartedAt`. It identifies the attempt holding a GENERATING claim, so a finished attempt cannot overwrite a newer one and a crashed attempt can be recognised as stale (after 10 minutes).
- **Not changed:** no backfill, and no other column, index or constraint.
- **How it was applied:** the dev DB was confirmed as `localhost:5434/evokz_ai_dev` and backed up with `pg_dump`. The migration was then applied with `migrate deploy`; the diff is empty afterwards.

## 2. Rolling window

- `Campaign.generationWindowDays` (default 14) sets the window: today through today + N − 1 (local days, app timezone).
- **Generate Upcoming / Generate Missing** consider only days in that window. Posters are never produced for the whole campaign. Days outside the window stay editable content and template slots.
- **Explicit requests** may reach beyond the window: a day-number range, "Generate days" / "Regenerate days", or a single day's Generate / Retry / Regenerate. Past days are always refused.

## 3. Eligibility (`evaluatePosterEligibility`)

A day is eligible only when all of these hold. Otherwise the first reason is returned — never silently skipped.

| Check | Reason when it fails |
| --- | --- |
| Campaign ACTIVE | `campaign-not-active` / `campaign-closed` |
| Not already generating (fresh claim) | `generating` |
| Date not in the past | `in-the-past` |
| Inside the window (unless explicit) | `outside-window` |
| Has no poster (Generate Missing) · no current poster (Generate Upcoming) | `already-generated`, or `outdated` for Missing |
| Content `READY` | `content-not-generated` / `content-needs-review` |
| An effective template (selection wins over suggestion) | `no-template` |
| That template is usable: active, approved, in the vertical, and for an AUTO mapping the right shape and content type | `template-inactive` / `template-unapproved` / `template-unavailable` / `template-incompatible` |
| Client format is a studio format | `unsupported-aspect` |
| Brand Canvas has extracted brand colours | `brand-canvas-unavailable` |

- **Needs attention:** template, format and Brand Canvas reasons.
- **Manual mappings:** a MANUAL choice of a different shape or type stays a deliberate warning (Phase 3) and is eligible.
- **No silent remapping:** a template is never remapped during generation. An inactive or invalid mapped template blocks the day until someone replaces it.
- **Checked at generation time:** logo readability, fonts and the reference file are verified by the pre-flight, before any spend.

## 4. Generation states

These are derived, never stored (`derivePosterState`), from Phase 1's `generationStatus`, the active version, `contentRevision` and approval:

- Not generated
- Generating
- Failed
- Needs approval
- Approved
- Rejected
- Outdated — regeneration required
- Needs attention

A failed *regeneration* never hides an existing poster; the last failure is shown beside it.

## 5. Generation flow (one day)

1. **Eligibility** is re-evaluated from fresh rows. An ineligible day is returned as skipped, with no call.
2. **API key check** happens before the claim.
3. **Claim.** Stale GENERATING claims are released. Then NOT_REQUESTED / SUCCEEDED / FAILED → QUEUED → GENERATING runs as conditional updates that restate the status, content revision, active version, both template columns and campaign ACTIVE.
4. **Pre-flight, before spend:**
   - Brand Canvas;
   - the overlay (the logo in the background mode Brand Canvas chose, tagline, website and phone where present, AUTO footer) with a dry-run composite;
   - the Drive folder;
   - the template file, read and normalised.
5. **Prompt:** the brief is the day's content type, topic, exact headline, supporting text and CTA, and the visual direction, inside Poster Studio's GENERATE prompt. No identifier of any kind is included.
6. **Render**, record usage, then check the image decodes.
7. **Compose** the FINAL poster. RAW and FINAL are stored as separate Drive files; RAW is never overwritten.
8. **Record in one transaction:** studio row + `addPosterVersion` (PIPELINE, FINAL image, content revision at claim, template) + status SUCCEEDED. The new version becomes active.

## 6. Versioning

- Every poster is a new `PosterVersion`; no version is ever modified except its review fields. Regeneration adds v2, v3 … and the newest becomes active through Phase 1's pointer.
- Only one version is active per day, by construction.
- **Changes after a poster exists:**
  - A content change (poster inputs) or an effective-template change bumps `contentRevision`. The poster becomes **Outdated**, and nothing is regenerated automatically.
  - **Generate Missing** skips outdated days (`outdated`).
  - **Generate Upcoming** lists them as regenerations in its confirmation.
- **Poster Studio:** a day's **Edit** opens `/admin/poster-studio?campaignDay=…`.
  - The studio opens in Edit mode on the active poster's RAW artwork, or in Generate with the day's brief when there is no poster yet.
  - The client and format are preselected, and a banner explains the flow.
  - **Save to Day N** creates a `POSTER_STUDIO` version (parent = the previous active version) and activates it. It is refused for another client's poster or another format, and saving the same studio poster twice does not duplicate it.
  - Standalone Poster Studio is unchanged, except that deleting a History item a campaign version uses is now refused with a clear message. The foreign key already blocked it, but only with a generic error.

## 7. Idempotency and duplicates

- A generated day is skipped (`already-generated`) before any call. The claim's conditional update makes double clicks, two tabs or two runs unable to both spend on, or both create, a version for the same day.
- A second Generate Upcoming run offers only genuinely eligible days: missing, failed retries and outdated. With none, the confirmation says "Nothing to generate." and offers no button.

## 8. Batches, stop/resume and error recovery

- **How batches run:** the browser calls one day per request, sequentially (concurrency 1), with progress, "Stop after this poster" and a `beforeunload` warning.
- **Failures:**
  - A failed day does not stop the batch, and earlier posters are untouched.
  - Credential, configuration or billing failures (`config`, `auth`, `access`, `model`, `quota`) stop the batch, because every later day would fail the same way.
- **Recovery:**
  - Any failure leaves the day FAILED with an operator message. Files written for it are binned, and its previous active poster is untouched.
  - After billing, the message says the image was billed and not saved.
  - The next run retries the day. Nothing retries automatically.
- **Refresh or stop:** completed posters remain. The poster in progress still finishes on the server, or is released as stale after 10 minutes. Unfinished days stay eligible.
- **Errors mapped** (reusing Poster Studio's `StudioError` kinds): OpenAI timeout, 401, 403, 404, 429/quota, 5xx, moderation, malformed or empty response, unreadable image, Drive folder/upload/read failure, database failure, missing Brand Canvas, missing, inactive or unapproved template, unsupported format, footer composition failure, network interruption.

## 9. Cost protection

- Every batch (Upcoming, Missing, a range) first shows **Eligible days: X · Estimated generations: X**, how many replace an existing poster and how many are retries, and why every other day in scope is excluded. Nothing runs until the operator confirms, and nothing is offered when X = 0.
- A single day's Regenerate needs a second click ("Generate 1 new version").
- Content or template edits never trigger a generation.

## 10. Drive storage

- **Where files go:** Poster Studio's private folder per client (`Poster Studio/<company>`), unpublished. RAW (`campaign-day-N-…-raw.png`) and FINAL (`…-final.png`) are separate files.
- **What the browser sees:** images through the admin-gated studio image route only. No public links, and no Drive ids in any browser payload.
- **Drive failure after generation:** files written by the attempt are binned, the day is FAILED, and a retry is possible.
- **The template reference** is read from the template's own Drive file and is not copied or recorded on the studio row, so studio clean-up can never bin a template.

## 11. Approval

- **Initial state:** `Campaign.approvalPolicy` (Phase 1) sets it. `MANUAL_REVIEW` → PENDING (Needs approval); `AUTO_APPROVE` → APPROVED.
- **Approve** approves the active, current version through Phase 1's `reviewPosterVersion`. Approving an outdated poster or a non-active version is refused.
- There is no parallel approval system, and nothing is sent.

## 12. Admin UI

- **Poster generation** card on the campaign calendar:
  - **Header:** the window dates, format and approval policy, and Activate / Pause / Resume (activating sends nothing).
  - **Counts:** Generated, Needs approval, Approved, Outdated, Failed, Needs attention, Not generated, Unmapped.
  - **Campaign-wide blockers:** a DRAFT or paused campaign, Brand Canvas, format.
  - **Actions:** Generate Upcoming, Generate Missing, Review Attention, and a day-range Generate / Regenerate.
  - **Confirmation, progress and stop** as in §8–9.
  - **Per window day:** thumbnail, state, template, reason, and Generate / Retry / Regenerate / View (version history with FINAL and RAW) / Edit (Poster Studio) / Approve.
- **Poster Studio:** the campaign-day banner with Save to Day N.
- **Layout:** the content calendar is not overloaded, and pages stay free of horizontal overflow at 390 px.

## 13. Tests

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | only the pre-existing warnings in `src/lib/poster/layout-render.tsx` (untouched) |
| `npm run lint:colors` | only the 14 pre-existing findings in `poster-studio-workspace.tsx`; Phase 4 adds none |
| `check:campaign` / `check:campaign-db` (Phase 1) | 55 / 89 |
| `check:calendar-scope` (legacy isolation) | 39 |
| `check:campaign-content` / `-db` (Phase 2) | 57 / 65 |
| `check:campaign-mapping` / `-db` (Phase 3) | 62 / 82 |
| `check:templates`, `check:import`, `check:manual` | pass (98 / 89 for import and manual) |
| **`check:campaign-posters`** (new, pure) | **55** — window, formats, stale claims, Brand Canvas readiness, every eligibility reason in all three modes, derived states, summary, brief privacy and length |
| **`check:campaign-posters-db`** (new) | **80**, detailed below |
| Poster Studio no-spend smoke (`.studio-checks/mock-smoke.ts`, against the Phase 4 build) | Generate with logo background removed; RAW ≠ FINAL; image route 200 with a session / 307 without; action 401 without a session; 0 Drive ids and 0 secrets in browser payloads. The one row it created was removed. |

`check:campaign-posters-db` runs the real service, prompt builder, reference preparation, decode check, usage ledger, studio rows, versions and server actions. Only the image model, Drive and the font-dependent overlay are fakes. It runs in one rolled-back transaction, with nested transactions on real savepoints, table counts compared, and 0 network attempts.

- **Rolling window:** days 3–16 of a campaign started 2 days ago; never all 30. A DRAFT campaign is refused with its reason.
- **Refusals without a provider call:**
  - missing content;
  - no template, and an inactive template (not remapped);
  - missing Brand Canvas;
  - a 4:5 client (unsupported format).
- **A successful generation:**
  - template attached as the reference, 9:16 size;
  - prompt content present and the no-invented-branding rule included;
  - no id, Drive id, folder or WhatsApp number in the prompt;
  - RAW ≠ FINAL files, and a studio row with prompts and overlay;
  - a `PIPELINE` version (final image, template, content revision), active, PENDING under MANUAL_REVIEW;
  - usage recorded; no delivery column written.
- **Idempotency:** a second run makes no call and no second version. A day claimed elsewhere is skipped. A stale 20-minute claim is released and generated.
- **Batch:**
  - a moderation failure on one day only;
  - a Drive failure after upload: failed, RAW binned, usage recorded;
  - earlier successes intact;
  - stop after 6, then resume offers only unfinished days plus failures as retries;
  - a rerun makes 0 calls; exactly one version per window day.
- **Failures:**
  - OpenAI 401 stops the batch;
  - an unreadable image fails as billed, with nothing stored;
  - footer failure;
  - a missing API key is refused before the claim;
  - an unreadable template file fails before spend;
  - a database failure after storage rolls back the studio row, leaves no version and bins both files;
  - an explicit day beyond the window generates.
- **Versioning:** regeneration creates v2 active with v1 byte-identical. Content and template changes → outdated, never regenerated by Generate Missing, offered as regenerations by Upcoming.
- **Approval:** approving a non-active or outdated version is refused. AUTO_APPROVE → APPROVED.
- **Poster Studio:** save-to-day creates a POSTER_STUDIO v3 with parent v2. It is idempotent, refuses another client's poster or another format, and the studio's delete of a History item in use is refused. Version history has no Drive ids.
- **Isolation:** pausing blocks generation. Legacy rows are byte-identical and legacy scope excludes campaign days. No WhatsApp usage; only image usage rows added, one per billed image. Ran against the local dev DB only.

**Browser check** (Playwright, local only, in the git-excluded `.studio-checks/campaign-ui/poster-ui-check.ts`): **39 / 39**.

- **Setup:**
  - a temporary git worktree dev server on port 3107, so the main checkout was untouched;
  - OpenAI chat and images pointed at a local mock (`mock-openai-all.ts`, port 4012) — no spend;
  - Evolution and fal disabled;
  - storage in the private dev Drive, as in the Poster Studio no-spend checks, with every file created binned and every fixture row removed afterwards.
- **Steps covered:**
  1. Create campaign → content generated (mock) → templates Auto Mapped → Activate.
  2. Generate Upcoming, with the confirmation "Eligible days: 5 · Estimated generations: 5". Day 3 fails by moderation (Failed and reason shown); the other 4 are generated.
  3. The poster is served through the protected route at 1152×2048. RAW and FINAL are separate with different pixels. The FINAL has the real Brand Canvas footer (name, tagline, website, phone). Version v1 is PIPELINE, active, needs approval.
  4. Retry day 3. Regenerate day 2: v2 active, v1 unchanged, View lists both and shows the image.
  5. Edit day 4's content → Outdated, with no request. Generate Missing → "Nothing to generate".
  6. Refresh during a 4-poster batch: 2 finished and kept, nothing left claimed. The next run offers exactly the 2 unfinished days.
  7. Final state: every window day has one active current poster, and version counts are exact (no duplicates). Generating again offers nothing and makes no request.
  8. Approve day 1.
  9. Edit day 2 in Poster Studio (opens in Edit on v2) → Save to Day 2 → v3 POSTER_STUDIO active.
  10. 390 px: no horizontal overflow on the calendar or on Poster Studio for a campaign day.
  11. 0 console errors and 0 page errors. No WhatsApp usage; no delivery column written.
- **Mock request log:** every image request had the template attached and `leak=false`, and included the no-invented-branding rule.

## 14. Known limitations

- **Generation is browser-driven**, one poster per request. There is no server-side queue or scheduled rolling generation yet: posters are made when an operator runs a batch. A closed tab stops after the current poster.
- **Formats:** only 9:16, 1:1 and 16:9 client outputs can be generated (Poster Studio formats). Other presets (4:5, 3:4 …) are reported as unsupported.
- **Brand Canvas readiness** is checked statically as "brand colours extracted". Logo readability and fonts are checked by the pre-flight at generation time, so such failures appear as a FAILED day (before spend) rather than as Needs attention.
- **The template is a style reference** for gpt-image-2, not a layout the renderer reproduces; the poster follows it as visual inspiration.
- **A stale GENERATING claim** is recognised after 10 minutes. Until then, a day whose server attempt died shows Generating.
- **Two attempts can both finish** if a server attempt outlives the stale window (over 10 minutes) and a second attempt claims the day. Both versions are kept and the later one is active; there is still exactly one active version.
- **Campaign posters appear in Poster Studio History**, since they are studio rows. They cannot be deleted from there while a campaign version uses them.
- **Image prices are not configured**, so usage rows are unpriced (as in Poster Studio).
- **Rejecting** a poster (Phase 1's REJECTED) has no button in the campaign UI yet; Approve does.
