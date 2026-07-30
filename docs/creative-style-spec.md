# Evokz creative style spec — construction / real-estate vertical

Reverse-engineered from 12 competitor reference posters (the "Evokz manual" set).
This is the target our generated creatives must hit. It is a **layout spec**, not a
prompt: the references are template posters, not prompt-rendered images.

---

## 1. Canvas

| Property | Value |
| --- | --- |
| Aspect | 9:16 portrait (WhatsApp status / IG story) |
| Reference pixels | 940 × 1568 |
| Render target | 1080 × 1920 (scale spec values by 1.149) |
| Outer margin | 48 px left/right at reference scale (~5% of width) |
| Safe zone | No text within 40 px of any edge except full-bleed bars |

Nothing in the set is square. A square render is immediately off-brand.

---

## 2. Slot skeleton (invariant across all 12)

Top to bottom, every reference uses this order. Slots may be omitted but never reordered.

```
┌─ 1. LOGO LOCK ────────────── top-left, always
│  2. TAGLINE            ····· optional, letterspaced caps
│  3. HEADLINE           ····· 2–4 lines, ALL CAPS, one line in accent colour
│  4. ACCENT RULE        ····· short horizontal bar
│  5. BODY PARAGRAPH     ····· 3–5 lines, sentence case
│  6. FEATURE BLOCK      ····· 3–4 items, circled line icon + label + 2-line body
│  7. HERO PHOTO         ····· occupies the opposite region; see §5 archetypes
└─ 8. CONTACT BAR ────────────  full-bleed, phone + website, bottom
```

### Slot detail

**1. Logo lock** — two observed forms:
- *Placeholder box*: 1.5 px outlined rectangle, ~235 × 180 px, containing "LOGO / HERE"
  stacked, bold caps, centred. Used in 7/12.
- *Real lockup*: line-art icon (building/skyline) at left + company name bold caps
  + letterspaced tagline beneath. Used in 5/12. **This is the form to build** —
  the boxed version is a stock placeholder.

**2. Tagline** — caps, ~14 px, letter-spacing 0.18em, colour = 60% opacity of body colour.
Sits directly under the logo lock. Present in 4/12.

**3. Headline** — the dominant element. Rules:
- ALL CAPS, weight 800–900, line-height 0.92–1.0 (tight, lines nearly touch)
- 2–4 lines, each line 1–3 words. Never a wrapped paragraph.
- **Exactly one line (or one trailing word) in the accent colour**, the rest in the
  neutral. Never two accent lines, never a whole accent headline.
- Size 76–96 px at reference scale; scales *down* as line count rises so total
  headline block height stays ~300–380 px.
- Trailing full stop appears in 5/12 ("DOLOR SIT." / "ADIPISCING.") — a stylistic
  tic worth keeping as an option.

**4. Accent rule** — solid bar, **120 × 6 px**, accent colour, 32 px above the body
paragraph. Present in 11/12. This single element does most of the "designed" signalling;
do not omit it.

**5. Body paragraph** — sentence case, regular weight, 26–30 px, line-height 1.55,
measure capped at ~34 characters so it wraps to 3–5 short lines. Colour: neutral at
85% opacity. Never justified, always left-aligned ragged-right.

**6. Feature block** — 3 or 4 items. Two arrangements:
- *Vertical list* (6/12): icon left in a 1.5 px circle Ø 72 px, label bold caps 24 px
  to its right, 2 lines of 20 px body beneath the label. 1 px hairline divider between
  items at 25% opacity.
- *Horizontal strip* (6/12): items side by side inside a full-bleed contrasting band,
  icon centred above a centred label and centred 3-line body. Vertical 1 px dividers
  between columns.

Icons are **always monoline** (1.5–2 px stroke), never filled, never multicolour, and
always accent-coloured or neutral — matching the accent only. Recurring set: hard hat,
building/skyline, shield-check, stopwatch/clock, blueprint, people/group, award rosette,
handshake, truck, house-in-hand.

**7. Hero photo** — see §5.

**8. Contact bar** — full-bleed, bottom-anchored, height 130–190 px.
- Two cells split by a 1 px vertical divider at 40% opacity: phone left, website right.
  (Or stacked as two full-width rows in 4/12.)
- Each cell: circular icon badge (Ø 76 px, filled or outlined) + a caps label at 22 px
  (`CALL US TODAY` / `VISIT OUR WEBSITE`) with the value beneath in bold 34 px.
- Bar background is the **accent** colour with dark text, or the **dark neutral** with
  accent text. Never the same colour as the panel above it — this bar is the poster's
  hard bottom edge.

---

## 3. Colour system

The rule the whole set obeys: **one dark neutral + one light neutral + exactly one
saturated accent.** No reference uses two competing accents.

| Ref | Dark neutral | Light neutral | Accent |
| --- | --- | --- | --- |
| 1 | `#0A0A0A` | — | `#D99A20` gold |
| 2 | `#2B2B2B` | — | `#FFC107` amber |
| 3 | `#1A1A1A` | `#FFFFFF` | `#F26522` orange |
| 4 | `#14284B` navy | `#F5F7FA` | `#F07C22` orange |
| 5 | `#1A1A1A` | `#F4F4F2` | `#B8862B` bronze |
| 6 | `#0F2A4A` navy | — | `#F0A81E` amber |
| 7 | `#14295C` navy | `#F7F8FA` | `#F0A020` amber |
| 8 | `#1A1A1A` | `#FAF8F6` | `#F04A16` orange-red |
| 9 | `#0B1E3D` navy | — | `#FFB81C` amber |
| 10 | `#111111` | — | `#FFC20E` yellow |
| 11 | `#1B3A6B` navy | `#FFFFFF` | `#1546A0` blue |
| 12 | `#0D2B6B` navy | `#F7F9FC` | `#1746C4` blue |

Two accent families only: **warm** (gold → amber → orange → orange-red) and **cool blue**.
Warm accents pair with black or navy. Cool blue accents pair with navy and rely on the
photo for warmth. Pick the family from the client's brand palette; never mix families.

Contrast requirements (enforce, don't eyeball):
- Headline neutral on dark panel: ≥ 7:1
- Accent headline line on its background: ≥ 4.5:1 — amber/yellow **fails** on white,
  which is why every warm-accent reference puts the accent line on black or navy
- Body text: ≥ 4.5:1
- Contact-bar text on accent fill: dark text on amber, never white

### Photo legibility treatment

Text never sits on unmodified photo. Observed treatments, in order of frequency:
1. **Solid panel** — photo confined to one region, text on flat colour (7/12)
2. **Directional scrim** — linear gradient from the dark neutral at 92% opacity over
   the text side to 0% at the photo side, so the photo is only fully visible where no
   text lands (3/12)
3. **Photo darkened globally** to 35–45% brightness with text over it (2/12)

---

## 4. Typography

| Role | Character | Size @940px | Weight | Tracking | Leading |
| --- | --- | --- | --- | --- | --- |
| Headline | Heavy grotesque or condensed caps | 76–96 | 800–900 | -0.01em | 0.92–1.0 |
| Logo wordmark | Same family as headline | 34–40 | 700–900 | 0.02em | 1.1 |
| Tagline | Body family, caps | 13–15 | 400–500 | 0.18em | 1.2 |
| Body | Neutral grotesque | 26–30 | 400 | 0 | 1.55 |
| Feature label | Body family, caps | 22–26 | 700 | 0.02em | 1.2 |
| Feature body | Body family | 19–21 | 400 | 0 | 1.45 |
| Contact label | Body family, caps | 21–23 | 700 | 0.06em | 1.2 |
| Contact value | Body family | 32–36 | 700–900 | 0 | 1.2 |

Two families maximum per poster. Observed headline faces map to:
- **Condensed heavy** (refs 6, 9, 10, 13) → Anton, Oswald 700, Archivo Narrow 800
- **Wide heavy** (refs 1, 3, 4, 5, 7, 8, 11, 12) → Archivo Black, Inter 900, Roboto Black

Body is always a plain grotesque: Inter, Roboto, Open Sans, Archivo 400.

One reference (13) uses a **brush script** for a single accent word set against a
condensed cap line. High-impact, and the only decorative type in the whole set — treat
as a rare variant, max one word, accent colour, never for the primary line.

---

## 5. Layout archetypes

Five recurring compositions. Each defines where the photo sits and therefore where the
photo must contain negative space.

### A. Scrim overlay — refs 1, 6, 9, 10
Photo full-bleed. Dark scrim gradient across the left/upper 55%. All copy on the scrim,
vertically stacked, feature block as a horizontal strip near the bottom, contact bar
full-bleed. **Photo requirement:** subject in the right/lower third, sky or dark
low-detail area upper-left.

### B. Diagonal split — refs 2, 13
Solid dark panel left, photo right, boundary a single straight diagonal (~12–18° off
vertical). Copy in the panel. Feature block sits in a contrasting rounded shape
overlapping the boundary. **Photo requirement:** subject right of centre.

### C. Stacked bands — refs 3, 5, 7
Photo occupies a horizontal band across the middle/lower area. Headline and body above
it on a light neutral, feature strip in a dark band below the photo, contact bar below
that. Three hard horizontal edges. **Photo requirement:** wide establishing shot,
subject centred.

### D. Curved split — ref 4
Photo top-right on a light field; a large curved sweep in the dark neutral rises from
the bottom-left to carry the contact bar. Feature list vertical on the left over the
light field. **Photo requirement:** subject upper-right, clean lower-left.

### E. Light editorial — refs 8, 11, 12
Light neutral field, photo fading into it (no hard edge — the photo's own bright sky
or a white gradient dissolves the boundary). Copy left, feature strip low, dark contact
bar. Feels the most premium; needs a genuinely bright, airy photo. **Photo requirement:**
high-key, bright background, subject right.

---

## 6. Copy conventions

- Headline: 3–7 words total across all lines. Benefit or identity, not a sentence.
  Observed real example: `PREMIUM / COMMERCIAL / SPACES`.
- Subhead when present: two short clauses, parallel structure, each ending in a full
  stop. Observed: `Built for Business. Designed for Success.`
- Feature labels: 1–3 words, noun phrases, parallel. Observed set:
  `Strategic Locations` / `Smart Infrastructure` / `Sustainable & Efficient` /
  `Future Ready`.
- Contact labels are imperatives or directives: `CALL US TODAY`, `VISIT OUR WEBSITE`.
- No pricing, no percentages, no award claims, no statistics — the references never make
  a verifiable claim, and we have no source for one.

---

## 7. Photo direction

The photo is a **background asset with a mandated empty region**, not the creative.
Prompt it for:
- Subject vocabulary: mid-rise/high-rise under construction, tower crane against sky,
  workers in hi-vis and hard hats (often silhouetted at golden hour), modern flat-roof
  villa with warm interior glow at dusk, glass commercial block, blueprints with hard
  hat and drafting tools, architectural wireframe render.
- Lighting: golden hour or blue-hour dusk for warm-accent posters; bright midday for
  cool-blue and light-editorial posters. Warm interior window glow is a recurring motif
  in every residential shot.
- Composition: subject pushed to the side the archetype requires, with a low-detail
  region (sky, shadow, plain wall) reserved for the copy.
- **Never** request text, letters, numbers, logos, signage, or watermarks in the photo —
  that rule was correct all along. It is the *poster layer* that carries text, composited
  deterministically, not the diffusion render.
