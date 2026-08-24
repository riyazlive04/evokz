/**
 * Per-vertical photographic vocabulary for the background-photo brief.
 *
 * One construction shot list used to go to every client, so a dental clinic was
 * briefed as a building site and the model dutifully produced tower cranes. The
 * lists are deliberately concrete nouns rather than adjectives: image models
 * follow "espresso pour with steam" reliably and "appropriate to the industry"
 * not at all.
 *
 * Owned here rather than in the database because it is prompt engineering, not
 * client data — it changes when the prompt is tuned, not when a client signs up.
 */

interface VerticalImagery {
  /** 5-7 concrete photographic subjects, comma separated, no trailing stop. */
  subjects: string;
  /** How the scene is lit, plus any motif worth repeating across the campaign. */
  lighting: string;
}

/**
 * Category names are free text typed into the admin UI, so the same vertical
 * arrives as "Healthcare & Dental Clinics", "healthcare and dental clinics" or
 * HTML-escaped "Healthcare &amp; Dental Clinics". Folding the entity, the
 * ampersand and the spelled-out connector onto one key makes all three resolve
 * instead of silently dropping to the fallback.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
    .replace(/and/g, '');
}

/** Used for any vertical not listed below. Never industry-specific, never wrong. */
const FALLBACK: VerticalImagery = {
  subjects:
    'the product or service in use, a practitioner at work, the premises shot wide, a close detail of the tools or materials of the trade, a customer mid-interaction, a clean flat-lay of the things the business handles',
  lighting:
    'clean natural daylight with soft directional shadow. Keep the treatment neutral and professional — no theatrical colour, no manufactured drama',
};

/**
 * Distinctive fragments that map an operator-typed vertical onto a vocabulary.
 *
 * The lookup used to be an exact match on `normalize()` output, and the keys were
 * written against the content library's canonical names — "Heavy Construction",
 * "Healthcare & Dental Clinics", "Interior Design". Nobody types those. The
 * admin UI's category field is free text, and what production actually holds is
 * "Contructions" (sic), "Medicals", "Interiors" and "Automation and Software" —
 * so five of seven verticals silently fell through to FALLBACK and every client
 * in them was briefed with generic imagery. That is exactly the defect this
 * module was written to fix, surviving in the lookup rather than the data.
 *
 * Fragment matching rather than more exact keys, because the failure mode is
 * unbounded: singular/plural, a dropped ampersand, a typo. `contruction` is
 * listed because it is what is actually in the database — a real name beats a
 * correct one.
 *
 * Order matters: the first fragment found in the normalised name wins, so put
 * anything ambiguous after the term that should beat it.
 */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['contruction', 'heavyconstruction'],
  ['construction', 'heavyconstruction'],
  ['builder', 'heavyconstruction'],
  ['infrastructure', 'heavyconstruction'],
  ['civil', 'heavyconstruction'],

  ['interior', 'interiordesign'],
  ['architect', 'interiordesign'],
  ['furnish', 'interiordesign'],

  ['realestate', 'realestate'],
  ['property', 'realestate'],
  ['builders', 'realestate'],

  ['medical', 'healthcaredentalclinics'],
  ['health', 'healthcaredentalclinics'],
  ['dental', 'healthcaredentalclinics'],
  ['dentist', 'healthcaredentalclinics'],
  ['clinic', 'healthcaredentalclinics'],
  ['hospital', 'healthcaredentalclinics'],
  ['pharma', 'healthcaredentalclinics'],

  ['fitness', 'fitnessgyms'],
  ['gym', 'fitnessgyms'],
  ['yoga', 'fitnessgyms'],

  ['restaurant', 'restaurantscafes'],
  ['cafe', 'restaurantscafes'],
  ['coffee', 'restaurantscafes'],
  ['bakery', 'restaurantscafes'],
  ['catering', 'restaurantscafes'],
  ['food', 'restaurantscafes'],

  ['education', 'educationcoaching'],
  ['coaching', 'educationcoaching'],
  ['school', 'educationcoaching'],
  ['tuition', 'educationcoaching'],
  ['academy', 'educationcoaching'],
  ['training', 'educationcoaching'],

  ['beauty', 'beautysalon'],
  ['salon', 'beautysalon'],
  ['spa', 'beautysalon'],
  ['cosmetic', 'beautysalon'],

  ['automotive', 'automotivesalesservice'],
  ['automobile', 'automotivesalesservice'],
  ['garage', 'automotivesalesservice'],
  ['motors', 'automotivesalesservice'],

  ['legal', 'legalfinancialservices'],
  ['lawyer', 'legalfinancialservices'],
  ['advocate', 'legalfinancialservices'],
  ['financial', 'legalfinancialservices'],
  ['finance', 'legalfinancialservices'],
  ['account', 'legalfinancialservices'],
  ['insurance', 'legalfinancialservices'],

  // After `automotive`, so "automation" cannot be swallowed by it.
  ['software', 'softwareautomation'],
  ['automation', 'softwareautomation'],
  ['technology', 'softwareautomation'],
  ['saas', 'softwareautomation'],
];

/** Keys are `normalize()` output; the comment carries the display name. */
const VERTICAL_IMAGERY: Record<string, VerticalImagery> = {
  // Heavy Construction
  heavyconstruction: {
    subjects:
      'mid-rise or high-rise under construction, tower crane against sky, workers in hi-vis and hard hats silhouetted at golden hour, modern flat-roof villa with warm interior glow at dusk, glass commercial block, blueprints with hard hat and drafting tools, architectural wireframe render',
    lighting:
      'golden hour or blue-hour dusk for warm palettes, bright midday for cool and high-key ones. Warm interior window glow is a recurring motif in residential shots',
  },
  // Interior Design
  interiordesign: {
    subjects:
      'styled living room with layered textiles, a single sculptural armchair against a plastered wall, open-plan kitchen in stone and pale oak, staircase rising through a double-height void, flat-lay of fabric swatches and timber samples, close detail of joinery and brass hardware, an empty room mid-styling with light raking across the floor',
    lighting:
      'soft diffused daylight through sheer curtains for airy palettes, warm lamplight and pooled shadow for darker evening ones. Long shadows thrown across a floor or wall are a recurring motif',
  },
  // Real Estate
  realestate: {
    subjects:
      'villa facade at dusk with lit windows, apartment balcony overlooking a skyline, keys resting on the counter of a finished kitchen, aerial of a gated community, hallway leading to an open door, landscaped garden and pool at twilight, high-floor window framing a city view',
    lighting:
      'blue-hour dusk with the interior lights on for aspirational shots, clean midday sun for exteriors and aerials. Warm window glow reading as lived-in is a recurring motif',
  },
  // Healthcare & Dental Clinics
  healthcaredentalclinics: {
    subjects:
      'bright treatment room with a modern chair, gloved hands and sterile instruments in shallow focus, clinician in scrubs talking with a seated patient, uncluttered reception desk with plants, close portrait of a confident smile, dental model or scan on a lit worktop, corridor of frosted glass and pale wood',
    lighting:
      'bright, even, high-key daylight with no harsh shadows and no cold surgical green. Soft window light on faces keeps the scene reassuring rather than sterile',
  },
  // Fitness & Gyms
  fitnessgyms: {
    subjects:
      'athlete mid-lift under rack lighting, rows of dumbbells receding into shadow, kettlebells and chalk on a rubber floor, group class in motion in a mirrored studio, runner silhouetted against a tall window, boxing gloves hanging on the ropes, tight crop of a sweat-lit shoulder',
    lighting:
      'hard directional light and deep shadow for intensity, bright daylight through tall windows for morning and wellness angles. Rim light separating the body from a dark background is a recurring motif',
  },
  // Restaurants & Cafes
  restaurantscafes: {
    subjects:
      'overhead plated dish on worn wood, espresso pour with steam rising, chef plating at the pass, warm dining room with filled tables falling out of focus, latte art in a ceramic cup beside a window, wood-fired oven glow, raw ingredients laid out on marble',
    lighting:
      'warm tungsten interior light with window side-light on the food, dropping to low candlelit ambience for evening dining. Steam and shallow depth of field are recurring motifs',
  },
  // Software & Automation
  softwareautomation: {
    subjects:
      'a laptop open on a desk showing an abstract dashboard with no legible text, a developer at a two-screen workstation seen over the shoulder, a small team around a whiteboard mid-discussion, server or network hardware shot close and clean, hands on a keyboard in shallow focus, a modern office corner with plants and glass',
    lighting:
      'cool daylight from a large window with soft blue screen glow on faces, clean and uncluttered. Shallow depth of field and negative space are recurring motifs',
  },

  // Education & Coaching
  educationcoaching: {
    subjects:
      'student at a desk with books and a laptop, tutor mid-explanation at a whiteboard, small group in discussion around a table, library shelves under warm reading lamps, close crop of a notebook and pen, campus corridor with light through tall windows, hands raised in a bright classroom',
    lighting:
      'clean natural daylight through large windows, warm desk lamps for late-study and focus angles. Keep the exposure bright and optimistic — no gloom',
  },
  // Beauty & Salon
  beautysalon: {
    subjects:
      'stylist mid-cut framed behind a client in the mirror, blow-dry caught in motion, salon chairs and backlit mirrors in a row, close crop of finished hair or nails, skincare products on a marble ledge, brushes and palettes laid out, client reclined at a wash basin',
    lighting:
      'soft, flattering, slightly warm light with gentle falloff across skin; backlit mirror bulbs and window light for glamour. Never let a hard shadow cut across a face',
  },
  // Automotive Sales & Service
  automotivesalesservice: {
    subjects:
      'car on a showroom floor with reflections underfoot, low-light detail of a wheel or headlight, technician working at a lift bay, keys handed over beside an open bonnet, specular highlight running the length of polished paintwork, engine bay under a work lamp, car on an open road at dusk',
    lighting:
      'controlled showroom lighting with long specular highlights along the bodywork, blue hour and wet-tarmac reflections for road shots. Workshop scenes take warm practical lamps',
  },
  // Legal & Financial Services
  legalfinancialservices: {
    subjects:
      'advisor and client mid-conversation across a desk, signed documents beside a fountain pen, glass office tower shot from below, boardroom table lit from tall windows, handshake in a lobby, law-library shelves in shallow focus, laptop showing charts on a clear desk',
    lighting:
      'cool, even daylight through large windows for corporate authority, a warm desk lamp for consultation scenes. Keep contrast restrained — assurance, not drama',
  },
};

/**
 * The two industry-specific lines of the image brief, as prose bullets ready to
 * drop into the rules list.
 *
 * Never throws and never returns empty: an unknown or missing category still has
 * to produce a usable photo brief, so it falls back to neutral professional
 * imagery rather than failing the generation.
 */
export function describeVerticalImagery(
  categoryName: string | null | undefined,
): string {
  const imagery = verticalImageryFor(categoryName);

  return [
    `- Subject vocabulary for this vertical: ${imagery.subjects}.`,
    `- Lighting: ${imagery.lighting}.`,
  ].join('\n');
}

/**
 * The raw imagery entry for a vertical, for callers that compose their own
 * sentence rather than the prompt's bullet pair.
 *
 * The downloadable import template uses it to write a worked image-prompt
 * example in the operator's own industry. Same reason the lists exist at all: a
 * café told to photograph a tower crane is the failure this module was written
 * to stop, and a sample sheet full of construction copy is that failure wearing
 * a different hat.
 */
export function verticalImageryFor(categoryName: string | null | undefined): VerticalImagery {
  if (!categoryName) return FALLBACK;

  const key = normalize(categoryName);
  const exact = VERTICAL_IMAGERY[key];
  if (exact) return exact;

  for (const [fragment, target] of ALIASES) {
    if (key.includes(fragment)) {
      const matched = VERTICAL_IMAGERY[target];
      if (matched) return matched;
    }
  }

  return FALLBACK;
}

/**
 * True when a vertical has no vocabulary of its own and will be briefed
 * generically. Surfaced so a check can report it rather than it going unnoticed
 * for five verticals at a time, which is how this module's own bug survived.
 */
export function usesFallbackImagery(categoryName: string | null | undefined): boolean {
  return verticalImageryFor(categoryName) === FALLBACK;
}
