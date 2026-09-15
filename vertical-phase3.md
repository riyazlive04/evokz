# Campaign automation — Phase 3: campaign template mapping

**Status:** template mapping only. Each campaign day gets a selected (MANUAL) or suggested (AUTO) template. Poster generation starts in Phase 4.
**Not done here:** no poster or image is generated, no OpenAI / fal.ai / Drive / WhatsApp call is made, and no poster version is created or deleted. Legacy calendar behaviour is unchanged.

```
Campaign day → selected / suggested template → (Phase 4) poster
```

## 1. Audit findings

| Area | Found |
| --- | --- |
| Template model | `CategoryTemplate`, one library per vertical (`categoryId`), unique label per vertical. CRUD lives in `src/app/admin/dashboard/actions.ts` and the vertical page (`VerticalTemplatePanel`). |
| Approval | `layoutApprovedAt` is the gate the renderer enforces: `resolveDayLayout` refuses a pinned template without it, even when its plate is approved. `plateApprovedAt` only decides whether an approved grid template also composites a plate. Re-reading or editing a spec clears `layoutApprovedAt`. |
| Active state | `isActive` and `contentTypes` were added in Phase 1 but nothing in the UI or actions ever set them. |
| Aspect ratio | The template's shape wins; the client's output preset (`Client.imageSizePreset`) only sets resolution (`resolvePosterCanvas`). The drawn shape is resolved in this order: authored HTML template manifest → approved plate spec → layout spec `aspect`. `0` means unmeasured, and the poster takes the preset's shape. Campaigns have no aspect field. |
| Mapping storage | Already in Phase 1: `ContentCalendar.posterTemplateId` is the operator's selection and `suggestedTemplateId` the mapper's. `effectiveTemplateId`: the selection wins; the suggestion counts only under `Campaign.templateMappingMode = AUTO`. Changing the effective template bumps `contentRevision`. |
| Content type | Phase 2 stores a pillar key in `ContentCalendar.contentType`. Empty days follow the deterministic `planContentTypes`. |
| Legacy rotation | `loadCategoryLayouts` / `pickForDay` rotate over approved templates for legacy days. Untouched, and it still ignores `isActive` (Phase 1 §17.11 item 6). |
| Deletion | Deleting a template SetNulls every day mapped to it, silently losing mappings. |
| Audit / users | No audit table exists. Auth is a single shared operator credential, so there is no user identity to record. |

## 2. Architecture decisions

1. **No second template system.** Mapping reuses `CategoryTemplate` and the two Phase 1 columns. **Auto Map writes only `suggestedTemplateId`; manual mapping writes only `posterTemplateId`.** An auto run therefore cannot overwrite a manual choice by construction.
2. **Target aspect = the client's resolved output preset** (`imageSizePreset`, then `FAL_IMAGE_SIZE`, then WhatsApp Status). Nothing is copied onto the campaign.
3. **Approved = `layoutApprovedAt` set and the spec readable by this build.** This is exactly what rendering a pinned template accepts. The unused Phase 1 helper `isTemplateLayoutApproved` was corrected to the same gate.
4. **Audit = two nullable timestamps on the day:** `templateSelectedAt` (MANUAL) and `templateSuggestedAt` (AUTO). The source is derived from which column holds the effective template, so no campaign data is duplicated. "Who" is not recorded (one shared login).
5. **Pure rules + DB service**, the same split as Phases 1–2:
   - `src/lib/campaign/template-mapping.ts` — compatibility, the planner, issues, bulk expansion, summary.
   - `src/lib/campaign/template-mapping-service.ts` — load, preview/apply, manual assignment, mode switch, template status and content types.

### Migration `20260915230000_campaign_template_mapping`

Additive only: `ContentCalendar.templateSelectedAt` and `templateSuggestedAt` (nullable `TIMESTAMP(3)`). No backfill; no existing column, index or constraint changes. Applied to the dev DB (`localhost:5434/evokz_ai_dev`) with `prisma migrate deploy`, after a `pg_dump` backup.

## 3. Mapping rules

A template is **compatible** with a day when all of these hold (hard rules):

- It is in the campaign's vertical.
- It is active.
- It is approved.
- Its shape matches the target within 2%, or it is unmeasured.
- Its `contentTypes` is empty (suits any) or includes the day's content type (stored, else planned).

A template that fails any rule is never auto-assigned.

**Manual assignment** refuses wrong-vertical, inactive and unapproved templates, and writes nothing in that case. A different shape or content type is allowed and reported as a warning: a person choosing it is a decision.

## 4. Auto Map algorithm (`planAutoMap`)

Deterministic, with no randomness. Identical inputs give an identical plan, and a rerun right after applying makes zero changes.

1. **Manual days** are fixed and never written.
2. **AUTO days whose suggestion is still compatible** are kept (`fill` scope). The optional **re-balance** scope re-picks them too.
3. **Every other day**, in day order, gets the best compatible template, ranked by:
   1. Not the previous day's (or next fixed day's) template.
   2. Tagged for the day's type before untagged.
   3. Measured matching shape before unmeasured.
   4. Fewest days already using it.
   5. Least recently used.
   6. Upload order.
4. **No compatible template** → the day stays unmapped. An invalid AUTO suggestion is cleared rather than kept, and the plan carries the narrowest reason:
   - the vertical has no templates;
   - none is active and approved;
   - no template draws the target shape (lists the shapes available);
   - no template suits the content type.
5. If the only compatible template repeats the previous day, it is still assigned and flagged "same as the previous day".

**Preview → apply.** The preview writes nothing. It shows `Day N: current → new` with a badge (New / Replaced / Kept / Manual · untouched / Unmapped), conflicts, unmapped reasons, and filters. Apply recomputes the plan inside a transaction and requires the preview's fingerprint to match, so a change made meanwhile is refused as `conflict` and nothing is written. Every row update also restates the template columns it read.

On a **MANUAL-mode** campaign the preview says that applying switches the campaign to AUTO, because suggestions only count under AUTO. There is also an explicit mode switch; switching bumps the revision of days whose effective template changes.

## 5. Manual mapping ("match the following")

The calendar page's **Template mapping** card has three actions:

- **Auto Map** — opens the preview (§4).
- **Manual Map** — opens the board.
- **Review Unmapped** — opens the board filtered to the days needing attention.

**Board layout.**
- Days on the left, filterable: all, unmapped, needs attention, manual, auto. Each row shows the template, an Auto/Manual badge, whether it overrides an auto mapping, and any issue.
- Templates on the right, with thumbnail, shape and content types. Inactive and unapproved templates appear disabled with a badge; "Different shape" is badged.

**Assigning templates.**
- **Desktop:** drag a template onto a day. Dropping onto a selected day maps the whole selection.
- **Touch and everywhere:**
  1. Select a template.
  2. Tick days, "Select shown", or a From/To range.
  3. Press Apply in the sticky bar.
- **Bulk:** the selected days (e.g. 2, 5, 8, 11 → T4) or a range (days 1–30 → T2) take one template. **Repeat pattern** cycles templates tapped in order across a range (T1 → 1, T2 → 2, T3 → 3, repeat).
- **Clear manual template** returns a day to its AUTO mapping.
- **Keep days that already have a manual template** skips those days.
- One template per day holds by construction. A day listed twice in one request is refused.

Every mapped day on the content calendar also shows `Template: X` with an **Auto** or **Manual** badge and any action-required issue.

## 6. Mixed mode

Auto Map all days → change important days manually → run Auto Map again.

- The rerun reports manual days as "Manual · untouched" and never writes them, in either scope. Valid AUTO days are kept.
- A manual choice over a different suggestion keeps the suggestion beneath it and is shown as "overrides auto". Clearing the manual choice restores that suggestion.

## 7. Inactive / unapproved templates

- **Deactivating a template** (vertical page → template card → *Campaign use*):
  - Changes only the template row. Mapped days keep it.
  - Asks for confirmation when campaign days use it, stating how many.
- **Detection.** Those days show **"Template inactive — action required"** ("Template not approved — action required" when approval is withdrawn). They appear in **Needs attention**, grouped per template with the affected days.
- **Replacement:**
  - Choose a replacement in the group and press *Replace on N days*. This is a manual choice.
  - Or run Auto Map. Its preview lists AUTO days on the inactive template as **Replaced** with the reason, and manual days as untouched conflicts with a suggested replacement that is shown but never applied.
- **Deleting a template** that open-campaign days still reference is now refused, with advice to deactivate it instead. Legacy templates are unaffected.
- The template card also tags content types from the vertical's strategy pillars, and shows how many campaign days use the template.

## 8. Data safety

- Writes touch only campaign days (`campaignId` set) of the campaign named, and only `posterTemplateId`, `suggestedTemplateId`, the two timestamps, `contentRevision` and `Campaign.templateMappingMode`. Plus `CategoryTemplate.isActive` / `contentTypes` from the vertical page.
- Never touched:
  - poster versions or the active pointer (a mapping change only makes an existing poster outdated through the revision);
  - Drive;
  - legacy rows;
  - `LEGACY_CALENDAR` scoping.
- COMPLETED / CANCELLED campaigns are read-only.

## 9. Tests

| Suite | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm run lint` (changed dirs) | no warnings or errors |
| `npm run lint:colors` | only the pre-existing `poster-studio-workspace.tsx` findings; no new file |
| `check:campaign` (Phase 1) | 55 / 55 |
| `check:campaign-db` (Phase 1) | 89 / 89 |
| `check:calendar-scope` (legacy isolation) | 39 / 39 |
| `check:campaign-content` (Phase 2) | 57 / 57 |
| `check:campaign-content-db` (Phase 2) | 65 / 65 |
| `check:templates`, `check:import`, `check:manual` | pass |
| **`check:campaign-mapping`** (new, pure) | **62 / 62** |
| **`check:campaign-mapping-db`** (new, rolled-back transaction, real actions) | **82 / 82**; table counts unchanged, 0 network attempts |

The new suites cover:
- deterministic auto mapping and idempotent rerun;
- content-type and aspect compatibility (including a 1:1 client);
- inactive, unapproved and foreign exclusion;
- insufficient templates (repeat flagged), and no compatible template → unmapped with a reason;
- manual, bulk (selection / range / pattern / skip manual) and clear;
- mixed mode in both scopes, and a stale-preview race refused;
- inactive assigned-template detection and the replacement workflow;
- withdrawn approval, and the delete guard;
- duplicate day refusal and same-template no-op;
- MANUAL-mode switch;
- poster versions untouched but outdated;
- a cancelled campaign refused;
- campaign/client consistency;
- legacy rows byte-identical, with legacy bulk approval still ignoring campaign days.

**UI check** (Playwright; local only, in the git-excluded `.studio-checks/campaign-ui/mapping-ui-check.ts`): **31 / 31**.
- **Setup:** a temporary git worktree dev server on port 3107, so the main checkout was untouched. OpenAI, fal and Evolution were pointed at a closed local port. Template thumbnails were stubbed, so nothing reached Drive.
- **Flows verified:**
  - create a campaign in the UI, then view the calendar ("Unmapped: 20 days");
  - Auto Map preview (writes nothing), cancel, then apply (20 AUTO; the promo template only on promo days; no square or draft template);
  - manually change an auto mapping (day 3 badged Manual) and desktop drag-and-drop onto day 6;
  - bulk range 10–14 (with content-type warnings) and a repeat pattern over days 15–18;
  - rerun Auto Map with re-balance: all 11 manual days survive;
  - deactivate a template on the vertical page → "Template inactive — action required" → *Replace on N days*;
  - tag content types on the vertical page → rerun → 7 unmapped days with reasons → Review Unmapped;
  - a 390 px phone: no horizontal overflow (calendar and board), and the touch flow of select template → select days → apply.
- **Browser:** 0 console errors and 0 page errors. Fixtures were removed.
- **Fixed along the way:**
  - Status chips were `div`s inside `<p>`, which is invalid nesting. They are now spans.
  - A `style` hydration warning was traced to Playwright's default screenshot caret-hiding, not to app markup.

## 10. Known limitations

- **No per-change history.** Only the latest mapping time per source is kept. "Who" is not recorded (one shared login).
- **Aspect of authored HTML templates** is read by matching the template label to a manifest, as the pipeline does. A renamed template loses that match and falls back to its plate or spec aspect.
- **`suggestedTemplateType`** (Phase 2 layout hint) is not used for ranking. Templates carry no layout-genre metadata to match it against.
- **Days with no content** are matched on their *planned* content type. If content is later written with a different type, an AUTO mapping that no longer fits is flagged and replaced on the next Auto Map run.
- **Changing a client's output preset** does not remap anything. AUTO days of the wrong shape are flagged "Different shape — action required" until Auto Map runs; manual ones get a warning.
- **The legacy rotation still ignores `isActive`** (unchanged by design).
- **Large campaigns** render the board's day list in full (up to 730 rows); there is no virtualisation.
