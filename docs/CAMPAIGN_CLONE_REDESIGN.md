# Template clones and the campaign board

**Branch:** `feature/ai-poster-studio` · **Commit:** `730e083` (local only: not pushed, merged or deployed)
**Date:** 17 September 2026

## 1. In one paragraph

Campaign posters used to be new designs that were only "inspired" by a template, and a campaign took six stacked sections to run: health, review, delivery, generation, template mapping and the content calendar. Now **every poster is an exact copy of its template**. Only the words, photo, logo, brand details and footer change. When a template is uploaded, the AI reads each text element once. A new campaign fills its days with copies of the vertical's templates straight away. The admin works on **one screen**, a week-by-week board. From there they open any poster in a **template editor**, generate, check, approve and drag posts between days. Approved posters are booked for WhatsApp and sent automatically. Template mapping, the AI content calendar, the content strategy and the old daily poster maker are gone.

---

## 2. What changed at a glance

| Area | Before | Now |
|---|---|---|
| Poster look | New AI design, loosely based on the template | Exact copy of the template; only the words, photo, logo and brand details change |
| Poster shape | Client's output preset | The template's own shape (4:5 stays 4:5, 2:3 stays 2:3) |
| Content | AI content calendar + content strategy | The template's own words, with **Rewrite with AI** |
| Template use | Auto Map / Manual Map | Days are filled with templates automatically (**Fill empty days**) |
| Campaign page | 6 long sections | One board: filters, week pages, drag and drop |
| Editing a poster | Free-text prompt in Poster Studio | Template editor with the template's fields already filled in |
| Brand colours | Required | Optional; if none are set, the template's colours are kept |
| Template approval | "Approve layout" | None; only the Active/Inactive switch remains |
| Text accuracy | Not checked | An AI text check after every render, with **Fix text** |
| Booking deliveries | "Schedule approved days" button | Automatic when a poster is approved and the campaign is active |
| Old daily poster maker | Cron phases, Generate Now, layouts and plates | Removed; old data is kept |

---

## 3. What's new and how it works

### 3.1 Template elements (vertical page)
- **What:** when a template is uploaded, it is read once. The reader first measures the text boxes, then an AI vision call (`gpt-5.4`) names each block. The block types are: headline, subheadline, body, feature, CTA, badge, photo, logo, brand name, phone, website, address, person name, credential and footer.
- **Where it's stored:** `CategoryTemplate.elements`, together with `elementsReadAt` and `elementsError`.
- **Template card:** shows a one-line summary (for example "Headline · 3 features · CTA · logo · phone"), the Active/Inactive switch, **Re-read** and **Delete template**. **Show** opens a dialog of the elements that were read.
- **Existing templates:** click **Read now** / **Re-read** on the card, or run the one-off script `scripts/read-template-elements.ts --yes`.
- **Re-reading keeps element ids stable,** so campaign days that already copied the template still line up.
- **Only templates that have been read can be used in a campaign.**

### 3.2 Brand details (Brand Canvas)
- **Always taken from Brand Canvas, never typed per poster:** business name, tagline, phone, website and logo. Blocks of these kinds on the template are replaced with the client's values.
- **Other identity text** on the template (address, a doctor's name, a credential) is **hidden by default**. Two fallbacks apply:
  - a person's name uses the company name;
  - a credential uses the tagline.
- **The template's own business name** is swapped for the client's name wherever it appears inside other text.
- **Safety net:** a URL or phone number left inside kept text is hidden and flagged.
- **Logo:** placed by code, not by the AI, into the template's logo box. This makes it pixel-exact.
- **Colours:** brand colours are applied as accents only if the client has them. Otherwise the template's colours stay.
- **Readiness:** the only requirement is a company name.

### 3.3 Campaign days copy the template
- **What each day holds:** `ContentCalendar.posterElements` is the day's own copy of the template's elements. It stores the admin's words, the removed elements and an optional image prompt.
- **When days are filled:** automatically when the campaign is created, and again with **Fill empty days** on the board. The vertical's active, read templates go into the empty days in upload order, repeating as needed.
  - No AI is called and nothing is generated at this point.
  - The day is marked content-ready.
- **Old fields stay in sync:** `headline`, `supportingText` and `cta` are copied from the elements, so review, captions and history keep working.

### 3.4 Clone generation
- **Service:** `generateCampaignDayPoster` now always works in clone mode.
- **Model and quality:** `gpt-image-2` edits the template image itself, at quality **high** and in the template's own size (4:5 → 1280×1600, 2:3 → 1024×1536).
- **The prompt** (`buildClonePrompt`) says "reproduce this poster exactly", followed by a numbered list of changes only:
  - replace text X with Y;
  - remove Z and close the gap;
  - replace the photo (with the image prompt, or a new, suitable person or scene if the prompt is empty);
  - clear the logo box;
  - write the exact phone and website;
  - use brand accent colours only if they exist.
- **After the render:** code puts in the logo, and then the **text check** runs (section 3.5).
- **Unchanged machinery:** claims, retries, versions, usage/cost logging and the queue all work as before. Each render takes about 1–2 minutes.
- **Refusals:** a day whose template hasn't been read is refused with a clear message.

### 3.5 Text check, Fix text and Small change
- **Text check:** after every render, `gpt-5.4` reads the poster back and compares it with the requested words. The card and editor show, for example, "Text check: 1 difference".
  - It is stored on `PosterVersion.textCheck`.
  - If the check times out, the poster is still saved.
- **Fix text** corrects only the words the check found wrong, as a new version.
- **Small change** applies one instruction to the finished poster, for example "make the background lighter", as a new version.
- **Locks:** neither runs on sent, sending or past days.

### 3.6 Poster Studio template editor
- **How to open:** **Edit** on a board card opens `/admin/poster-studio?campaignDay=<id>`.
- **Top bar:** **Back to campaign**, the day and its status, **Approve** (or **Approve and send**) and **Reject…**.
- **Template:** the thumbnail, plus **Change template** to pick another read template of the vertical.
- **Words:** every text element in template order, pre-filled and editable.
  - Each element has **Remove** (hide) and **Reset** (back to the template's words); features are grouped.
  - **Rewrite with AI** writes fresh wording for every shown text, each close to its template length. The brand details are never touched.
- **Photo:** an empty **Image prompt** box. Leave it empty to let the AI choose a suitable new photo.
- **Brand details:** read-only (logo, name, phone, website) with **Edit in Brand Canvas**.
- **Colours:** "Brand colours", or "Template colours (no brand colours set)".
- **Preview:** a Template / Poster toggle, the versions list, the text check badge, and **Fix text** / **Small change**.
- **Saving:** words save automatically. Anything that acts on the poster (Generate, Approve, Rewrite, Change template, Fix text, Small change) saves pending words first.
  - While a render runs, the form is read-only.
  - If the day was changed in another tab, a conflict notice appears instead of overwriting.
- **Stale approvals:** editing words after approval marks the poster **Outdated**, so a stale poster is never sent.

### 3.7 Campaign board (one screen)
- **Header:**
  - client · campaign · dates · status, plus **Activate** / **Pause** / **Resume**;
  - the **Auto-approve** switch;
  - status filters with counts: **All · Draft · Generating · Needs approval · Approved · Scheduled · Sent · Failed · Needs attention**;
  - a search by headline or day number;
  - a week pager with **Today**.
  - Filters, search and week are kept in the URL.
- **Days:** 7 per page, one card each. A card shows:
  - the poster thumbnail (or the template, dimmed, before generation);
  - the day and date, headline, status and text check;
  - buttons for the next step: **Edit**, **Generate** / **Regenerate**, **Approve**, **Reject…**, **Send now** / **Retry**, **Move to day…**.
- **Drag and drop:** drop a card on another day to **insert it there**. The posts in between shift by one day.
  - The post keeps its versions, approval and booking; only its day and date change.
  - Bookings in the range are moved to the new dates.
  - **Locked days** stay in place: sent, being sent, due now, passed, or today after delivery time.
  - **Move to day…** does the same with a keyboard, on touch screens, or across weeks.
- **Bulk bar (acts on the posts in view):**
  - **Generate all not generated (N)**
  - **Approve all needing approval (N)**
  - **Fill empty days**
  - **Rewrite all drafts (N)**
  - Every bulk action asks for confirmation first.
- **Details dialog:** versions, rejection note, delivery attempts and content, with a link to the editor.
- **Generation queue:** bulk generation queues the days.
  - While the board is open, it works through the queue one poster at a time.
  - The cron worker also works through it in the background, with a time budget per run and a lock so two runs never overlap.

### 3.8 Automatic booking and sending
- **When a day is booked:** once its poster is approved (manually, or by Auto-approve) **and** the campaign is active. The admin never presses "Schedule".
- **Cron sweep** (`/api/cron`, called every minute by `scripts/dispatch-cron.sh`):
  1. re-syncs bookings;
  2. sends due deliveries (WhatsApp, to the client's own number) and retries failed ones;
  3. then runs queued generation.
- **What blocks delivery:** a paused campaign, a paused client, an outdated poster, or a missing approval. The booking waits or is released.

### 3.9 Housekeeping
- **Clear unsent legacy days** (client page, danger zone) removes old daily-poster-maker rows that were never sent. Sent history is kept.
- **Dashboard:** the Sent tile counts real sends.

---

## 4. Retired (removed from the product)
- **Campaign page:** Template mapping (Auto Map / Manual Map), the AI content calendar, the content strategy editor, bulk content import, and the old health/review/delivery/generation sections.
- **Old daily poster maker:** cron phases 1–3, Generate Now (`/admin/demo`), the approvals route, `/api/poster/preview`, layout reading on upload, layout approval, plates and the HTML poster renderers.
- **Code and tooling:** about 21 old components, 25 old scripts and their fixtures.
- **Data kept:** nothing in the database was dropped. Old columns and rows stay readable.

## 5. Database change
Migration `20260917120000_template_clone_mode` is additive only:
- adds the `CLONE` poster studio mode;
- adds `CategoryTemplate.elements`, `elementsError` and `elementsReadAt`;
- adds `ContentCalendar.posterElements`;
- adds `PosterStudioGeneration.sourceTemplateId`;
- adds `PosterVersion.textCheck`.

The earlier `20260916170000_template_prompt` migration is kept; the column is no longer shown.

---

## 6. End-to-end flow (system view)

```
Upload template ──► read elements (measure + gpt-5.4) ──► CategoryTemplate.elements
        │
Create campaign ──► fill days: copy template elements + bind Brand Canvas ──► ContentCalendar.posterElements
        │
Board / Editor ──► edit words · Rewrite with AI · image prompt · Change template
        │
Generate ──► queue ──► gpt-image-2 edits the template (high, own size)
        │            ──► code places the logo ──► text check (gpt-5.4) ──► PosterVersion (active)
        │
Needs approval ──► Fix text / Small change / Regenerate (new versions)
        │
Approve (or Auto-approve) ──► booked automatically if campaign ACTIVE
        │
Cron every minute ──► sync bookings ──► send due WhatsApp ──► Sent (retry on failure)
```

**Status path of one day:** Draft → Generating → Needs approval → Approved → Scheduled → Sent.
- **Failed** means the send failed and can be retried.
- **Needs attention** covers rejected posters, outdated posters (words changed after approval) and days with a missing or unread template.

---

## 7. Admin guide: from the first step to the last

### Step 1: Create or open the vertical
1. Go to **Verticals** and open or create the vertical (for example "Urology").

### Step 2: Upload templates
1. Upload the poster templates, in the order you want them used. Use your own or licensed designs.
2. Wait for each card's summary to appear (for example "Headline · 3 features · CTA · logo · phone").
3. If a card says **Not read yet** or shows an error, click **Read now** / **Re-read**.
4. Keep the templates you want **Active**. Turn off any you don't want used. There's nothing to approve.

### Step 3: Create the client
1. Go to **Clients** and create the client.
2. Assign the vertical and add the client's WhatsApp number (posters are sent to this number).

### Step 4: Fill in Brand Canvas
1. Open the client's **Brand Canvas**.
2. Fill in the company name (required), logo, tagline, phone and website.
3. Brand colours are optional. Without them, posters keep the template's colours.

### Step 5: Create the campaign
1. On the client page, create a campaign: **Campaign name**, **First day**, **Content days**.
2. The days fill with copies of the vertical's templates automatically. Nothing is generated or charged yet.

### Step 6: Check the board
1. Open the campaign. You see week 1 with 7 day cards.
2. Use **‹ ›** and **Today** to move between weeks, and the filters to find posts.
3. To change the order, drag a card onto another day (the posts in between shift) or use **Move to day…**.
4. If any day is empty, click **Fill empty days**.

### Step 7: Adjust the words (optional)
- **Quick option:** **Rewrite all drafts** gives every draft in view fresh wording.
- **One poster:**
  1. Click **Edit** on its card to open the template editor.
  2. Change any words, **Remove** a feature you don't need, or **Reset** it to the template's words.
  3. Optionally type an **Image prompt** (for example "smiling senior couple walking in a park"). Leave it empty to let the AI choose.
  4. Optionally use **Change template** for this day.
- **Brand details** can't be changed here. Use **Edit in Brand Canvas**.

### Step 8: Generate the posters
- **One poster:** click **Generate** in the editor or on the card.
- **Many posters:** click **Generate all not generated (N)** on the board and confirm.
- **Render time:** about 1–2 minutes each. Keep the board open for fastest progress; the background worker also continues on its own.

### Step 9: Review each poster
1. Open the poster, or look at the card. Check the **Text check** badge.
2. If words are wrong, click **Fix text**.
3. For a small visual tweak, use **Small change** (for example "make the background lighter").
4. If it's not right, click **Regenerate**, or **Reject…** with a note.

### Step 10: Approve
- Click **Approve** on the card or in the editor, or **Approve all needing approval (N)** on the board.
- To skip this step for future posters, turn on **Auto-approve** in the header.

### Step 11: Activate the campaign
1. Click **Activate** in the board header.
2. From then on, every approved poster is **booked automatically** for its day and moves to **Scheduled**. No schedule button is needed.

### Step 12: Delivery (automatic)
1. At the delivery time on each day, the poster is sent to the client on WhatsApp and the card turns **Sent**.
2. If a send fails, the card shows **Failed**. Click **Retry**, or wait for the automatic retry.
3. **Send now** sends an approved poster immediately.

### Step 13: Day-to-day running
- **Weekly check:** filter **Needs approval** and **Needs attention**.
- **Editing an approved poster** makes it **Outdated**. Regenerate and approve it again before its day.
- **Sent, sending and past days are locked** and can't be moved or edited.
- **To stop sending:** click **Pause** (campaign) or pause the client. Nothing is sent until you resume.
- **New templates:** upload them to the vertical, then use **Fill empty days** or **Change template** on specific days.

---

## 8. Verification done
- **Type check and lint:** `npx tsc --noEmit` and `next lint` are both clean.
- **Checks without a database:** all 12 suites pass: logo-key, campaign, campaign-mapping, campaign-posters, campaign-review, campaign-delivery, campaign-operations, campaign-board, campaign-clone, clone-editor-view, template-elements (289 checks) and template-elements-view.
- **Database checks:** these run inside a transaction that is rolled back, so no data is left behind. 7 suites pass: campaign-db, campaign-mapping-db, campaign-posters-db, campaign-board-db, campaign-clone-db, campaign-clone-edit-db and legacy-calendar-clear-db.
  - Three suites keep failures that already existed. They come from data already in the dev database (Northgate's live bookings and an old WhatsApp usage row), not from this code:
    - review-db: 1 failure;
    - operations-db: 1 failure;
    - delivery-db: 2 failures.
- **Real end-to-end run** (Test client, urology template, day 11), using real OpenAI with WhatsApp switched off:
  - the day was generated through the live service as v3, needing approval;
  - the render took 119 seconds at 1280×1600, quality high;
  - the logo was placed cleanly and the brand accent colour applied;
  - the text check matched 9 of 10 texts and correctly flagged the missing credential line.
  - **Bug found and fixed:** the template's registration number ("Reg No. 30435") was being kept. Registration, licence and GST numbers from the template are now hidden by default, like phones and websites.
- **Review fixes** made before the final run:
  - the worker can no longer regenerate a finished day;
  - old AI words are no longer overwritten;
  - element ids are never reused;
  - a slow text check cannot cause a second render;
  - bookings re-sync after edits;
  - pausing a client stops sending;
  - sent days are locked;
  - the cron order is now: bookings, then sends, then generation.
- **Not tested, as agreed:** a browser walkthrough and `next build`.

## 9. Known limits and open decisions (for later)
- **Campaigns per client:** one campaign per client, from the existing database key.
- **Render time:** about 1–2 minutes per poster, and a high-quality render costs more than the old low-quality ones.
- **AI copies aren't pixel-perfect:** use the text check, **Fix text** and **Regenerate**.
- **Other template details:** anything that isn't a phone, website, email or registration number (for example a clinic address typed as normal text) is kept unless you **Remove** it in the editor. Check each template's words once.
- **Editor on today's day after delivery time:** the words are locked (the day counts as closed), but **Fix text** and **Small change** still work.
- **Not done yet, as agreed:**
  - a browser walkthrough of every screen on desktop and phone;
  - a production build (`next build`);
  - testing the Dockerfile renderer clean-up.
- **Decisions still to take:**
  - the overdue booking for Northgate day 2;
  - the pricing configuration for cost reports;
  - whether **Fill empty days** should also refresh days that already have copied templates;
  - the old README sections still to tidy.
- **Pre-existing:** `lint:colors` still reports 14 findings in `poster-studio-workspace.tsx`.
