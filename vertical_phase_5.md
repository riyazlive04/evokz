---
title: vertical phase 5
---

We are starting PHASE 5.

Current accepted checkpoint:

Phase 4 commit:
abd51d0

Branch:
feature/ai-poster-studio

Remote:
origin/feature/ai-poster-studio

Phase 1, 2, 3 and 4 are complete and tested.

IMPORTANT:
- Do NOT touch main.
- Do NOT merge.
- Do NOT deploy production.
- Do NOT send WhatsApp messages.
- Do NOT start Phase 6.
- Preserve all existing Phase 1–4 behavior.
- Work only on the development branch.
- Reuse existing architecture.
- Do not rewrite Poster Studio unnecessarily.

==================================================
PHASE 5 — CAMPAIGN REVIEW & APPROVAL OPERATIONS
==================================================

GOAL

Turn generated campaign posters into a clear operational workflow where an admin can review campaign content + poster together and explicitly:

- Approve
- Reject / Send back for changes
- Regenerate when needed
- Edit in Poster Studio
- Track what still needs attention

Nothing should be considered ready for future delivery unless it satisfies the campaign approval policy.

==================================================
1. AUDIT EXISTING APPROVAL SYSTEM FIRST
==================================================

Before implementing anything, inspect:

- Campaign approval policy from Phase 1
- PosterVersion approval state
- existing Poster Studio approval actions
- campaign calendar states
- existing admin authorization
- existing content review state
- existing "Needs review" logic
- outdated poster handling
- existing dashboard/status components

Reuse these systems.

Do not create a second approval architecture.

==================================================
2. APPROVAL STATES
==================================================

Establish a clear operational state for campaign posters.

At minimum support:

- NOT GENERATED
- GENERATING
- FAILED
- NEEDS REVIEW
- APPROVED
- REJECTED
- OUTDATED
- NEEDS ATTENTION

If existing models already represent some of these states, reuse them instead of duplicating state fields.

Important:

An OUTDATED poster must never be treated as approved for delivery.

A rejected poster must not be treated as approved.

==================================================
3. APPROVE
==================================================

Admin can approve the current active PosterVersion.

Approval must apply ONLY to the current active version.

If an older PosterVersion is opened:

do not allow it to become the active approved version accidentally.

If the active version changes:

the new version must have its own approval state.

Never copy approval from an old version automatically unless the existing architecture explicitly requires it.

==================================================
4. REJECT / SEND BACK
==================================================

Add a Reject action.

Reject should mean:

"This poster is not ready for delivery."

Require a short reason.

Examples:

- Wrong layout
- Content issue
- Branding issue
- Image quality
- Template mismatch
- Other

The reason should be stored with the rejection if the existing data model supports it.

Do not delete the poster.

Do not delete previous versions.

Do not delete Drive files merely because a poster was rejected.

Rejected posters must remain available for editing/regeneration.

==================================================
5. EDIT AFTER REJECTION
==================================================

Rejected poster should provide:

Edit in Poster Studio

When saved:

create a NEW PosterVersion.

Never mutate the rejected version.

The new version becomes the active version.

The new version must require approval again.

Do not automatically approve it merely because the previous version was approved/rejected.

==================================================
6. REGENERATE AFTER REJECTION
==================================================

Provide:

Regenerate

with explicit confirmation.

Show:

"This will create a new poster version and use an AI generation."

Do not silently spend OpenAI credits.

The previous version remains in history.

New version becomes active.

New version requires approval according to campaign policy.

==================================================
7. OUTDATED HANDLING
==================================================

If content changes:

poster becomes OUTDATED.

If template mapping changes:

poster becomes OUTDATED.

If Brand Canvas changes in a way that affects the poster:

follow the existing Poster Studio architecture and mark affected campaign posters appropriately.

OUTDATED posters:

- cannot be approved
- cannot be considered delivery-ready
- must offer Regenerate / Edit

Do not automatically regenerate.

==================================================
8. CAMPAIGN REVIEW QUEUE
==================================================

Create a useful campaign-level review view.

Example:

CAMPAIGN REVIEW

Needs Review       8
Rejected           2
Outdated           3
Failed             1
Approved          16
Unmapped           0

Provide filters:

All
Needs Review
Rejected
Outdated
Failed
Approved

Each item should show enough information to act quickly:

- Day/date
- content headline
- content type
- mapped template
- poster preview
- approval state
- version
- relevant warning

==================================================
9. DAY DETAIL
==================================================

Campaign Day detail should combine:

CONTENT

Headline
Supporting text
CTA
Content type

TEMPLATE

Template
AUTO / MANUAL

POSTER

Preview
Version
Generation status
Approval status

ACTIONS

Edit
Regenerate
Approve
Reject

Only show actions that are valid for the current state.

==================================================
10. BULK APPROVAL
==================================================

Support safe bulk approval where appropriate.

Example:

Select 5 posters
→ Approve selected

BUT:

Never bulk approve posters that are:

- outdated
- rejected
- failed
- generating
- missing
- unmapped

Those should be excluded and clearly reported.

Show:

Selected: 10
Can approve: 7
Skipped: 3

Do not silently approve invalid items.

==================================================
11. APPROVAL POLICY
==================================================

Respect the campaign's configured approval policy from Phase 1.

If policy requires manual approval:

generated posters remain Needs Review.

If policy allows automatic approval:

follow that existing policy.

Do not introduce a new approval policy.

Do not change existing campaign policy semantics.

==================================================
12. DASHBOARD "NEEDS ATTENTION"
==================================================

Campaign dashboard should make unresolved work obvious.

Example:

NEEDS ATTENTION

3 posters need review
2 rejected
1 outdated
1 failed
2 days unmapped

Clicking each count should take the admin directly to the relevant filtered view.

Do not make the admin manually search through 365 days.

==================================================
13. CAMPAIGN READINESS
==================================================

Add a deterministic campaign readiness summary.

Example:

Campaign readiness:

Content       365 / 365
Templates     365 / 365
Posters        14 / 14
Approved      11 / 14
Attention      3

Do NOT label a campaign "Ready for delivery" if any required future delivery item is unresolved according to the configured policy.

Do not implement delivery itself.

This is only readiness information.

==================================================
14. NO WHATSAPP
==================================================

This phase must NOT:

- send WhatsApp
- call Evolution API
- schedule WhatsApp
- create delivery jobs
- send messages

Phase 6 will handle delivery.

==================================================
15. VERSION SAFETY
==================================================

Test carefully:

Version 1 → rejected
Version 2 → active
Version 3 → active

Only Version 3 can be approved for delivery.

Older versions remain immutable history.

Exactly one active version per day.

Do not allow an old version to accidentally become active through review actions.

==================================================
16. DATA SAFETY
==================================================

Never:

- delete campaign days
- delete poster versions during normal rejection
- delete production data
- modify main
- deploy
- modify legacy non-campaign calendar behavior
- expose credentials
- expose Drive IDs unnecessarily

Use additive migrations only if genuinely necessary.

Before migration:

- verify DATABASE_URL
- backup dev DB
- confirm dev DB only

Never use:

prisma migrate reset
prisma db push

==================================================
17. TESTING
==================================================

Add focused tests for:

- approve active version
- reject active version
- rejection reason
- cannot approve outdated poster
- cannot approve rejected poster
- cannot approve failed poster
- cannot approve generating poster
- edit rejected poster creates new version
- regenerate rejected poster creates new version
- old versions remain immutable
- exactly one active version
- approval state belongs to correct version
- outdated handling
- bulk approval filtering
- campaign readiness
- approval policy
- authorization
- no WhatsApp calls
- no credential leakage

Run all previous suites:

Phase 1
Phase 2
Phase 3
Phase 4
Legacy calendar isolation
Poster Studio tests

Everything must remain green.

==================================================
18. BROWSER TEST
==================================================

Use isolated local testing.

No production APIs.

Test:

1. Open campaign
2. View review queue
3. Open generated poster
4. Approve
5. Reject another poster
6. Verify rejection reason
7. Edit rejected poster
8. Verify new version
9. Verify old version remains
10. Verify new version requires approval
11. Regenerate another poster
12. Verify old version remains
13. Test outdated poster
14. Verify outdated cannot be approved
15. Test bulk approval
16. Verify invalid posters are skipped
17. Check readiness counters
18. Test mobile layout
19. Test 390px width
20. Verify no console errors

Mock AI where required.

No real WhatsApp calls.

==================================================
19. DOCUMENTATION
==================================================

Create:

vertical-phase5.md

Document:

- approval states
- review workflow
- reject behavior
- versioning behavior
- bulk approval
- readiness rules
- known limitations
- tests performed

==================================================
20. GIT CHECKPOINT
==================================================

Before work:

git branch --show-current
git status

Confirm:

feature/ai-poster-studio

After implementation:

- run all tests
- inspect git diff
- check unrelated files
- verify no secrets changed
- verify no production configuration changed
- verify no WhatsApp calls
- verify no deployment

Commit ONLY Phase 5:

feat: add campaign review and approval workflow

Push:

origin/feature/ai-poster-studio

==================================================
STOP
==================================================

After pushing:

STOP.

Do NOT start Phase 6.

Report:

- commit hash
- files changed
- migrations
- approval states
- reject workflow
- version behavior
- bulk approval
- readiness calculation
- tests
- browser test
- known limitations

Do not make additional improvements after the commit unless explicitly requested.