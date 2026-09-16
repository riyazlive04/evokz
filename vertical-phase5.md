# Campaign automation — Phase 5: campaign review and approval

**Status:** an operator can review every generated poster, approve or send it back with a reason, fix it, and see how ready the campaign is. Everything below happens on `feature/ai-poster-studio`; nothing is merged or deployed.

**Not in this phase:**
- WhatsApp sending
- delivery scheduling
- Phase 6

Legacy calendar behaviour is unchanged, and Phases 1–4 are untouched except where noted in §1.

```
Poster (Phase 4) → review queue → Approve            → delivery-ready (Phase 6 will send)
                               → Reject + reason     → Edit in Poster Studio / Regenerate → new version → review again
                               → Outdated (content or template changed) → Regenerate
```

## 1. Architecture — one approval model

Phase 5 adds no new approval concept. It is a queue and three writes over what already existed.

- **Approval stays on the version.** `PosterVersion.approvalStatus` / `reviewedAt` / `reviewNote` (Phase 1), moved only by `reviewPosterVersion` along `APPROVAL_TRANSITIONS`, and read for delivery by `evaluateDeliveryReadiness`. No parallel status, no new table, no new column.
- **State stays derived.** Phase 4's `derivePosterState` remains the single derivation of a day's poster state. Phase 5 groups those states into buckets and decides which actions are offered.
- **New files:**
  - `src/lib/campaign/review.ts` — the pure rules: rejection reasons, filters, what may be approved or rejected, the bulk plan, readiness. No database, no network.
  - `src/lib/campaign/review-service.ts` — the queue, one day's detail, and the writes (approve, reject, bulk approve).
  - `src/components/campaign/CampaignReviewQueue.tsx`, `src/components/campaign/CampaignDayDetail.tsx`.
- **Changed:**
  - `poster-generation-service.ts`: `approveCampaignDayPoster` now returns silently when the version is already APPROVED (so a bulk run is idempotent) and refuses a REJECTED one with "This poster was rejected — edit or regenerate it before approving." `PosterVersionSummary` also carries `reviewNote`, so the queue can show the rejection reason.
  - `actions.ts`: `rejectCampaignDayPosterAction`, `approveCampaignPostersAction`, `loadCampaignDayReviewAction`. `loadCampaignDayPostersAction` was replaced by the day detail, which is a superset of it.
  - `CampaignPosterGeneration.tsx`: its own version dialog was removed and it now opens the shared `CampaignDayDetail`, so both cards offer the same actions.

**No migration.** `reviewNote` already stores the rejection reason, and every other field exists. The dev DB was not modified in this phase.

## 2. Approval states

The queue shows Phase 4's eight derived states, grouped into what an operator does with them:

| State | Meaning | Offered |
| --- | --- | --- |
| Needs approval | current poster, PENDING | Approve · Reject · Regenerate · Edit |
| Approved | current poster, APPROVED | Reject (withdraws approval) · Regenerate · Edit |
| Rejected | sent back, still the day's poster | Regenerate · Edit |
| Outdated | content or template changed after it was made | Reject · Regenerate · Edit |
| Failed | the last generation failed | Retry / Generate |
| Not generated | nothing made yet | Generate (when eligible) |
| Generating | an attempt holds the day | nothing |
| Needs attention | mapping, format or Brand Canvas problem | fix the mapping first |

`approvalRefusal` gives the one reason a day cannot be approved, and the UI never offers an action it would refuse: `campaign-closed`, `already-approved`, `rejected`, `outdated`, `generating`, `no-poster`.

- **Approve** only ever applies to the day's **active, current, pending** version. An outdated poster, a rejected one and an older version from history are all refused — approval belongs to the version that represents the day.
- **Reject** applies to anything a person can still see as the day's poster: pending, approved or outdated.
- **A closed campaign** (COMPLETED / CANCELLED) refuses every review write.

## 3. Rejecting a poster

- **A reason is required**, from a short catalogue so the queue can be scanned: Wrong layout, Content issue, Branding issue, Image quality, Template mismatch, Other. Free-text detail is optional (max 500 characters), except for "Other", which must say what is wrong.
- **Stored** in `PosterVersion.reviewNote` as `"Branding issue — the logo sits over the headline"`, and split back into reason and detail for display (`parseRejectionNote`). A note that does not match the catalogue is still shown, under "Rejected".
- **Nothing is deleted.** The version, its RAW and FINAL Drive files and every earlier version stay byte-identical, and the day keeps the rejected poster as its active one so it can be opened, compared and fixed.
- **An approved poster** goes APPROVED → PENDING → REJECTED in one transaction, because Phase 1 allows no direct move between them. The stored result is a single REJECTED version with the reason.
- **Rejecting never generates anything** and never spends credits.
- **The reason is visible** on the day's row in the queue, in the day detail, and against that version in its history — so a regenerated poster can be checked against what was wrong.

## 4. Fixing a rejected poster

Two routes, both of which leave the rejected version untouched:

- **Edit in Poster Studio** — opens the day in the studio on the active poster's RAW artwork (Phase 4's flow). **Save to Day N** creates a `POSTER_STUDIO` version with the previous active version as its parent, activates it, and it arrives PENDING for review.
- **Regenerate** — a new `PIPELINE` version through Phase 4's pipeline. It warns "This will create a new poster version and use an AI generation." and needs a second click, so no credit is spent by accident.

In both cases the new version becomes active and pending; the rejected one stays in history with its reason. Nothing regenerates automatically after a rejection.

## 5. Outdated posters

- A content or effective-template change bumps `contentRevision`, and the poster becomes **Outdated** (Phase 4). Phase 5 refuses to approve it — an outdated poster can never be approved into delivery readiness.
- It can still be **rejected** (to record what was wrong where it was noticed), **regenerated** or **edited**.
- Approval is never carried over to a new version: each version is reviewed on its own.

## 6. The review queue

On the campaign calendar, as the first card:

- **Readiness panel** (§8) with the blockers.
- **Counts** — All, Needs review, Approved, Rejected, Outdated, Failed, Unmapped, Needs attention — each a button that filters the queue. Counts are labelled for screen readers as e.g. "Needs review (4)".
- **Rows** in day order: day number and date, state, content headline, mapped template and its source, the rejection reason where there is one, the last failure where there is one, a thumbnail through the protected studio image route, and Review.
- **Day detail** (shared with the Poster generation card): the day's content, its template, the poster image with Final poster / Raw artwork, every version with source, approval, content revision, active and current flags, and only the actions that are valid for that state.
- **No Drive ids** anywhere in the browser payload; images are served through `/api/poster-studio/[generationId]/image` behind the admin session.
- **Layout:** no horizontal overflow at 390 px, for the queue and the dialog.

## 7. Bulk approval

- Rows have checkboxes, with select-all over the **filtered** rows.
- The bar reads **"Selected: N · Can approve: X · Skipped: Y"** before anything is written, and the button says `Approve selected (X)`.
- **`planBulkApproval` never approves anything invalid.** Outdated, rejected, failed, generating, unmapped and ungenerated days are excluded and reported grouped by reason with their day numbers — never silently skipped.
- **Re-checked at the write.** Each day is approved through Phase 4's `approveCampaignDayPoster`, which re-reads the row, so a day that changed between planning and writing is reported as a conflict instead of being approved. The result names the days approved, the days skipped and why, and any conflicts.
- Approving an already-approved day is a no-op, so a repeated bulk run is safe.

## 8. Campaign readiness

`campaignReadiness` is deterministic and deliberately scoped:

- **Content** and **templates** are counted across the whole campaign (all days need both eventually).
- **Posters** and **approved** are counted across the **rolling window** only, because only the window is ever generated — the summary never implies 365 posters exist.
- **`deliveryReady`** runs Phase 1's own `evaluateDeliveryReadiness` on the real revisions: active, current, approved, in an ACTIVE campaign.
- **`windowReady`** is true only when the window has days and there is **no** blocker at all: not ACTIVE, needing review, rejected, outdated, failed, not generated, still generating, or unmapped.
- **`describeReadiness`** states it plainly — "Ready for the next 14 days: 14 of 14 posters approved. Delivery is not implemented yet." or "Not ready for the next 14 days — 2 poster(s) need review, 1 outdated." It never claims more than the window, and never claims anything will be sent.

**Needs attention** is the dashboard's single number: rejected, outdated, failed, needs-attention, or unmapped *inside the window*. An unmapped day outside the window is future work, not a problem now.

## 9. Dashboard deep links

The client page counts attention per campaign and links to the campaign calendar with `?review=<filter>` (e.g. `?review=outdated`), which opens the queue on that filter. The filter is read from `searchParams` and validated against `REVIEW_FILTERS`.

## 10. Tests

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` | only the pre-existing warnings in `src/lib/poster/layout-render.tsx` (untouched) |
| `npm run lint:colors` | only the 14 pre-existing findings in `poster-studio-workspace.tsx`; Phase 5 adds none |
| `check:campaign` / `-db` (Phase 1) | 55 / 89 |
| `check:calendar-scope` (legacy isolation) | 39 |
| `check:campaign-content` / `-db` (Phase 2) | 57 / 65 |
| `check:campaign-mapping` / `-db` (Phase 3) | 62 / 82 |
| `check:campaign-posters` / `-db` (Phase 4) | 55 / 80 |
| `check:templates`, `check:import`, `check:manual` | pass |
| **`check:campaign-review`** (new, pure) | **46** |
| **`check:campaign-review-db`** (new) | **63** |

**`check:campaign-review`** pins the rules without a database: every rejection reason, the note format and its round trip, "Other" requiring detail, the 500-character limit, each filter, `needsAttention` (including that an unmapped day outside the window is not attention), the summary, every approval refusal in every state and for a closed campaign, what may be rejected, the bulk plan's grouping and ordering, and readiness scope — campaign-wide content and templates, window-only posters and approvals, `windowReady` false for each blocker in turn.

**`check:campaign-review-db`** runs the real service and server actions against the dev DB, in one rolled-back transaction with nested transactions on real savepoints, table counts compared and 0 network attempts:

- the queue over a whole campaign, filters and counts, and the day detail with its versions;
- approve: the version becomes APPROVED with `reviewedAt`; approving a non-active, outdated or rejected version is refused; a closed campaign refuses everything;
- reject: the note is stored as reason + detail; the version, its files and history are unchanged; an approved poster goes through PENDING and lands REJECTED once; rejecting twice is refused;
- after rejection: a studio save and a regeneration each create a new active PENDING version with the rejected one intact and its reason still readable;
- outdated: a content change blocks approval and still allows reject and regenerate;
- bulk: only valid days are approved, the rest reported by reason; a day changed between plan and write is reported as a conflict; a repeated run approves nothing new;
- readiness: the numbers and blockers at each stage, and `deliveryReady` agreeing with Phase 1's own rule;
- isolation: legacy rows byte-identical, no delivery column written, no WhatsApp usage, no version deleted.

## 11. Browser check

Playwright, local only, in the git-excluded `.studio-checks/campaign-ui/review-ui-check.ts`: **38 / 38**.

**Setup:** a temporary git worktree dev server on port 3107 (the main checkout untouched), OpenAI chat and images pointed at a local mock on port 4012 (no spend), Evolution and fal disabled, storage in the private dev Drive with every file binned and every fixture row removed afterwards.

**Steps covered:**

1. A 10-day campaign with content, Auto-mapped templates and generated posters; the review queue lists all 10 days with correct states.
2. Readiness counters match the rows, and each count button filters the queue.
3. Day detail: content, mapped template, the poster loaded through the protected route, "Versions (1)".
4. Approve day 1 → Approved, and the count moves.
5. Reject day 2 with a reason → stored as "Branding issue — the logo sits over the headline"; the poster and the version are kept; the reason shows in the queue.
6. Edit after rejection → a POSTER_STUDIO v2, active and PENDING, with the rejected v1 unchanged.
7. Regenerate after rejection → a new active version, history kept, and the AI-cost warning shown first.
8. A content change → Outdated, with no Approve offered but Reject and Regenerate available.
9. Bulk: "Selected: 10 · Can approve: 2 · Skipped: 8", approving only the valid days and reporting the outdated and ungenerated ones.
10. Readiness after approvals still reads "Not ready", with the remaining blockers.
11. The client-page attention link navigates to `?review=outdated` and opens the queue on that filter.
12. No horizontal overflow at 390 px, for the queue and the dialog.
13. An unauthenticated review action returns 401.
14. No WhatsApp usage and no delivery column written; 0 console errors; fixtures and 12 Drive files cleaned up.

## 12. Known limitations

- **No delivery.** Approval makes a day delivery-ready and nothing else. Nothing is scheduled or sent; that is Phase 6.
- **No approver identity.** `reviewedAt` and `reviewNote` are recorded, but not who reviewed — there is no per-user column yet, and any admin session can review.
- **No audit trail of reviews.** Only the current approval state per version is stored, so an approve → reject → approve sequence keeps the last state and note, not the sequence.
- **Rejection reasons are a fixed catalogue** in code, not configurable per client, and the free-text detail is not shown to the model when regenerating — a regeneration does not automatically "fix" what the note describes.
- **Bulk approval is sequential**, one day per write, and there is no bulk reject: a reason belongs to a specific poster.
- **The queue is not paginated.** A 365-day campaign renders every day; it is grouped and filterable, but long.
- **Readiness is a snapshot** computed on page load. It does not refresh on its own while a batch runs elsewhere.
- **"Needs attention" counts unmapped days only inside the window**, so a campaign can be "ready for the next 14 days" while later days still have no template — which is the intended claim, but it is narrower than "the campaign is ready".
