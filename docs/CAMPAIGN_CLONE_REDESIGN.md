# Evokz campaign posters — how it all works

**Branch:** `feature/ai-poster-studio` · **Commits:** `730e083`, `98dbf01`, `ff78c08`, `4d054b6`, `6d799d8` (all local: not pushed, merged or deployed)
**Updated:** 18 September 2026

---

## 1. In one paragraph

Campaign posters used to be new AI designs only loosely "inspired" by a template, and running a campaign took six stacked sections on one page. Now **every poster is an exact copy of its template** — only the words, the photo, the logo, the brand details and the footer change. A template is read once when it is uploaded, so the admin sees its text as pre-filled fields. A new campaign fills its days with copies straight away. Everything then happens on **one screen**: a week-by-week board where posters are generated, reviewed, approved and dragged between days. Any poster can be changed by talking to it — "add a footer strip with my phone and website" — and the logo can be repositioned by hand for free. Approved posters book themselves and go out on WhatsApp automatically.

---

## 2. What changed at a glance

| Area | Before | Now |
|---|---|---|
| Poster look | New AI design, loosely based on the template | Exact copy; only words, photo, logo and brand details change |
| Poster shape | Client's output preset | The template's own shape (4:5 stays 4:5, 2:3 stays 2:3) |
| Content | AI content calendar + content strategy | The template's own words, with **Rewrite with AI** |
| Template use | Auto Map / Manual Map | Days fill themselves (**Fill empty days**) |
| Campaign page | Six long sections | One board: filters, week pages, drag and drop |
| Editing a poster | A free-text prompt box | Pre-filled fields, plus a chat for changes to a finished poster |
| Logo placement | Whatever the code guessed | Size and position controls, free to apply |
| Choosing a version | Always the newest | Any version can be approved and sent |
| Brand colours | Required | Optional; without them the template's colours stay |
| Template approval | "Approve layout" | None — only Active/Inactive |
| Text accuracy | Not checked | An AI text check after every render, with **Fix text** |
| Booking deliveries | "Schedule approved days" button | Automatic on approval |
| Festival posters | Not possible safely | A template can keep its own colours and stay out of the rotation |
| Old daily poster maker | Cron phases, Generate Now, layouts, plates | Removed; old data kept |

---

## 3. The parts, and how each one works

### 3.1 Template elements (the vertical page)
When a template is uploaded it is read once: the text boxes are measured, then a vision model (`gpt-5.4`) names each block — headline, subheadline, body, feature, CTA, badge, photo, logo, brand name, tagline, phone, website, email, address, social, person name, credential.

- Stored on `CategoryTemplate.elements`, with `elementsReadAt` and `elementsError`.
- The card shows a summary ("Headline · 3 features · CTA · logo · phone"), **Show** (the full list), **Re-read**, **Delete**, and the Active switch.
- **Only a template that has been read can be used.** If a card says "Not read yet", press **Read now**.
- Re-reading keeps element ids stable, so days that already copied the template still line up.

### 3.2 Brand details (Brand Canvas)
Business name, tagline, phone, website and logo always come from Brand Canvas — never typed per poster.

- Template blocks of those kinds are replaced with the client's values.
- Other identity text (an address, a doctor's name, a credential) is **hidden by default**; a person's name falls back to the company name, a credential to the tagline.
- The template's own business name is swapped wherever it appears inside other text.
- **Safety net:** a URL, email, phone number or registration/licence number left in kept text is hidden and flagged, so another business's details can't ride along.
- The logo is placed by code, not drawn by the AI, which is what makes it exact.
- Brand colours are applied as accents only if set; otherwise the template's colours stay.
- The only hard requirement is a company name.

### 3.3 Days copy the template
`ContentCalendar.posterElements` holds each day's own copy of the template's elements: the admin's words, which elements are hidden, the image prompt and the logo placement.

- Filled automatically when the campaign is created, and by **Fill empty days**. Active, read templates go in upload order, repeating as needed. No AI call, no cost.
- `headline`, `supportingText` and `cta` stay in sync, so review, captions and history keep working.

### 3.4 Generating a poster (the clone)
`gpt-image-2` edits the template image itself, at high quality, in the template's own size (4:5 to 1280x1600, 2:3 to 1024x1536).

The prompt says "recreate this poster exactly", then lists only the changes: replace text X with Y, remove Z and close the gap, replace the photo, clear the logo box, print the exact phone and website, recolour accents only if brand colours exist. Afterwards the logo is composited by code and the text check runs. About 1–2 minutes per poster.

### 3.5 Text check, Fix text, Small change
After every render `gpt-5.4` reads the poster back and compares it with the words that were requested; the result is stored on the version and shown as a badge ("Text check: 1 difference").

- **Fix text** corrects only the words the check found wrong, as a new version.
- **Small change** applies one instruction to the finished poster.
- Neither runs on sent, sending or past days.

### 3.6 The poster chat
An always-visible box under the poster. Describe **one** change and press Enter.

- One high-quality image edit, about 2 minutes, billed to the client, saved as a new version. No confirm dialog; the cost line sits under the box.
- **This is the only way to add something the template doesn't have** — a footer strip, a contact line, a bar. The fields above can only change, hide or restore what the template already has.
- When the instruction mentions the phone, website, business name or tagline, those **exact Brand Canvas values are handed to the model**, so digits are never invented. Say "phone" or "website" plainly. Trigger words include phone, mobile, number, call, whatsapp; website, site, web, url, domain, link; business/company/brand/clinic/shop name; tagline, slogan; and footer or contact details, which imply both phone and website.
- If Brand Canvas has no such value, the box warns before you spend anything.
- **Chat changes live on that poster only.** Regenerate rebuilds from the template and loses them — the Regenerate dialog names what is at risk. Fix text may also remove them, because chat-added words are not in the Words fields.

### 3.7 Logo placement
Brand details → Logo placement: a size slider, a 3×3 position grid, and Reset to template position.

- The preview draws the logo over the poster's raw artwork using the same code the render uses, so what you see is where it lands.
- **Apply is free and takes seconds** — no AI call, nothing billed. It re-composites from the raw artwork and saves a new version.
- The placement is stored on the day, so editing words or regenerating keeps it. Changing the template clears it, because a different template has a different logo box.
- Defaults improved too: the logo's transparent padding is trimmed, a wide badge keeps its left third instead of being forced into a square, and there is a minimum size.

### 3.8 Choosing which version is sent
Every generation, chat edit, text fix and logo change adds a version. Selecting one in the Versions strip decides what Approve acts on.

- Select v1, the top button reads **"Approve v1"**, and pressing it makes v1 the active poster, approves it, and re-pins the WhatsApp booking to it.
- **"Back to vN"** returns to the active version.
- Refused for: a version whose words have since changed (regenerate instead), a version you rejected, a day mid-generation, and sent, sending or past days.
- While an older version is on show, the chat and Fix text are disabled, and Reject explains that it acts on the day's own poster.

### 3.9 The campaign board
One screen per campaign.

- **Header:** client, campaign, dates, status, Activate/Pause/Resume, the **Auto-approve** switch, status filters with counts (All · Draft · Generating · Needs approval · Approved · Scheduled · Sent · Failed · Needs attention), a search, and a week pager with **Today**. Filters, search and week live in the URL.
- **Days:** seven cards per page, each showing the poster (or the template, dimmed, before generation), the day and date, the headline, status and text check, and the next action: Edit, Generate/Regenerate, Approve, Reject, Send now/Retry, Move to day.
- **Drag and drop:** drop a card on another day to insert it there; the posts in between shift by one and their bookings follow. The post keeps its versions, approval and booking. Sent, sending, due, past and closed days stay locked. **Move to day…** does the same by keyboard or across weeks.
- **Bulk bar:** Generate all not generated · Approve all needing approval · Fill empty days · Rewrite all drafts. Each confirms first.
- **Queue:** bulk generation queues the days; the open board works through them one at a time and the cron worker also does so in the background under a time budget.

### 3.10 Approval, booking and delivery
- A day is booked as soon as its poster is approved **and** the campaign is active. There is no schedule button.
- The cron sweep (every minute) re-syncs bookings, sends what is due on WhatsApp to the client's own number, retries failures, then runs queued generation.
- Blocked by: a paused campaign, a paused client, an outdated poster, or a missing approval.
- The caption is the day's own headline, supporting text and CTA. The file arrives named `Campaign_Day_007.png`.

### 3.11 Festival and seasonal posters
A festival design runs through the ordinary flow, with two flags on its template card:

- **"Keep this template's own colours"** — the client's brand accents do not repaint the festive palette. The logo, phone and website still bind from Brand Canvas.
- **"Not in the daily rotation"** — Fill empty days and Auto Map never pick it, while it stays fully selectable by hand. (Deactivating a template would have blocked both.)

Use it by opening the festival day and pressing **Change template**. This *replaces* that day's poster; a second poster on the same date is not supported.

### 3.12 Housekeeping
- **Clear unsent legacy days** (client page, danger zone) removes old daily-poster-maker rows that were never sent; sent history is kept.
- The dashboard's Sent tile counts real sends.

---

## 4. Retired
- **Campaign page:** template mapping (Auto Map / Manual Map), the AI content calendar, the content strategy editor, bulk content import, and the old health/review/delivery/generation sections.
- **Old daily poster maker:** cron phases 1–3, Generate Now (`/admin/demo`), the approvals route, `/api/poster/preview`, layout reading on upload, layout approval, plates and the HTML renderers.
- About 21 components and 25 scripts, with their fixtures.
- **No data was dropped.** Old columns and rows remain readable.

## 5. Database changes
All additive; applied on container start by `prisma migrate deploy`.

- `20260916170000_template_prompt` — the per-template prompt (kept, no longer shown).
- `20260917120000_template_clone_mode` — the CLONE mode; `CategoryTemplate.elements`/`elementsError`/`elementsReadAt`; `ContentCalendar.posterElements`; `PosterStudioGeneration.sourceTemplateId`; `PosterVersion.textCheck`.
- `20260918120000_template_rotation_flag` — `CategoryTemplate.autoAssign` (default true, so existing templates are unaffected).

Logo placement needed no migration: it lives inside `posterElements`.

---

## 6. End-to-end flow

```
Upload template  ->  read elements (measure + gpt-5.4)  ->  CategoryTemplate.elements
      |
Create campaign  ->  fill days: copy elements + bind Brand Canvas  ->  posterElements
      |
Board / editor   ->  edit words - Rewrite with AI - image prompt - change template - logo placement
      |
Generate  ->  queue  ->  gpt-image-2 edits the template (high quality, own size)
      |              ->  logo composited by code  ->  text check  ->  new version (active)
      |
Needs approval  ->  poster chat - Fix text - Small change - Regenerate   (each = a new version)
      |
Approve (any version, or Auto-approve)  ->  booked automatically if the campaign is ACTIVE
      |
Cron each minute  ->  sync bookings  ->  send what is due on WhatsApp  ->  Sent (retry on failure)
```

**A day's status path:** Draft → Generating → Needs approval → Approved → Scheduled → Sent.
**Failed** = the send failed and can be retried. **Needs attention** = rejected, outdated (words changed after approval), or a missing/unread template.

**What costs money:** generating a poster, a chat edit, Fix text, Small change, Rewrite with AI (text only), and reading a template's elements. **Free:** filling days, editing words, applying logo placement, approving, moving days, and sending.

---

## 7. The admin's job, start to finish

### Step 1 — Vertical
Go to **Verticals** and create or open the client's vertical (for example "Dental").

### Step 2 — Upload templates
Upload the poster designs in the order you want them used, using your own or licensed artwork. Wait for each card's summary; press **Read now** if a card says "Not read yet". Keep the ones you want **Active**. Nothing needs approving.

For a **festival design**, also tick "Keep this template's own colours" and "Not in the daily rotation".

### Step 3 — Create the client
**Clients** → Manual client onboarding: company name, vertical, WhatsApp number (posters go to this number), plan, campaign window, output size, daily delivery time.

### Step 4 — Brand Canvas
Open the client's Brand Canvas: logo, tagline, contact phone, website. Only the company name is mandatory; without brand colours, posters keep the template's colours.

### Step 5 — Create the campaign
On the client page: campaign name, first day, number of content days. The days fill with template copies immediately — no AI, no cost.

### Step 6 — Activate the campaign
Press **Activate** in the campaign header. Poster generation, poster chat, text fixes, and logo placement are all enabled once the campaign is active.

### Step 7 — Look at the board
Open the campaign: seven cards per page, each showing its template dimmed. Use the filters, the search, the week arrows and **Today**. Drag a card to reorder, or use **Move to day…**. If a day is empty, press **Fill empty days**.

### Step 8 — Adjust the words (optional)
Press **Rewrite all drafts** for fresh wording across the week, or open one day with **Edit** and change the headline, **Remove** a feature, **Reset** one to the template's words, or type an **Image prompt** ("smiling family at a dental clinic"). Leave the prompt empty to let the AI choose a suitable photo. Brand details are read-only here — use **Edit in Brand Canvas**.

### Step 9 — Generate
**Generate** on one poster, or **Generate all not generated** for the week. About 1–2 minutes each. Keep the board open for the fastest run; the background worker continues anyway.

### Step 10 — Fix what's wrong
- **Logo wrong size or place?** Brand details → Logo placement → set it → **Apply** (free, seconds).
- **Need something the template hasn't got** — a footer with your phone and website, a different mood? Type it in the **poster chat** under the preview and press Enter.
- **A word came out wrong?** **Fix text**.
- **Not right at all?** **Regenerate**, or **Reject…** with a note.
- **Prefer an earlier attempt?** Click it in the Versions strip; the top button becomes **Approve v1**.

### Step 11 — Approve
**Approve** on the card or in the editor, or **Approve all needing approval** on the board. Each approved poster books itself and shows **Scheduled** with its send time. Turn on **Auto-approve** in the header to skip this for future posters.

### Step 12 — Delivery
At the delivery time the poster is sent to the client on WhatsApp and the card turns **Sent**. A failure shows **Failed** — press **Retry** or wait for the automatic retry. **Send now** sends an approved poster immediately.

### Step 13 — A festival, mid-campaign
Open the festival's day, press **Change template**, choose the festival design, **Generate**, adjust, **Approve**. It replaces that day's normal poster.

### Step 14 — Running it week to week
- Filter **Needs approval** and **Needs attention** regularly.
- Editing an approved poster makes it **Outdated** — regenerate and approve again before its day.
- Sent, sending and past days are locked.
- To stop everything: **Pause** the campaign, or pause the client.
- New templates: upload them, then use **Fill empty days** or **Change template**.

---

## 8. What has been verified
- **Type checks and lint** clean for the app and the scripts; the only colour-lint findings are 14 that pre-date this work.
- **Checks without a database:** all suites pass — template elements, editor view, clone, board, posters, review, delivery, operations, model and mapping.
- **Database checks** (each inside a transaction that is rolled back, so no data is left behind): campaign, clone, clone editor, posters, board, mapping and legacy-clear all pass.
  - Three suites keep failures caused by data already in the dev database (Northgate's live bookings and an old usage row), not by this code: review 1, operations 1, delivery 2–6 depending on the time of day.
- **Real posters generated** through the live service with WhatsApp off: the clone matches its template closely, the logo composites cleanly, and the text check matched 9 of 10 texts, correctly flagging the tenth.
- **Found and fixed while testing:** the template's own registration number was being copied onto posters; registration, licence and GST numbers are now hidden like phones and websites.
- **Not done, by your decision:** a browser walkthrough of every screen, and a production build.

## 9. Known limits
- **One campaign per client**, from an existing database key.
- **One poster per day.** A festival replaces that day's poster; two posters on one date would need day renumbering.
- **Chat additions are lost on Regenerate**, because they exist only in that poster's pixels.
- **Text the AI adds through the chat is not in the Words fields**, so the text check reads it as a difference and Fix text may remove it.
- **Details the template carries as ordinary text** (a clinic address, say) are kept unless you **Remove** them — check each template's words once.
- **Cost per poster is recorded but not priced.** Token usage is logged per call with the day attached, but the three image rates are unset, so image spend reads as zero. Setting them makes the dashboard figures real; at OpenAI's published rates a poster is roughly ₹21.
- **Renders take 1–2 minutes** and high quality costs more than the old low-quality path.
- **The Docker renderer clean-up is untested**, as the production build was skipped.
