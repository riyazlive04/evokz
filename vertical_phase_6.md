---
title: vertical phase 6
---

We are starting PHASE 6.

Current accepted checkpoint:

Phase 5 commit:
b259caf

Branch:
feature/ai-poster-studio

Remote:
origin/feature/ai-poster-studio

Phases 1–5 are complete and tested.

IMPORTANT:
- Do NOT touch main.
- Do NOT merge.
- Do NOT deploy production.
- Do NOT use production WhatsApp credentials.
- Do NOT send messages to real customers.
- Work only on feature/ai-poster-studio.
- Preserve all Phase 1–5 behavior.
- Phase 6 is DELIVERY ONLY.
- Do not reopen previous phases unless a genuine blocking defect is discovered.
- Do not make unrelated improvements.

==================================================
PHASE 6 — CAMPAIGN WHATSAPP DELIVERY
==================================================

GOAL

Connect approved campaign days to the existing WhatsApp delivery infrastructure.

The flow should become:

Campaign Day
    ↓
Approved active PosterVersion
    ↓
Delivery eligibility
    ↓
Scheduled delivery
    ↓
WhatsApp provider
    ↓
Delivered / Failed
    ↓
Retry / monitoring

Use the existing WhatsApp/Evolution API architecture already present in the application.

Do NOT create a second WhatsApp integration.

==================================================
1. AUDIT EXISTING WHATSAPP SYSTEM FIRST
==================================================

Before writing code, inspect the existing:

- WhatsApp integration
- Evolution API integration
- credentials/configuration
- message sending functions
- delivery/status handling
- existing calendar/queue logic
- existing cron/background jobs
- existing retry mechanisms
- existing booking/lead WhatsApp flows
- tenant/client WhatsApp configuration
- phone-number handling
- message/media sending

Understand the current production architecture.

Reuse existing infrastructure.

Do not modify working non-campaign WhatsApp flows unnecessarily.

==================================================
2. DELIVERY ELIGIBILITY
==================================================

A campaign day may enter delivery only if ALL required conditions are satisfied:

- campaign is active
- delivery is enabled/configured
- scheduled date/time is due
- campaign day belongs to the campaign
- content is ready
- compatible template exists
- active poster exists
- active poster is current
- poster is NOT outdated
- poster is NOT rejected
- poster is approved according to campaign approval policy
- required WhatsApp configuration exists
- recipient/destination is valid
- day has not already been successfully delivered

If any condition fails:

DO NOT send.

Return a clear reason.

Examples:

- Poster not generated
- Poster needs approval
- Poster rejected
- Poster outdated
- Template missing
- Campaign inactive
- WhatsApp not configured
- Invalid recipient
- Already delivered
- Outside delivery window

==================================================
3. APPROVAL MUST BE A HARD GATE
==================================================

This is critical.

The delivery service itself — not only the UI — must verify approval.

Never rely on:

"the UI only shows Send when approved."

The server-side delivery function must independently verify:

active PosterVersion
+
valid approval
+
current version
+
campaign eligibility

before calling Evolution API.

A direct request/action must not be able to bypass this.

==================================================
4. SCHEDULED DELIVERY
==================================================

Campaigns should support scheduled delivery based on their existing schedule configuration.

Inspect the Phase 1 schedule model and reuse it.

Do not create a conflicting scheduling model.

Support the campaign's configured:

- delivery time
- timezone
- active days/date
- campaign status

Be careful with timezone conversion.

Never assume UTC if the campaign has a configured timezone.

==================================================
5. DELIVERY QUEUE
==================================================

Create a campaign delivery queue/status model only if the existing architecture does not already provide an equivalent.

A delivery record should be sufficient to determine:

- campaign
- campaign day
- poster version
- scheduled time
- status
- attempt count
- last attempt
- failure reason
- provider message/id if available
- delivered timestamp if available

Possible statuses:

SCHEDULED
SENDING
SENT
DELIVERED
FAILED
CANCELLED
SKIPPED

Reuse existing terminology if the project already has equivalent states.

==================================================
6. IDEMPOTENCY
==================================================

This is one of the most important requirements.

The same campaign day must never send twice because of:

- cron running twice
- two browser tabs
- retry
- server restart
- network timeout
- duplicate webhook
- admin double-click
- overlapping workers

Claim a delivery atomically before sending.

A successful delivery must make subsequent attempts no-op.

Use a database uniqueness/idempotency mechanism wherever appropriate.

==================================================
7. POSTER VERSION SAFETY
==================================================

Delivery must reference the exact PosterVersion that was approved.

Do not simply query:

"whatever poster is currently active."

The delivery record should preserve which version was approved/scheduled.

If the active version changes before delivery:

determine the correct behavior explicitly.

Recommended safe behavior:

old scheduled delivery becomes invalid/outdated

new active version requires approval

nothing is sent automatically from the new version unless it independently satisfies the campaign policy.

Never accidentally send a newly generated unapproved version.

==================================================
8. SCHEDULING + RESCHEDULE SAFETY
==================================================

If an admin changes:

- campaign date
- delivery time
- timezone
- campaign status

delivery records must remain consistent.

Do not create duplicate delivery jobs.

Do not send immediately just because a schedule was edited.

Recalculate delivery eligibility safely.

==================================================
9. EVOLUTION API
==================================================

Use the existing Evolution API integration.

Do not hardcode:

- API URLs
- API keys
- instance names
- phone numbers

Use environment/configuration already established by the application.

Never expose Evolution credentials to the browser.

Never log credentials.

Never include credentials in error messages.

==================================================
10. MEDIA DELIVERY
==================================================

Determine how the existing WhatsApp integration sends media.

Use the existing supported approach.

The campaign poster should be delivered from the appropriate private/storage mechanism without exposing internal Drive credentials.

Do not make Google Drive files public merely for WhatsApp delivery.

If the current Evolution integration requires a temporary accessible media URL:

implement the safest existing project-compatible mechanism.

Do not invent a public permanent URL architecture.

==================================================
11. MESSAGE CONTENT
==================================================

Campaign WhatsApp message should be based on the approved campaign day's content.

At minimum inspect/reuse:

- headline
- supporting text
- CTA
- poster image

Do not regenerate content during delivery.

Do not call OpenAI during delivery.

Delivery must consume the already-approved campaign content/poster.

==================================================
12. RECIPIENTS / DESTINATIONS
==================================================

Do NOT invent a recipient model.

Audit the existing client/campaign WhatsApp destination architecture.

Determine whether campaign delivery is intended for:

- a configured WhatsApp number
- a contact list
- existing lead/contact recipients
- a client-defined destination

Use the existing project architecture if available.

If the current application does not have a clearly defined campaign recipient source:

STOP and report this as a blocking architectural gap instead of inventing one.

Do not send anything to arbitrary numbers.

==================================================
13. RETRIES
==================================================

Implement safe retries for transient failures.

Examples:

- network timeout
- temporary provider error
- 5xx response

Do NOT blindly retry permanent failures such as:

- invalid number
- authentication failure
- campaign disabled
- approval failure
- invalid configuration

Use bounded retries.

No infinite retry loops.

==================================================
14. FAILURE HANDLING
==================================================

A failed delivery should record:

- status
- failure reason
- attempt count
- timestamp

The campaign should remain recoverable.

A failure on Day 5 must not prevent Day 6 from being delivered.

Provider/API configuration failures may be treated as systemic failures where appropriate.

==================================================
15. DELIVERY MONITORING UI
==================================================

Add a campaign delivery section/dashboard.

Show:

Scheduled
Sending
Sent
Delivered
Failed
Skipped

Example:

DELIVERY

Today
Scheduled       5
Delivered       8
Failed          1
Skipped         0

Provide filters:

All
Scheduled
Sent
Delivered
Failed
Skipped

Per-day detail should show:

- date
- poster preview
- version
- approval status
- scheduled time
- delivery status
- attempts
- last error
- provider message ID if available

==================================================
16. MANUAL SEND / RETRY
==================================================

If manual Send Now is implemented:

it MUST use exactly the same server-side eligibility checks as scheduled delivery.

It must NOT bypass:

- approval
- active version
- campaign status
- recipient validation
- duplicate protection

Require confirmation before sending.

Retry should be available only for eligible failed deliveries.

Never allow:

Send Now
on an already successfully delivered day.

==================================================
17. CAMPAIGN STOP / PAUSE
==================================================

If campaign is paused or stopped:

future unsent deliveries must not send.

Already completed deliveries remain historical records.

Resuming the campaign should safely determine which future days are eligible.

Do not duplicate existing delivery records.

==================================================
18. LEGACY WHATSAPP SAFETY
==================================================

This is critical.

Existing non-campaign WhatsApp workflows must continue working.

Campaign delivery must not accidentally pick up legacy calendar rows.

Campaign queries must explicitly remain scoped to campaign-backed days.

Run the existing calendar isolation suite.

==================================================
19. CRON / BACKGROUND EXECUTION
==================================================

Audit how the existing project runs scheduled work.

Reuse the existing mechanism if possible.

If the current system has a cron endpoint:

secure it appropriately.

Do not create an unauthenticated endpoint that can trigger arbitrary WhatsApp sends.

If a server-side background worker is not currently available:

implement the smallest safe scheduled mechanism supported by the current deployment architecture.

Do NOT introduce a large queue infrastructure unless genuinely required.

==================================================
20. SECURITY
==================================================

Never expose:

- Evolution API key
- WhatsApp credentials
- private Drive credentials
- service-account credentials
- internal storage paths
- private database identifiers

to browser/client-side code.

Check logs for accidental credential leakage.

==================================================
21. PRODUCTION SAFETY
==================================================

During development:

USE DEV/TEST EVOLUTION CONFIGURATION ONLY.

Do not use real customer recipients.

If a safe test recipient is not available:

mock the provider.

Do not "just test once" against production.

Production deployment is NOT part of Phase 6.

==================================================
22. TESTING
==================================================

Add focused tests for:

- delivery eligibility
- approval hard gate
- outdated poster rejection
- rejected poster rejection
- missing poster
- missing template
- inactive campaign
- invalid recipient
- duplicate prevention
- atomic claiming
- successful send
- provider failure
- retry
- permanent failure
- campaign pause
- resumption
- scheduled delivery
- manual Send Now
- already-delivered protection
- exact PosterVersion reference
- version changes before delivery
- timezone handling
- credential leakage
- legacy calendar isolation

Run ALL previous suites:

Phase 1
Phase 2
Phase 3
Phase 4
Phase 5
Legacy calendar isolation
Poster Studio tests

Everything must remain green.

==================================================
23. BROWSER TEST
==================================================

Use an isolated local environment.

Do NOT send to real customers.

Mock Evolution API or use a dedicated test instance/number only.

Test:

1. Campaign with approved poster
2. Delivery appears scheduled
3. Attempt delivery
4. Provider receives exactly one request
5. Delivery becomes successful
6. Run delivery again
7. Verify no second request
8. Try unapproved poster
9. Verify no provider request
10. Try outdated poster
11. Verify no provider request
12. Try rejected poster
13. Verify no provider request
14. Simulate provider failure
15. Verify Failed state
16. Retry
17. Verify successful recovery
18. Pause campaign
19. Verify future delivery is skipped
20. Resume campaign
21. Verify eligible future delivery
22. Change active PosterVersion
23. Verify old scheduled delivery cannot accidentally send wrong version
24. Test manual Send Now
25. Verify mobile UI
26. Test 390px width
27. Verify no console errors

==================================================
24. DATABASE SAFETY
==================================================

Before any migration:

- confirm DATABASE_URL points only to dev DB
- backup dev DB
- inspect migration state
- use additive migrations only

NEVER:

prisma migrate reset
prisma db push

Never touch production DB.

==================================================
25. DOCUMENTATION
==================================================

Create:

vertical-phase6.md

Document:

- delivery architecture
- eligibility rules
- approval gate
- scheduling
- idempotency
- retry rules
- Evolution API integration
- recipient source
- security
- failure handling
- tests
- known limitations

==================================================
26. GIT CHECKPOINT
==================================================

Before implementation:

git branch --show-current
git status

Confirm:

feature/ai-poster-studio

After implementation:

- run all tests
- inspect git diff
- verify no unrelated changes
- verify no secrets changed
- verify no production configuration changed
- verify no production WhatsApp calls occurred
- verify no deployment occurred

Commit ONLY Phase 6 changes:

feat: add campaign WhatsApp delivery

Push:

origin/feature/ai-poster-studio

==================================================
STOP CONDITION
==================================================

After pushing Phase 6:

STOP.

Do NOT start Phase 7.

Report:

- commit hash
- files changed
- migration(s)
- recipient architecture
- scheduling architecture
- delivery states
- approval gate
- idempotency mechanism
- retry behavior
- Evolution API integration
- security checks
- test results
- browser test results
- known limitations

If recipient/destination architecture is genuinely missing, do NOT invent it. Report the blocker instead of implementing unsafe assumptions.