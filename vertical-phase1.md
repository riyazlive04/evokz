---
title: vertical-phase1
---

phase1

# EVOKZ — PHASE 1
# Campaign Architecture & Data Foundation

We are starting Phase 1 of the 365-Day Campaign Automation system.

IMPORTANT:
This phase is ONLY for architecture, database design, migrations, domain logic foundation, and tests.

DO NOT implement:
- AI content calendar generation
- Template mapping UI
- Drag-and-drop UI
- Poster generation queue
- Poster Studio integration
- WhatsApp automation
- Approval UI
- Campaign dashboard

Those will be implemented in later phases.

==================================================
SAFETY RULES
==================================================

- Work ONLY on `feature/ai-poster-studio`.
- NEVER touch `main`.
- NEVER deploy.
- NEVER use production DATABASE_URL.
- NEVER run `prisma migrate reset`.
- NEVER run `prisma db push`.
- Use only the dedicated development database.
- Before doing anything:

  git branch --show-current
  git status

- Confirm the branch is:
  feature/ai-poster-studio

- Read:
  - AI_POSTER_HANDOFF.md
  - prisma/schema.prisma
  - existing Prisma migrations
  - existing campaign/plan/calendar/template models
  - existing poster generation/queue code
  - existing Poster Studio architecture

IMPORTANT:
Do not create duplicate concepts if the application already has an equivalent model.

Reuse existing:
- Client
- Vertical
- Template
- Plan
- Calendar
- Poster
- Brand Canvas
- UsageEvent
- existing generation/queue concepts

where appropriate.

==================================================
GOAL
==================================================

Create a clean foundation for this future workflow:

CLIENT
  ↓
CAMPAIGN
  ↓
CAMPAIGN DAYS
  ↓
CONTENT
  ↓
TEMPLATE MAPPING
  ↓
POSTER VERSIONS
  ↓
APPROVAL
  ↓
DELIVERY QUEUE
  ↓
WHATSAPP

The key architectural principle:

A 365-day plan is NOT 365 locked posters.

It is:

365 independently editable scheduled content slots.

Every day must be independently changeable without affecting other days.

==================================================
1. AUDIT EXISTING ARCHITECTURE
==================================================

Before writing code, inspect the existing database and application.

Find:

- how plans are represented
- how clients are linked to plans
- how verticals are represented
- how templates are represented
- how calendar/delivery days currently work
- how posters are currently stored
- how generation status is represented
- how approval status is represented
- how scheduled delivery works
- how Evolution API delivery is represented
- how Poster Studio generations are represented

Create a short architecture note before implementation explaining:

1. Existing models that can be reused.
2. Existing models that need extension.
3. New models that are genuinely required.
4. Relationships between them.

Do NOT create a new model if an existing model already provides the same responsibility.

==================================================
2. CAMPAIGN MODEL
==================================================

Create or extend the campaign concept.

A Campaign should represent:

- one client
- one plan/program
- one vertical
- campaign start date
- campaign end date or duration
- campaign status
- delivery configuration
- template mapping mode
- approval policy
- generation configuration

Suggested conceptual states:

DRAFT
ACTIVE
PAUSED
COMPLETED
CANCELLED

Use enums if consistent with the existing project architecture.

Do not duplicate Client Brand Canvas data inside Campaign.

Campaign references the Client and reads current Brand Canvas when posters are generated.

==================================================
3. CAMPAIGN DAY MODEL
==================================================

Create a CampaignDay concept.

Each campaign day represents ONE scheduled content/poster slot.

It should support:

- campaign reference
- scheduled date
- sequence/day number
- content topic
- content type
- headline
- supporting text
- CTA
- caption
- hashtags
- image/visual prompt
- suggested template
- selected template
- generation status
- approval status
- delivery status
- active poster/version reference

IMPORTANT:

Do not store generated image base64 in the database.

Do not duplicate full Brand Canvas information.

Do not duplicate template image files.

CampaignDay should be independently editable.

Changing Day 127 must NOT modify Day 126 or Day 128.

==================================================
4. CONTENT VS POSTER SEPARATION
==================================================

The architecture must clearly separate:

CONTENT

from

POSTER

A CampaignDay should be able to exist before a poster exists.

Example:

Day 127
  ↓
Content exists
  ↓
Template assigned
  ↓
Poster not generated yet

This is intentional.

Poster generation is a later asynchronous operation.

==================================================
5. TEMPLATE MAPPING FOUNDATION
==================================================

The architecture must support two future mapping modes:

AUTO
MANUAL

Store the campaign's mapping mode.

Manual mapping must eventually support:

Template A → Day 2
Template B → Day 5
Template C → Day 17

The same template may be assigned to multiple days.

A day should have at most one active selected template at a time.

Do NOT implement the drag-and-drop UI in this phase.

Only create the correct database/domain foundation.

Also support future template metadata such as:

- content type/category
- supported aspect ratios
- active/inactive
- approval status

Reuse existing template fields where possible.

==================================================
6. POSTER VERSION FOUNDATION
==================================================

The system must support multiple poster versions for one CampaignDay.

Example:

Day 127
  ↓
Version 1 — Automatically generated
  ↓
Version 2 — Edited in Poster Studio
  ↓
Version 3 — Edited again

One version must be marked ACTIVE.

Only the ACTIVE version should eventually enter the delivery queue.

This is critical.

Do NOT overwrite the history of previous poster versions.

Poster Studio will later be able to create a new version and attach it back to the same CampaignDay.

Do not implement Poster Studio integration yet.

==================================================
7. STATUS ARCHITECTURE
==================================================

Design clean status fields/state transitions for:

Campaign
CampaignDay
Poster generation
Poster version
Approval
Delivery

Avoid creating too many overlapping statuses.

Clearly document:

What happens when:

- content changes
- template changes
- poster is regenerated
- poster is edited
- poster version is replaced
- poster is approved
- poster is rejected
- campaign is paused

Do not implement the full workflow yet.

Just create a reliable foundation.

==================================================
8. FUTURE ROLLING GENERATION SUPPORT
==================================================

The architecture must support a future rolling generation window.

Example:

Campaign has 365 days.

System may generate only:

Next 14 days

instead of all 365 posters.

Therefore:

CampaignDay records should be able to exist without generated posters.

Do not implement the rolling generator in Phase 1.

Just ensure the architecture supports it cleanly.

==================================================
9. FUTURE "EDIT ONLY THIS DAY" SUPPORT
==================================================

The architecture must support this future flow:

Campaign Day 127
  ↓
Edit in Poster Studio
  ↓
Create new Poster Version
  ↓
Set new version ACTIVE
  ↓
Campaign Day 127 now points to new version
  ↓
Queue uses new version

Other campaign days remain untouched.

Do not implement the UI yet.

==================================================
10. FUTURE "REGENERATE FUTURE DAYS" SUPPORT
==================================================

The architecture should eventually allow:

"Regenerate content from Day 101 onward"

without changing Days 1–100.

Do not implement this feature now.

Ensure CampaignDay records are independently addressable.

==================================================
11. MIGRATION SAFETY
==================================================

Create proper Prisma migrations.

Do NOT:

- prisma migrate reset
- prisma db push
- destructive schema changes
- delete existing production data
- rename/drop existing fields unless absolutely required and proven safe

If an existing model can be extended, prefer additive changes.

Before migration:
- verify DATABASE_URL is development DB.

After migration:
- run Prisma validation
- run migration status
- verify no drift.

==================================================
12. TESTS
==================================================

Add focused tests for the foundation.

At minimum verify:

1. Campaign belongs to Client.
2. Campaign can contain 365 CampaignDays.
3. CampaignDay can exist without a poster.
4. Each CampaignDay is independently addressable.
5. Multiple days can use the same template.
6. One day has one active template.
7. One CampaignDay can have multiple poster versions.
8. Only one poster version can be ACTIVE.
9. Changing Day 127 does not affect Day 126 or Day 128.
10. Campaign can exist with zero generated posters.
11. Campaign supports AUTO mapping mode.
12. Campaign supports MANUAL mapping mode.
13. Existing Poster Studio generations continue working.
14. Existing client/vertical/template functionality remains intact.

Do not make expensive OpenAI calls for these tests.

==================================================
13. DOCUMENTATION
==================================================

Update AI_POSTER_HANDOFF.md with the Phase 1 architecture.

Document:

- Campaign
- CampaignDay
- Template mapping
- Poster versions
- Status concepts
- Content/poster separation
- Future rolling generation
- Future Poster Studio integration

Clearly mark future features as NOT IMPLEMENTED.

==================================================
14. QUALITY CHECK
==================================================

Run:

- typecheck
- lint
- Prisma validation
- migration status
- relevant tests

Do NOT run expensive OpenAI tests unless required.

Inspect:

git diff

Look for:

- secrets
- production DATABASE_URL
- production URLs
- accidental changes to unrelated features
- destructive migrations
- duplicated models
- unnecessary complexity

==================================================
15. COMMIT
==================================================

If everything passes:

Create ONE logical commit:

feat: add campaign automation foundation

Then push ONLY:

git push origin feature/ai-poster-studio

Do NOT merge to main.
Do NOT deploy.

==================================================
FINAL REPORT
==================================================

Return:

1. EXISTING ARCHITECTURE FOUND
2. MODELS ADDED / MODIFIED
3. MIGRATION
4. TESTS
5. TYPECHECK / LINT
6. MIGRATION STATUS
7. COMMIT HASH
8. PUSH STATUS
9. WHAT PHASE 2 CAN NOW BUILD
10. ANY ARCHITECTURAL CONCERNS

Keep the final report concise.

STOP after Phase 1.
Do not begin Phase 2 automatically.