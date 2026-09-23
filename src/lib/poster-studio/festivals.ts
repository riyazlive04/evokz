/**
 * Festivals and observances a Poster Studio image can be themed for.
 *
 * A built-in list, not a table: the set changes rarely, and each entry is
 * mostly prompt wording. No dates — most Indian festivals follow the lunar
 * calendar and move every year, so a date here would be wrong more often than
 * right. The operator picks the festival; the prompt adds its treatment
 * (`festivalSection` in src/lib/ai/studio-prompts.ts).
 *
 * `greeting` is the only wording the model may add for a festival, and only
 * when the poster is not text-free. `styleHint` describes decor and palette,
 * never a brand, a logo or a religious figure's likeness.
 *
 * Client-safe: imported by the workspace.
 */

export interface StudioFestival {
  key: string;
  label: string;
  greeting: string;
  styleHint: string;
}

export const STUDIO_FESTIVALS = [
  { key: 'new-year', label: 'New Year', greeting: 'Happy New Year', styleHint: 'celebratory night-sky glow, confetti, sparklers and gold and midnight-blue accents' },
  { key: 'pongal', label: 'Pongal', greeting: 'Happy Pongal', styleHint: 'a clay pot overflowing with sweet pongal, sugarcane stalks, kolam patterns, turmeric plants and warm harvest-sun yellows and greens' },
  { key: 'makar-sankranti', label: 'Makar Sankranti', greeting: 'Happy Makar Sankranti', styleHint: 'colourful kites against a bright sky, til-gud sweets and fresh harvest tones' },
  { key: 'republic-day', label: 'Republic Day', greeting: 'Happy Republic Day', styleHint: 'the tricolour palette of saffron, white and green with a navy chakra accent, flags and a proud, respectful mood' },
  { key: 'valentines-day', label: "Valentine's Day", greeting: "Happy Valentine's Day", styleHint: 'soft hearts, roses and warm red and blush-pink accents' },
  { key: 'maha-shivaratri', label: 'Maha Shivaratri', greeting: 'Happy Maha Shivaratri', styleHint: 'a serene night mood with deep blues, oil lamps, bilva leaves and a crescent moon' },
  { key: 'womens-day', label: "Women's Day", greeting: "Happy Women's Day", styleHint: 'empowering, graceful imagery with purple and soft pink accents and floral touches' },
  { key: 'holi', label: 'Holi', greeting: 'Happy Holi', styleHint: 'bursts of vibrant gulal powder in pink, yellow, green and blue, water splashes and a joyful mood' },
  { key: 'ugadi', label: 'Ugadi / Gudi Padwa', greeting: 'Happy Ugadi', styleHint: 'mango-leaf torans, neem flowers, a raised gudi, rangoli and fresh spring greens and yellows' },
  { key: 'eid-al-fitr', label: 'Eid al-Fitr', greeting: 'Eid Mubarak', styleHint: 'a crescent moon and stars, glowing lanterns, arabesque patterns and emerald and gold accents' },
  { key: 'vishu', label: 'Vishu', greeting: 'Happy Vishu', styleHint: 'golden konna (cassia) flowers, a Vishu kani arrangement of fruit, rice and a brass lamp' },
  { key: 'tamil-new-year', label: 'Tamil New Year (Puthandu)', greeting: 'Happy Tamil New Year', styleHint: 'kolam, mango leaves, a brass lamp and a tray of fruit and flowers in warm festive tones' },
  { key: 'good-friday-easter', label: 'Good Friday / Easter', greeting: 'Happy Easter', styleHint: 'spring flowers, pastel eggs and soft morning light in a gentle, hopeful mood' },
  { key: 'mothers-day', label: "Mother's Day", greeting: "Happy Mother's Day", styleHint: 'tender, warm imagery with flowers and soft pastel accents' },
  { key: 'doctors-day', label: "Doctors' Day", greeting: "Happy Doctors' Day", styleHint: 'a respectful, grateful tone with a stethoscope motif, clean whites and calm medical blues' },
  { key: 'fathers-day', label: "Father's Day", greeting: "Happy Father's Day", styleHint: 'warm, strong imagery with classic navy and warm neutral accents' },
  { key: 'eid-al-adha', label: 'Eid al-Adha (Bakrid)', greeting: 'Eid Mubarak', styleHint: 'a crescent moon, lanterns, geometric patterns and rich green and gold accents' },
  { key: 'independence-day', label: 'Independence Day', greeting: 'Happy Independence Day', styleHint: 'the tricolour palette of saffron, white and green with a navy chakra accent, flags, kites and a proud mood' },
  { key: 'raksha-bandhan', label: 'Raksha Bandhan', greeting: 'Happy Raksha Bandhan', styleHint: 'a decorative rakhi, a puja thali with sweets and warm red, gold and orange accents' },
  { key: 'onam', label: 'Onam', greeting: 'Happy Onam', styleHint: 'a flower pookalam carpet, a traditional sadya on a banana leaf, kasavu cream-and-gold tones and a snake-boat motif' },
  { key: 'janmashtami', label: 'Krishna Janmashtami', greeting: 'Happy Janmashtami', styleHint: 'a peacock feather, a flute, a pot of butter (makhan) and deep blue and gold accents' },
  { key: 'ganesh-chaturthi', label: 'Ganesh Chaturthi', greeting: 'Happy Ganesh Chaturthi', styleHint: 'marigold garlands, modak sweets, a festive mandap and warm orange, red and gold tones' },
  { key: 'teachers-day', label: "Teachers' Day", greeting: "Happy Teachers' Day", styleHint: 'books, a chalkboard, an apple and warm, grateful academic tones' },
  { key: 'navratri', label: 'Navratri / Durga Puja', greeting: 'Happy Navratri', styleHint: 'dandiya sticks, garba colour, marigolds, oil lamps and vivid red, yellow and green accents' },
  { key: 'dussehra', label: 'Dussehra', greeting: 'Happy Dussehra', styleHint: 'a victorious mood with a bow and arrow motif, fireworks, marigolds and warm saffron and gold' },
  { key: 'karva-chauth', label: 'Karva Chauth', greeting: 'Happy Karva Chauth', styleHint: 'a decorated sieve, a moon in the night sky, a thali with lamps and deep red and gold accents' },
  { key: 'diwali', label: 'Diwali / Deepavali', greeting: 'Happy Diwali', styleHint: 'glowing clay diyas, rangoli, marigold garlands, soft firework bokeh and rich gold, maroon and warm amber light' },
  { key: 'bhai-dooj', label: 'Bhai Dooj', greeting: 'Happy Bhai Dooj', styleHint: 'a puja thali with a diya, tilak, sweets and warm festive tones' },
  { key: 'chhath-puja', label: 'Chhath Puja', greeting: 'Happy Chhath Puja', styleHint: 'a sunrise over water, bamboo baskets of offerings and warm golden-orange light' },
  { key: 'guru-nanak-jayanti', label: 'Guru Nanak Jayanti', greeting: 'Happy Gurpurab', styleHint: 'glowing lamps, soft saffron and blue tones and a serene, devotional mood — no depiction of the Guru' },
  { key: 'childrens-day', label: "Children's Day", greeting: "Happy Children's Day", styleHint: 'playful balloons, bright primary colours and joyful, innocent imagery' },
  { key: 'christmas', label: 'Christmas', greeting: 'Merry Christmas', styleHint: 'a decorated tree, fairy lights, stars, gift boxes and red, green and gold accents' },
] as const satisfies readonly StudioFestival[];

export type StudioFestivalKey = (typeof STUDIO_FESTIVALS)[number]['key'];

export const STUDIO_FESTIVAL_KEYS = STUDIO_FESTIVALS.map((festival) => festival.key) as StudioFestivalKey[];

/** The festival for a stored or submitted key; null for no festival or an unknown key. */
export function findStudioFestival(key: string | null | undefined): StudioFestival | null {
  if (!key) return null;
  return STUDIO_FESTIVALS.find((festival) => festival.key === key) ?? null;
}
