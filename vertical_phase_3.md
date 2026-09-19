---
title: vertical phase 3
---

We are starting PHASE 3 of the Campaign Automation system.

IMPORTANT:
- Work only on `feature/ai-poster-studio`.
- Do NOT touch or merge `main`.
- Do NOT deploy production.
- Phase 2 is already committed and pushed.
- Do NOT start Phase 4 (poster generation).
- Do NOT generate any posters/images in this phase.
- Preserve all existing Phase 1 + Phase 2 behavior.
- Do not rewrite existing architecture unnecessarily.
- Before changing anything, audit the existing template/category-template system and the Campaign/ContentCalendar models.

==================================================
PHASE 3 — CAMPAIGN TEMPLATE MAPPING
==================================================

GOAL

Allow an admin to decide which approved template should be used for each campaign day.

Support:

1. AUTO MAP
2. MANUAL MAP
3. MIXED MODE
4. BULK MANUAL MAPPING
5. UNMAPPED-DAY DETECTION
6. TEMPLATE DEACTIVATION CONFLICT HANDLING

Template mapping must remain completely separate from poster generation.

The output of Phase 3 is:

Campaign Day
    ↓
selected/suggested template
    ↓
Phase 4 will later generate the poster

Do NOT generate the poster here.

==================================================
1. AUDIT EXISTING TEMPLATE SYSTEM FIRST
==================================================

Inspect:

- CategoryTemplate
- existing template CRUD
- template approval/active states
- vertical/category relationship
- aspect ratio handling
- content type handling
- existing template preview/UI
- existing calendar/template assignment logic

Understand the current architecture before modifying it.

Reuse existing template infrastructure wherever possible.

Do not create a second template system.

Document any important architectural findings in the phase report.

==================================================
2. AUTO MAP
==================================================

Implement deterministic Auto Map.

When admin chooses:

"Auto Map Templates"

the system should map campaign days to compatible templates.

Ranking should consider:

1. Template is active
2. Template is approved
3. Content type compatibility
4. Aspect ratio compatibility
5. Vertical/category compatibility
6. Variety / avoid unnecessary consecutive repetition
7. Existing manual mappings must NOT be overwritten

The mapping must be deterministic.

Do NOT use random selection.

Running Auto Map twice with identical inputs should produce the same result.

If there are insufficient compatible templates:

- leave the day unmapped
- clearly show why it is unmapped
- do not silently assign an incompatible template

==================================================
3. AUTO MAP PREVIEW
==================================================

Before applying Auto Map, provide a preview.

Show something similar to:

Day 1 → Template T3
Day 2 → Template T7
Day 3 → Template T2
...

Clearly distinguish:

- new mappings
- existing manual mappings
- unmapped days
- conflicts

Admin should be able to:

Apply Auto Map
Cancel

Auto Map must not unexpectedly overwrite manual mappings.

==================================================
4. MANUAL "MATCH THE FOLLOWING"
==================================================

Build a clear manual mapping interface.

Concept:

LEFT:
Campaign days

RIGHT:
Available templates

Example:

Day 1       → Template 3
Day 2       → Template 7
Day 3       → Template 2

Support desktop drag-and-drop.

The interface should make it immediately obvious:

- which template is assigned
- which days are unmapped
- which templates are available
- which templates are inactive/unapproved
- which days have manually overridden auto mappings

Use the existing design language of the application.

Do not create an unrelated UI style.

==================================================
5. BULK MANUAL MAPPING
==================================================

Admin must be able to select multiple campaign days.

Support:

Template → selected days

Example:

Select:
Day 2
Day 5
Day 8
Day 11

Choose:
Template T4

Apply.

Also support:

Date/day range

Example:

Day 1–30 → Template T2

And repeat pattern where practical:

T1 → Day 1
T2 → Day 2
T3 → Day 3
repeat...

Do not make this unnecessarily complex if the existing UI architecture doesn't support it cleanly.

The core requirement is efficient bulk assignment.

==================================================
6. MIXED MODE
==================================================

Support this workflow:

1. Auto Map all days
2. Admin manually changes important days
3. Admin runs Auto Map again

Manual overrides MUST remain untouched.

Auto Map should only fill/change days that are still eligible for automatic mapping.

Clearly mark:

AUTO
MANUAL

for each mapping.

==================================================
7. TEMPLATE DEACTIVATION
==================================================

Handle this carefully.

If a template is currently assigned to campaign days and later becomes inactive/unapproved:

DO NOT silently replace it.

Show:

"Template inactive — action required"

Identify affected campaign days.

Admin should be able to choose a replacement.

Auto Map may suggest a replacement, but must not silently change an existing manual assignment.

==================================================
8. ASPECT RATIO COMPATIBILITY
==================================================

Respect campaign/poster aspect ratio.

A template that cannot support the campaign day's aspect ratio must not be automatically assigned.

If no compatible template exists:

Day remains unmapped.

Show a useful explanation.

==================================================
9. CONTENT TYPE COMPATIBILITY
==================================================

Use the Phase 2 content type generated for each campaign day.

Examples:

EDUCATIONAL
PROMOTIONAL
TESTIMONIAL
ENGAGEMENT
SEASONAL
etc.

Use the existing CategoryTemplate `contentTypes` structure where appropriate.

Do not hardcode one specific vertical.

The system must work for future verticals.

==================================================
10. MAPPING AUDIT / HISTORY
==================================================

Record enough information to know:

- template selected
- whether it was AUTO or MANUAL
- when mapping happened
- who performed the manual change if existing auth/user context supports it

Do not over-engineer a new audit system if an existing audit mechanism can be reused.

Do not store unnecessary duplicated campaign data.

==================================================
11. UI REQUIREMENTS
==================================================

Campaign calendar should clearly show:

Template:
T3

Mapping:
AUTO

or:

Template:
T7

Mapping:
MANUAL

Also show:

Unmapped: 4 days

Needs Attention:
- Day 17 — no compatible template
- Day 23 — assigned template inactive

Provide obvious actions:

Auto Map
Manual Map
Review Unmapped

Keep the UI responsive.

Mobile is important.

For mobile/touch devices, do NOT rely only on drag-and-drop.

Provide a touch-friendly fallback:

1. Select template
2. Select days
3. Apply

==================================================
12. DATA SAFETY
==================================================

This is critical.

Do not:

- delete existing campaign days
- delete poster versions
- delete Drive files
- modify production data
- modify `main`
- regenerate posters
- call OpenAI
- send WhatsApp messages
- change legacy calendar behavior

Existing Phase 1 + Phase 2 campaign isolation must remain intact.

Legacy calendar actions must continue excluding campaign-backed rows.

==================================================
13. TESTING
==================================================

Add focused tests for:

- deterministic auto mapping
- content type compatibility
- aspect ratio compatibility
- inactive template exclusion
- unapproved template exclusion
- insufficient compatible templates
- no compatible template → unmapped
- manual mapping
- bulk mapping
- auto + manual mixed mode
- auto map does not overwrite manual mappings
- inactive assigned template detection
- replacement workflow
- duplicate mappings where applicable
- campaign/client consistency
- legacy calendar isolation regression

Add DB tests where necessary.

Run existing campaign tests too.

Expected existing suites must remain green.

At minimum run:

- typecheck
- lint
- Phase 1 campaign tests
- Phase 2 campaign content tests
- calendar isolation tests
- new Phase 3 tests

==================================================
14. UI TESTING
==================================================

Use the existing Playwright/UI test setup.

Test:

- create/open campaign
- view calendar
- auto map preview
- apply auto map
- manual mapping
- bulk mapping
- change auto mapping manually
- rerun auto map
- verify manual mapping survives
- inactive template warning
- unmapped days
- mobile layout
- no horizontal overflow
- no browser console errors

Do not use real OpenAI calls.

Do not generate real posters.

==================================================
15. DOCUMENTATION
==================================================

Create/update:

`vertical-phase3.md`

Include:

- architecture decisions
- mapping rules
- auto-map algorithm
- manual mapping behavior
- mixed-mode behavior
- inactive-template behavior
- tests performed
- known limitations

Keep it concise and accurate.

==================================================
16. GIT SAFETY
==================================================

Before starting:

git branch --show-current
git status

Confirm:

feature/ai-poster-studio

Do not commit unrelated files.

Do not modify `.env` secrets.

Do not modify production configuration.

After implementation:

1. Run all relevant tests.
2. Inspect git diff.
3. Check for accidental unrelated changes.
4. Verify no OpenAI calls were made.
5. Verify no production deployment occurred.

Then commit ONLY Phase 3 changes:

feat: add campaign template mapping

Push:

origin/feature/ai-poster-studio

==================================================
STOP CONDITION
==================================================

After pushing Phase 3:

STOP.

Do NOT start Phase 4.

Report:

- commit hash
- files changed
- database changes/migration
- Auto Map behavior
- Manual Map behavior
- Mixed mode behavior
- inactive template handling
- tests and results
- UI test results
- any known limitations

Do not make additional improvements after the commit unless explicitly requested.