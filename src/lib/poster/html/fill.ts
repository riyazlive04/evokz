/**
 * How client copy reaches the page — and why none of it is ever escaped.
 *
 * The obvious way to put a headline into an HTML template is to substitute it
 * into the markup, which makes escaping load-bearing: copy arrives from an
 * operator-edited spreadsheet, so a caption holding `<`, `&`, a quote or a
 * stray `</style>` is not hypothetical. Satori never had this problem because it
 * took React nodes and escaped by construction, and losing that guarantee would
 * have been a real regression.
 *
 * So the substitution does not go through markup at all. `renderHtmlPoster`
 * calls `page.evaluate(fillPoster, model)`: Playwright serialises the model over
 * CDP as a structured clone, and this function — running inside the page —
 * assigns each string with `textContent`, which stores characters rather than
 * parsing them. There is no HTML parser anywhere on the path from the sheet to
 * the pixels, so there is nothing to escape and nothing to get wrong. A headline
 * of `<script>alert(1)</script>` renders as those twenty-eight characters, set in
 * the headline face, because that is what the client typed.
 *
 * The two values that are not text are images, and both are data URIs this
 * process built out of Buffers it already held — never anything a client typed.
 *
 * This file is bundled to the browser as source: `page.evaluate` stringifies the
 * function, so it must not close over anything outside itself, must not import
 * at runtime, and cannot use TypeScript-only constructs that leave residue. Keep
 * it self-contained. The types are erased and are here for the caller's benefit.
 */

/** One entry of a `data-repeat` array. */
export interface HtmlRepeatItem {
  /** `data-slot` name → textContent, resolved inside this clone. */
  text: Record<string, string>;
  /**
   * `data-*` attributes set on the clone's root element, for CSS to hook.
   *
   * How per-item styling is expressed without giving templates any logic: the
   * accent headline line is `{ accent: 'true' }` here and `[data-accent]` in the
   * stylesheet. Which line is accented stays a decision in TypeScript, and what
   * being accented looks like stays a decision in CSS.
   */
  mark?: Record<string, string>;
  /** `data-image` name → data URI, resolved inside this clone. */
  images?: Record<string, string>;
}

export interface HtmlPosterModel {
  text: Record<string, string>;
  /** Data URIs. Null means the frame was not supplied and its element is removed. */
  images: Record<string, string | null>;
  repeats: Record<string, HtmlRepeatItem[]>;
  /** `data-when` conditions. An unlisted name reads as false. */
  present: Record<string, boolean>;
}

/**
 * Writes the model into the document. Runs inside the page.
 *
 * Returns a report rather than nothing so the caller can fail loudly on a
 * template whose markup and model have drifted apart — a `data-slot` the model
 * has no value for is almost always a renamed slot, and silently rendering the
 * poster with a hole in it is how that reaches a client.
 */
export function fillPoster(model: HtmlPosterModel): {
  filled: string[];
  dropped: string[];
  unknown: string[];
} {
  const filled: string[] = [];
  const dropped: string[] = [];
  const unknown: string[] = [];

  const setText = (
    element: Element,
    name: string,
    source: Record<string, string>,
  ): void => {
    // The attribute is removed either way, so the document-wide pass below
    // cannot revisit a slot that a repeat clone has already resolved. What it
    // is replaced by matters: `auditLayout` needs to know which elements are
    // carrying client content, because those are the ones whose clipping or
    // collision would reach a client.
    element.removeAttribute('data-slot');

    const value = Object.prototype.hasOwnProperty.call(source, name)
      ? source[name]
      : undefined;

    if (value === undefined) {
      unknown.push(name);
      element.remove();
      return;
    }
    if (value === '') {
      // Empty collapses the element rather than holding an empty box open. An
      // unset eyebrow and a client with no website both arrive this way.
      dropped.push(name);
      element.remove();
      return;
    }

    element.textContent = value;
    element.setAttribute('data-filled', name);
    filled.push(name);
  };

  const setImage = (
    element: Element,
    name: string,
    source: Record<string, string | null | undefined>,
  ): void => {
    element.removeAttribute('data-image');
    const value = source[name];

    if (!value) {
      dropped.push(name);
      element.remove();
      return;
    }

    if (element instanceof HTMLImageElement) {
      element.src = value;
    } else if (element instanceof SVGImageElement) {
      // SVG <image> takes href, not src, and the reflected property is on the
      // SVGAnimatedString — setting `.src` on it does nothing at all and leaves
      // a blank hole where the photograph should be.
      element.setAttribute('href', value);
    } else {
      (element as HTMLElement).style.backgroundImage = `url("${value}")`;
    }
    element.setAttribute('data-filled', name);
    filled.push(name);
  };

  // --- conditions -----------------------------------------------------------
  // First, so a removed branch costs no further work and cannot contribute a
  // spurious "unknown slot" from markup that was never going to be drawn.
  document.querySelectorAll('[data-when]').forEach((element) => {
    const name = element.getAttribute('data-when') ?? '';
    if (model.present[name] !== true) {
      dropped.push(name);
      element.remove();
    } else {
      element.removeAttribute('data-when');
    }
  });

  // --- repeats --------------------------------------------------------------
  document.querySelectorAll('template[data-repeat]').forEach((node) => {
    const holder = node as HTMLTemplateElement;
    const name = holder.getAttribute('data-repeat') ?? '';
    const items = model.repeats[name] ?? [];

    items.forEach((item) => {
      const clone = holder.content.cloneNode(true) as DocumentFragment;
      const root = clone.firstElementChild;

      if (root && item.mark) {
        Object.keys(item.mark).forEach((key) => {
          root.setAttribute(`data-${key}`, item.mark![key]!);
        });
      }

      clone.querySelectorAll('[data-slot]').forEach((element) => {
        setText(element, element.getAttribute('data-slot') ?? '', item.text);
      });
      clone.querySelectorAll('[data-image]').forEach((element) => {
        setImage(element, element.getAttribute('data-image') ?? '', item.images ?? {});
      });

      holder.parentNode?.insertBefore(clone, holder);
    });

    holder.remove();
  });

  // --- everything else ------------------------------------------------------
  document.querySelectorAll('[data-slot]').forEach((element) => {
    setText(element, element.getAttribute('data-slot') ?? '', model.text);
  });
  document.querySelectorAll('[data-image]').forEach((element) => {
    setImage(element, element.getAttribute('data-image') ?? '', model.images);
  });

  // The manifest is the pipeline's, not the page's. Removing it keeps it out of
  // any future screenshot of the DOM and out of the way of the lint's rule that
  // a template carries no script.
  document.getElementById('poster-manifest')?.remove();

  return { filled, dropped, unknown };
}

/**
 * Shrinks any `[data-fit]` block until its contents stop overflowing it.
 *
 * The defect this exists for is the whole reason the renderer is being replaced:
 * long copy that clips or overlaps. The old renderer answered it with
 * `headlineSize`, which took a *line count* and looked up a size — so three
 * short words and three long ones got the same type, and one of them ran off
 * the canvas.
 *
 * This measures instead of guessing, which is the only thing a browser can do
 * that satori could not: `scrollWidth` is the real laid-out width in the real
 * face at the real size. Steps down 3% at a time rather than binary-searching
 * because the search space is twenty-odd steps wide and each iteration is a
 * layout on a page that is doing nothing else.
 *
 * **Must run after `document.fonts.ready`.** Measured against the fallback face,
 * every answer is wrong — usually wrong in the direction of not shrinking at
 * all, which is silent.
 *
 * Returns what it did so the caller can log a headline that needed shrinking:
 * that is worth an operator knowing, because the fix is usually to write shorter
 * copy rather than to accept smaller type.
 */
export function fitText(): Array<{ from: number; to: number; wrapped: boolean }> {
  const MIN_RATIO = 0.5;
  const STEP = 0.97;
  const MAX_STEPS = 34;
  const adjusted: Array<{ from: number; to: number; wrapped: boolean }> = [];

  document.querySelectorAll('[data-fit]').forEach((node) => {
    const element = node as HTMLElement;
    const start = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!Number.isFinite(start) || start <= 0) return;

    /*
     * Width by default; both axes only when the template opts in.
     *
     * The vertical test was in the first version unconditionally and silently
     * ruined the phone lockup: a block set with `line-height: 1` has a content
     * box of exactly 1em while the face's own line box is nearer 1.19em, so
     * `scrollHeight` exceeds `clientHeight` on a perfectly well-fitting single
     * line — and because both scale with the font size, shrinking never resolves
     * it. The number was driven from 88px down to 57px to satisfy a constraint
     * that did not exist.
     *
     * `data-fit="block"` is the opt-in for the case that is real: an element
     * with a *definite* height — one the flex algorithm or an absolute position
     * has settled, not one its own content decided — whose copy must be made to
     * fit it. Two templates need it, and both had four features of maximum
     * length running off the bottom of the poster before they got it.
     *
     * A template using it owes two things: a definite height, and type sized in
     * `em` so the whole block scales together. Fixed pixel children do not
     * shrink, so an icon beside shrinking type just stops fitting differently.
     */
    const fitsBothAxes = element.getAttribute('data-fit') === 'block';
    const overflows = (): boolean =>
      element.scrollWidth > element.clientWidth + 1 ||
      (fitsBothAxes && element.scrollHeight > element.clientHeight + 1);

    let size = start;
    let wrapped = false;

    const shrink = (): void => {
      let steps = 0;
      while (overflows() && steps < MAX_STEPS && size > start * MIN_RATIO) {
        size *= STEP;
        element.style.fontSize = `${size}px`;
        steps += 1;
      }
    };

    shrink();

    /*
     * The floor is not the end of the story, and getting that wrong is how the
     * first version of this shipped a clipped headline.
     *
     * Shrinking alone cannot answer arbitrary copy: a 38-character line needs to
     * be less than half size before it fits a 824px column, and type that small
     * stops being a headline. So once the floor is reached the block is allowed
     * to wrap — the copywriter's chosen line breaks are preferred, not sacred,
     * and a wrapped headline is a worse design than a short one but an
     * incomparably better outcome than a clipped one. `anywhere` covers the last
     * case wrapping cannot: a single unbreakable word wider than the column.
     */
    if (overflows() && !fitsBothAxes) {
      element.style.whiteSpace = 'normal';
      element.style.overflowWrap = 'anywhere';
      wrapped = true;
      shrink();
    }

    if (size !== start || wrapped) adjusted.push({ from: start, to: size, wrapped });
  });

  return adjusted;
}

/** One thing wrong with a laid-out poster. */
export interface LayoutProblem {
  kind: 'hidden' | 'clipped' | 'overflow' | 'collision';
  detail: string;
}

/**
 * Inspects a laid-out poster for the faults a person would call "broken".
 *
 * The requirement this answers is that a poster must never ship with something
 * cut off, sitting on top of something else, or missing because it was drawn at
 * no size. Those are exactly the faults that survive every other check: the
 * template renders, re-renders byte-identically, passes its lint, and is still
 * wrong — and they only appear for *some* copy, so looking at one render proves
 * nothing.
 *
 * It reads `data-filled`, which `fillPoster` stamps on everything carrying
 * client content. Template chrome is deliberately out of scope: a scrim over a
 * photograph and a figure behind a card are overlaps the design intends, and
 * flagging them would bury the real faults in noise.
 *
 * **Collisions are tested between text blocks only.** A photograph under a
 * headline is the commonest arrangement in this library, so comparing every
 * filled element against every other would report the design working as
 * designed. Text on text is unambiguous — there is no composition in which two
 * blocks of words are meant to sit on each other.
 *
 * Must run after `document.fonts.ready` and after `fitText`, or it measures type
 * that is about to change size.
 */
export function auditLayout(): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  const stage = document.getElementById('poster-stage');
  if (!stage) return [{ kind: 'hidden', detail: 'the poster stage is missing' }];

  const bounds = stage.getBoundingClientRect();
  /** Sub-pixel rounding at the stage edge is not a clipped element. */
  const EDGE = 2;
  /** Two blocks must share this much on both axes before it is a collision. */
  const TOUCH = 4;

  const filled = Array.from(document.querySelectorAll('[data-filled]')) as HTMLElement[];
  const named = (element: HTMLElement): string =>
    element.getAttribute('data-filled') ?? 'unnamed';

  const boxes = filled.map((element) => ({
    element,
    rect: element.getBoundingClientRect(),
    style: getComputedStyle(element),
  }));

  for (const { element, rect, style } of boxes) {
    // --- drawn at all? ---
    if (rect.width < 1 || rect.height < 1) {
      problems.push({
        kind: 'hidden',
        detail: `"${named(element)}" was given content but laid out at ${Math.round(
          rect.width,
        )}x${Math.round(rect.height)}`,
      });
      continue;
    }
    if (style.visibility === 'hidden' || Number.parseFloat(style.opacity) < 0.05) {
      problems.push({ kind: 'hidden', detail: `"${named(element)}" is not visible` });
      continue;
    }

    /*
     * --- inside the poster? ---
     *
     * Words and pictures are judged differently, because bleeding off the edge
     * is a mistake for one and a technique for the other. A headline reaching
     * past the margin has been cut in half. A photograph reaching past it has
     * been bled, which several of these designs do deliberately — Med-SM-1
     * hangs its figure 20px over the right edge so the cut-out does not look
     * pasted onto a margin.
     *
     * So text may not leave the stage at all, and an image may, until more than
     * a third of it is outside — past which it is not a bleed, it is a frame in
     * the wrong place.
     */
    const carriesText = (element.textContent ?? '').trim().length > 0;
    const outside =
      Math.max(0, bounds.left - rect.left) +
      Math.max(0, rect.right - bounds.right) +
      Math.max(0, bounds.top - rect.top) +
      Math.max(0, rect.bottom - bounds.bottom);
    const clipped = carriesText
      ? outside > EDGE
      : outside > EDGE && outside > (rect.width + rect.height) / 3;

    if (clipped) {
      problems.push({
        kind: 'clipped',
        detail:
          `"${named(element)}" reaches outside the poster — ` +
          `${Math.round(rect.left - bounds.left)},${Math.round(rect.top - bounds.top)} to ` +
          `${Math.round(rect.right - bounds.left)},${Math.round(rect.bottom - bounds.top)} ` +
          `of ${Math.round(bounds.width)}x${Math.round(bounds.height)}`,
      });
    }

    // --- inside its own box? ---
    // After `fitText` a block that still overflows has run out of room to give,
    // which means the copy is longer than the design can hold at any size.
    if (element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0) {
      problems.push({
        kind: 'overflow',
        detail: `"${named(element)}" needs ${element.scrollWidth}px in a ${element.clientWidth}px box`,
      });
    }
  }

  // --- words on words ---
  const text = boxes.filter(
    ({ element, rect }) =>
      (element.textContent ?? '').trim().length > 0 && rect.width >= 1 && rect.height >= 1,
  );

  for (let i = 0; i < text.length; i += 1) {
    for (let j = i + 1; j < text.length; j += 1) {
      const a = text[i]!;
      const b = text[j]!;
      // Nesting is containment, not collision — a slot inside a slot is a
      // structure this format does not produce, but guarding costs nothing.
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;

      const shared = {
        x: Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left),
        y: Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top),
      };
      if (shared.x > TOUCH && shared.y > TOUCH) {
        problems.push({
          kind: 'collision',
          detail:
            `"${named(a.element)}" and "${named(b.element)}" overlap by ` +
            `${Math.round(shared.x)}x${Math.round(shared.y)}px`,
        });
      }
    }
  }

  return problems;
}
