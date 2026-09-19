---
title: vertical-phase2
---

# EVOKZ — PHASE 2
# AI Content Calendar Generation

We are now starting Phase 2 of the Campaign Automation system.

Phase 1 is complete in commit:
cc70d0a

The Phase 1 foundation includes:
- Campaign
- CampaignDay via existing ContentCalendar
- PosterVersion
- AUTO/MANUAL mapping mode
- campaign-aware domain/service layer
- independent campaign days
- additive Prisma migration
- existing legacy calendar compatibility

A previous Phase 1 safety fix may also exist after cc70d0a.
Read the current branch state and AI_POSTER_HANDOFF.md before starting.

==================================================
CRITICAL SAFETY
==================================================

- Work ONLY on feature/ai-poster-studio.
- NEVER touch main.
- NEVER deploy.
- NEVER use production DATABASE_URL.
- NEVER run `prisma migrate reset`.
- NEVER run `prisma db push`.
- Use only the dedicated development database.
- Do not make expensive image-generation calls.
- Do not modify the existing Poster Studio architecture unnecessarily.
- Do not modify WhatsApp/Evolution delivery in this phase.
- Do not implement template drag-and-drop mapping in this phase.
- Do not implement poster generation in this phase.
- Do not implement rolling poster generation in this phase.
- Do not implement approval workflow in this phase.

Before starting:

git branch --show-current
git status
git pull origin feature/ai-poster-studio

Confirm the branch is:
feature/ai-poster-studio

==================================================
PHASE 2 GOAL
==================================================

Build the system that can take:

Client
+
Vertical
+
Plan duration
+
Campaign settings

and generate an editable content calendar.

Example:

Client:
ABC Dental Clinic

Vertical:
Dental

Plan:
365 Days

The system should generate:

Day 1 → Teeth Cleaning Tips
Day 2 → Gum Health
Day 3 → Dental Myth
Day 4 → Brushing Mistakes
...
Day 365 → Dental Awareness

The AI generates CONTENT, not finished posters.

==================================================
CORE PRINCIPLE
==================================================

Separate:

CONTENT PLANNING

from

POSTER GENERATION.

A CampaignDay can contain content without having a poster.

Example:

Campaign Day 127

Topic:
Gum Disease

Headline:
5 Signs You Shouldn't Ignore

Supporting Text:
...

CTA:
Book a consultation

Image Prompt:
...

Template:
Not assigned yet

Poster:
Not generated yet

This is valid and expected.

==================================================
1. AUDIT EXISTING CONTENT CALENDAR
==================================================

Before implementing anything, inspect:

- ContentCalendar
- Campaign
- CampaignDay domain/service code
- Client
- Vertical
- Plan
- existing content fields
- existing content import functionality
- existing calendar UI
- existing AI integrations
- existing usage tracking

Reuse existing fields where appropriate.

Do NOT duplicate:
- caption
- hashtags
- topic
- prompt
- client
- vertical
- plan

unless the existing architecture genuinely requires new fields.

Document your findings briefly before changing code.

==================================================
2. CONTENT STRATEGY
==================================================

The AI should NOT generate 365 random posts.

It should create a balanced content strategy.

For a Dental vertical, for example:

Educational
Tips
Myth Busting
Awareness
Preventive Care
Services
FAQ
Engagement
Promotional
Seasonal
Testimonials
etc.

Do not hardcode Dental-specific categories into the application.

The architecture should allow each Vertical to provide its own content strategy.

If the existing Vertical model already contains relevant information, reuse it.

If it does not, add a clean extensible mechanism.

Do not create unnecessary complexity.

==================================================
3. AI CONTENT GENERATION
==================================================

Implement a server-side AI content generation service.

The service should receive enough context to generate useful content:

- vertical
- client/business type
- campaign duration
- campaign start date
- delivery days
- relevant existing vertical information
- brand tagline where appropriate
- business context where appropriate
- existing content strategy
- language if the existing application supports it

Do NOT send private Drive IDs or secrets to the AI.

The AI should return structured data.

Do NOT rely on parsing free-form prose.

Use structured JSON/schema validation.

Each generated day should contain, where applicable:

- dayNumber
- date
- topic
- contentType
- headline
- supportingText
- cta
- caption
- hashtags
- imagePrompt
- suggestedTemplateType

Use the existing database field names where possible.

==================================================
4. 365-DAY GENERATION MUST BE CHUNKED
==================================================

DO NOT create one giant AI request for all 365 days.

Use chunks.

Recommended default:

30 days per generation request.

Example:

365 days:

Chunk 1 → Days 1–30
Chunk 2 → Days 31–60
Chunk 3 → Days 61–90
...
Chunk 13 → remaining days

This means if one request fails, only one chunk needs to be retried.

The system should be able to resume without duplicating existing days.

IMPORTANT:

Generation must be idempotent.

If Days 1–30 already exist and the request is retried:

DO NOT create duplicate CampaignDays.

==================================================
5. CONTENT VARIETY
==================================================

Avoid repetitive content.

The AI should receive context from previously generated days in the campaign/chunk so it can avoid:

- duplicate topics
- repeated headlines
- repetitive content types
- repetitive CTAs
- excessive promotional content

Implement deterministic validation where possible.

At minimum detect:

- duplicate exact headlines
- duplicate exact topics
- duplicate day numbers

Do not rely entirely on the AI to prevent duplicates.

==================================================
6. CAMPAIGN DAY CREATION
==================================================

When content is generated:

Create/update the appropriate CampaignDay.

Do NOT generate posters.

Do NOT call GPT-Image-2.

Do NOT call fal.ai.

Do NOT upload poster images.

Only create the content/calendar data.

CampaignDay should remain independently editable.

==================================================
7. PARTIAL GENERATION
==================================================

The admin should be able to:

Generate all days

OR

Generate a specific range.

Examples:

Generate:
Days 1–30

Generate:
Days 91–120

Generate:
Missing days only

If Days 1–30 already exist:

"Generate Days 1–30" should NOT blindly overwrite them.

Require an explicit overwrite/regenerate operation for existing content.

==================================================
8. REGENERATE A SINGLE DAY
==================================================

Implement domain/service support for:

Regenerate Day 127.

This should:

- preserve the date/day number
- replace/update the content fields
- increment contentRevision
- NOT affect other days
- NOT generate a poster
- NOT change template mappings
- NOT change poster versions
- NOT trigger WhatsApp

This will later be connected to the UI.

==================================================
9. REGENERATE A RANGE
==================================================

Implement domain/service support for:

Regenerate Days 101–130.

Rules:

- Days outside the range remain unchanged.
- Existing poster versions are NOT silently deleted.
- Existing active posters must not be destroyed by content regeneration.
- Clearly mark affected days as needing poster regeneration later if necessary.
- Do not actually regenerate posters in Phase 2.

Document the chosen behavior.

==================================================
10. MANUAL CONTENT EDITING
==================================================

The admin must be able to manually edit a CampaignDay's content.

Support editing:

- topic
- content type
- headline
- supporting text
- CTA
- caption
- hashtags
- image prompt

Do NOT build a complex editor yet if the existing calendar UI can be extended cleanly.

The important requirement is:

Admin edits Day 127

→ Day 127 changes only.

No AI request should happen unless the admin explicitly chooses regenerate.

==================================================
11. CALENDAR UI
==================================================

Build the first useful Campaign Calendar UI.

It should allow the admin to:

- view campaign days
- see generated/not generated state
- see content type
- see headline/topic
- edit a day
- regenerate a day
- select a range
- generate missing content
- regenerate selected range

Show clear status.

Example:

365-Day Campaign

```text
Day 1
✓ Content Ready

Day 2
✓ Content Ready

Day 3
✏ Needs Review

Day 4
○ Not Generated

Day 5
✓ Content Ready