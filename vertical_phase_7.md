---
title: vertical phase 7
---

We are starting PHASE 7.

CURRENT CHECKPOINT
==================

Phase 1: Campaign foundation        COMPLETE
Phase 2: AI content calendar        COMPLETE
Phase 3: Template mapping            COMPLETE
Phase 4: Rolling poster generation   COMPLETE
Phase 5: Review + approval          COMPLETE
Phase 6: WhatsApp delivery          COMPLETE

Latest accepted commit:

eb902c0 — feat: add campaign WhatsApp delivery

Branch:

feature/ai-poster-studio

Remote:

origin/feature/ai-poster-studio

IMPORTANT:
- Do NOT touch main.
- Do NOT merge.
- Do NOT deploy production.
- Do NOT send WhatsApp messages to real recipients.
- Do NOT change the recipient architecture.
- Do NOT start customer-facing WhatsApp marketing.
- Preserve Phases 1–6.
- Do not reopen completed phases unless a genuine blocking defect is found.
- Do not make unrelated UI changes.
- Do not create unnecessary infrastructure.

==================================================
PHASE 7 — CAMPAIGN OPERATIONS & RELIABILITY
==================================================

GOAL

Make the campaign automation system operationally reliable and easier for an admin to manage.

The system already supports:

Campaign
  ↓
AI Content Calendar
  ↓
Template Mapping
  ↓
Poster Generation
  ↓
Review / Approval
  ↓
WhatsApp Delivery

Phase 7 should improve the reliability, observability and operational control of this existing pipeline.

Do NOT redesign the core product.

==================================================
0. FIRST — AUDIT BEFORE CODING
==================================================

Before changing anything, inspect the current implementation of:

- campaign lifecycle
- poster generation
- poster generation claims
- delivery queue
- cron worker
- delivery idempotency
- approval/rejection
- PosterVersion
- UsageEvent
- WhatsApp provider integration
- campaign dashboard
- error handling
- retry behavior
- existing logging
- existing database schema
- existing scheduled jobs

Produce a short implementation plan based on the actual code.

Do not assume that a new table or queue is required.

==================================================
1. SERVER-SIDE GENERATION RELIABILITY
==================================================

Current limitation:

Poster generation is browser-driven.

The browser can close while a campaign batch is running.

Improve this where possible using the existing application architecture.

Preferred direction:

Campaign poster generation should be triggerable server-side and recoverable.

However:

DO NOT introduce Redis/BullMQ/Kafka/etc. unless the existing infrastructure genuinely requires it.

Prefer the smallest reliable architecture that fits the current application.

The system must support:

- queued generation
- claim
- generation
- success
- failure
- retry
- recovery after process restart

A browser should be able to start a generation job without needing to remain open for the entire batch.

==================================================
2. GENERATION JOB SAFETY
==================================================

Maintain the existing atomic claim/idempotency behavior.

Two workers must not generate the same day simultaneously.

A crashed generation must become recoverable.

Existing:

posterGenerationStartedAt

must continue to protect against abandoned jobs.

Do not create duplicate PosterVersions.

Do not create duplicate OpenAI charges.

==================================================
3. BOUNDED CONCURRENCY
==================================================

Generation must not overwhelm:

- OpenAI
- server CPU/memory
- Google Drive
- database

Use controlled concurrency.

Do not blindly run all eligible days simultaneously.

Make concurrency configurable if appropriate.

Default should be conservative.

==================================================
4. COST TRACKING
==================================================

Current known limitation:

Image prices are not configured, so usage is not properly costed.

Audit the existing UsageEvent structure.

Implement proper cost accounting if the required model/usage information is available.

Requirements:

- generation model
- image size
- quality
- generation count
- estimated/requested cost
- actual usage if provider exposes it
- campaign association where appropriate

Do NOT hardcode a fake "actual cost" if OpenAI does not provide that information.

Clearly distinguish:

estimated cost
vs
actual provider-reported usage

If pricing must be configured manually:

make it explicit and centralized.

Do not scatter prices across the codebase.

==================================================
5. CAMPAIGN COST VISIBILITY
==================================================

Campaign dashboard should show useful generation usage.

Example:

POSTER GENERATION

Generated: 14
Failed: 1
Remaining: 4

Estimated AI spend:
₹XXX / $X.XX

If exact cost cannot be established:

show "Estimated" clearly.

Do not present an estimate as an actual bill.

Do not expose API keys.

==================================================
6. DELIVERY RELIABILITY
==================================================

Audit Phase 6 delivery behavior.

Improve reliability without changing its safety guarantees.

Preserve:

- server-side approval gate
- exact PosterVersion pinning
- UNIQUE calendarDayId idempotency
- atomic claiming
- bounded retries
- campaign pause protection
- duplicate prevention

Do not weaken any of these guarantees.

==================================================
7. DELIVERY RATE CONTROL
==================================================

Current limitation:

No jitter for campaigns sharing the same delivery time.

Implement safe rate control if appropriate.

Prevent a large number of campaigns from attempting WhatsApp delivery simultaneously.

Use conservative spacing/batching.

Do not introduce unnecessary complexity.

Never bypass provider limits.

==================================================
8. DELIVERY RECEIPTS
==================================================

Audit whether the existing Evolution API integration provides:

- message ID
- sent status
- delivered status
- failed status
- webhook callbacks

If reliable provider status/webhook support exists:

design support for delivery receipts.

If it does not exist:

DO NOT invent a delivered state.

Keep:

SENT = provider accepted

and document that limitation.

Do not claim a message reached the recipient unless the provider actually confirms it.

==================================================
9. OPERATIONAL DASHBOARD
==================================================

Improve the campaign dashboard so an admin can understand campaign health quickly.

Show:

CONTENT
- ready
- needs review
- missing

TEMPLATES
- mapped
- unmapped
- conflicts

POSTERS
- generated
- needs review
- approved
- rejected
- outdated
- failed

DELIVERY
- scheduled
- sent
- failed
- skipped

AI USAGE
- generations
- estimated cost

Example:

CAMPAIGN HEALTH

Content          365 / 365
Templates        365 / 365
Posters           14 / 14
Approved          12 / 14
Delivery           8 / 14

Needs attention:
- 1 failed poster
- 1 rejected poster
- 2 awaiting approval

Make these actionable links.

==================================================
10. NEEDS ATTENTION QUEUE
==================================================

Create a unified operational view.

Group blockers:

CONTENT
TEMPLATE
POSTER
APPROVAL
DELIVERY

Examples:

POSTER
Day 17 — generation failed

APPROVAL
Day 21 — awaiting review

DELIVERY
Day 12 — provider failure

TEMPLATE
Day 29 — inactive template

Clicking an issue should open the relevant day/action.

Do not force the admin to inspect all 365 days manually.

==================================================
11. CAMPAIGN PAUSE / RESUME
==================================================

Audit existing campaign lifecycle.

Ensure:

ACTIVE
PAUSED
COMPLETED
CANCELLED

or equivalent existing states behave safely.

When paused:

- future generation should not start
- future delivery should not send
- already completed history remains
- running jobs should settle safely

When resumed:

- missing eligible work can continue
- no duplicate generation
- no duplicate delivery

Do not invent lifecycle states if existing ones already cover this.

==================================================
12. FAILED JOB RECOVERY
==================================================

Provide safe recovery for:

- generation failures
- delivery failures
- abandoned generation
- abandoned delivery

Admin should clearly see:

Failed
Retry available

Retry must be bounded and safe.

Do not create infinite retry loops.

Do not retry permanent configuration failures automatically.

==================================================
13. ALERTING / VISIBILITY
==================================================

Do not build a huge notification platform.

At minimum make serious failures visible in the admin UI.

Potential blockers:

- repeated poster generation failures
- WhatsApp configuration failure
- delivery failures
- missing templates
- outdated posters
- missing approval
- abandoned jobs

If an existing notification mechanism can be reused, use it.

Do not add email/WhatsApp alerts unless the existing architecture already supports them cleanly.

==================================================
14. AUDITABILITY
==================================================

Current limitation:

There is no complete sequence history for campaign review/mapping.

Do NOT build a huge event-sourcing system.

Instead determine the minimum useful operational history.

At minimum, an admin should be able to understand:

- when poster was generated
- which version is active
- whether it was approved/rejected
- when it was delivered
- whether delivery failed
- relevant failure reason

Reuse existing timestamps, PosterVersion, reviewNote and CampaignDelivery data wherever possible.

Only add an audit table if the existing data genuinely cannot support this.

==================================================
15. REJECTION → REGENERATION INTELLIGENCE
==================================================

Current limitation:

Rejection reason is stored but regeneration does not use it.

Improve the workflow carefully.

When regenerating after rejection:

make the rejection context available to the regeneration workflow where useful.

Example:

Previous review:
"Branding issue — logo too close to headline."

Regeneration should understand:

"Address the previous review issue. Do not repeat the same branding problem."

BUT:

Do not send sensitive/internal information unnecessarily.

Do not blindly pass the entire review history to the model.

Only use the relevant review note.

Do not automatically regenerate after rejection.

==================================================
16. CLEANUP / RETENTION
==================================================

Audit Drive and database cleanup.

Ensure abandoned/failed generation artifacts do not accumulate indefinitely.

Do NOT delete active or historical PosterVersions.

Do NOT delete files that are still referenced.

Only clean genuinely orphaned temporary artifacts.

If automatic cleanup is risky:

report it rather than implementing destructive cleanup.

==================================================
17. OBSERVABILITY
==================================================

Improve structured logging around:

- campaign ID
- campaign day ID
- poster version ID
- generation attempt
- delivery attempt
- provider response status

Never log:

- API keys
- access tokens
- service-account private keys
- WhatsApp credentials
- private signed URLs unnecessarily

Use safe identifiers only.

==================================================
18. SECURITY REVIEW
==================================================

Audit Phase 1–6 campaign endpoints/actions.

Verify:

- campaign ownership/client isolation
- server-side authorization
- no cross-client campaign access
- no unauthorized approval
- no unauthorized generation
- no unauthorized delivery
- no credential exposure
- no Drive ID leakage
- cron remains protected by CRON_SECRET
- campaign media tokens remain protected

Do not weaken existing security controls.

==================================================
19. DATABASE MIGRATION RULE
==================================================

This machine currently has a Windows Application Control issue.

The Prisma schema-engine executable is blocked by Windows Smart App Control / Code Integrity.

Therefore:

BEFORE ANY MIGRATION:

1. Check whether a migration is genuinely required.
2. If NO migration is required, continue normally.
3. If a migration IS required, STOP and report it before applying it.

DO NOT:

- use prisma migrate reset
- use prisma db push
- manually fake Prisma migration metadata
- manually apply SQL as a workaround
- modify production DB

Do not bypass the Windows security policy.

A future migration should wait until Prisma's schema-engine can execute normally.

==================================================
20. TESTING
==================================================

Add focused tests for:

GENERATION
- server-side trigger
- worker claim
- duplicate worker prevention
- abandoned job recovery
- bounded concurrency
- retry
- permanent failure
- campaign pause

COST
- usage recording
- model/size/quality tracking
- estimated cost
- missing pricing handling

DELIVERY
- idempotency
- rate limiting
- retry
- provider failure
- approval gate
- exact PosterVersion
- pause/resume

OPERATIONS
- readiness
- needs-attention queue
- campaign health
- failed jobs
- recovery

SECURITY
- authorization
- tenant/client isolation
- credential leakage
- cron authentication
- campaign-media protection

Run ALL previous suites:

Phase 1
Phase 2
Phase 3
Phase 4
Phase 5
Phase 6
Legacy calendar isolation
Poster Studio

Everything must remain green.

==================================================
21. BROWSER TEST
==================================================

Use isolated local testing.

NO real WhatsApp messages.

Mock Evolution API.

Mock OpenAI where required.

Test:

1. Campaign dashboard
2. Campaign health counters
3. Needs-attention queue
4. Trigger poster generation
5. Close/refresh browser
6. Verify generation continues/recovery works
7. Verify duplicate generation cannot occur
8. Verify failed generation recovery
9. Verify cost information
10. Review/approve poster
11. Schedule delivery
12. Mock delivery
13. Verify delivery status
14. Verify duplicate delivery prevention
15. Simulate provider failure
16. Retry
17. Pause campaign
18. Verify future work stops
19. Resume campaign
20. Verify eligible work resumes
21. Reject poster
22. Regenerate
23. Verify rejection context is used safely
24. Verify old PosterVersion remains immutable
25. Test mobile at 390px
26. Verify no horizontal overflow
27. Verify no console errors

==================================================
22. PERFORMANCE
==================================================

Check:

- dashboard queries
- campaign calendar queries
- review queue
- delivery queue
- generation queue

Avoid N+1 queries.

Do not load all 365 poster images unnecessarily.

Use pagination/lazy loading where appropriate.

Do not sacrifice correctness for premature optimization.

==================================================
23. DOCUMENTATION
==================================================

Create:

vertical-phase7.md

Include:

- architecture
- background generation behavior
- retry/recovery
- cost accounting
- delivery reliability
- campaign operations
- security
- auditability
- known limitations
- tests

==================================================
24. GIT SAFETY
==================================================

Before implementation:

git branch --show-current
git status

Confirm:

feature/ai-poster-studio

After implementation:

- run all tests
- inspect git diff
- check unrelated changes
- check secrets
- check production configuration
- confirm no real WhatsApp sends
- confirm no production deployment
- confirm no main changes

Commit ONLY Phase 7:

feat: harden campaign operations and reliability

Push:

origin/feature/ai-poster-studio

==================================================
STOP CONDITION
==================================================

After pushing Phase 7:

STOP.

Do NOT start Phase 8.

Report:

- commit hash
- files changed
- whether migration was required
- background generation architecture
- cost tracking
- operational dashboard
- recovery behavior
- delivery reliability
- security findings
- tests
- browser tests
- known limitations

If a migration is required but Prisma schema-engine is still blocked by Windows Application Control:

STOP and report the migration requirement.

Do NOT manually bypass Prisma again.